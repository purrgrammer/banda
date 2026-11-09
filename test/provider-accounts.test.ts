/**
 * Provider accounts: a backend's second sign-in or key is a clone of its pi-ai provider under `<backend>@<account>`.
 * Its credential is its own, an ambient one never counts as its, its tiers are its backend's presets, a run on it is
 * counted under its id. The app's side is `provider-account-routes.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type ConversationId, createRegistry, type TaskId, UsageDoc } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountProvider, registerAccount } from "../src/core/account-provider.ts";
import { defineTierSwitch } from "../src/core/agents.ts";
import { setModels } from "../src/core/companion.ts";
import { OWNER } from "../src/core/gateway.ts";
import { accountSlug, backendOf, formatAccount, parseAccount } from "../src/core/provider-accounts.ts";
import { FileCredentialStore, ProvidersFile } from "../src/core/provider-credentials.ts";
import { context, openStore } from "../src/core/store.ts";
import { modelFor, presetOf, TIERS } from "../src/core/tiers.ts";
import { defineCore, type TurnResult } from "../src/core/turn.ts";
import { blobStore, FakeGateway, tempHome } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const ANTHROPIC = presetOf("anthropic")!;
const WORK = "anthropic@work";

const AMBIENT = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
	saved = Object.fromEntries(AMBIENT.map((name) => [name, process.env[name]]));
	for (const name of AMBIENT) delete process.env[name];
});
afterEach(() => {
	for (const [name, value] of Object.entries(saved))
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
});

const keyOf = async (models: MutableModels, id: string) =>
	(await models.getAuth(id).catch(() => undefined))?.auth.apiKey;

describe("an account's id", () => {
	it("formats and parses back, its backend's id plain for the first account", () => {
		expect(parseAccount("anthropic")).toEqual({ provider: "anthropic" });
		expect(parseAccount(WORK)).toEqual({ provider: "anthropic", account: "work" });
		expect(backendOf(WORK)).toBe("anthropic");
		const provider = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);
		const account = fc.option(fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/), { nil: undefined });
		fc.assert(
			fc.property(provider, account, (p, a) => {
				const ref = a === undefined ? { provider: p } : { provider: p, account: a };
				expect(parseAccount(formatAccount(ref))).toEqual(ref);
			}),
			{ numRuns: pbtRuns(100) },
		);
	});

	it("is a slug of the label, unique among the backend's", () => {
		expect(accountSlug("Work", new Set())).toBe("work");
		expect(accountSlug("Work", new Set(["work"]))).toBe("work-2");
		expect(accountSlug("Côte d'Azur!", new Set())).toBe("cote-d-azur");
		expect(accountSlug("✨", new Set())).toBe("account");
		fc.assert(
			fc.property(fc.array(fc.string(), { maxLength: 8 }), (labels) => {
				const taken = new Set<string>();
				for (const label of labels) {
					const slug = accountSlug(label, taken);
					expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
					expect(taken.has(slug)).toBe(false);
					taken.add(slug);
				}
			}),
			{ numRuns: pbtRuns(100) },
		);
	});
});

describe("an account of a backend", () => {
	it("holds its own credential, apart from the backend's first account", async () => {
		const credentials = new FileCredentialStore(await tempHome());
		const models = builtinModels({ credentials });
		expect(registerAccount(models, WORK)).toBe(true);
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-personal" }));
		await credentials.modify(WORK, async () => ({ type: "api_key", key: "sk-work" }));
		expect(await keyOf(models, "anthropic")).toBe("sk-personal");
		expect(await keyOf(models, WORK)).toBe("sk-work");
		expect((await models.checkAuth(WORK))?.source).toBe("stored credential");
		const model = models.getModel(WORK, ANTHROPIC.models.quick);
		expect(model?.provider).toBe(WORK);
		expect((await models.getAuth(model!))?.auth.apiKey).toBe("sk-work");
		expect((await models.getAvailable(WORK)).every((each) => each.provider === WORK)).toBe(true);
		// a backend banda does not know has no accounts
		expect(registerAccount(models, "nowhere@work")).toBe(false);
	});

	it("never counts a credential from around the daemon as its own", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-from-the-environment";
		const credentials = new FileCredentialStore(await tempHome());
		const models = builtinModels({ credentials });
		registerAccount(models, WORK);
		expect(await keyOf(models, "anthropic")).toBe("sk-from-the-environment");
		expect(await models.checkAuth(WORK)).toBeUndefined();
		expect(await models.getAuth(WORK)).toBeUndefined();
		expect(await models.getAvailable(WORK)).toEqual([]);
		await credentials.modify(WORK, async () => ({ type: "api_key", key: "sk-work" }));
		expect(await keyOf(models, WORK)).toBe("sk-work");
	});

	it("thinks on its backend's presets, under its own id", () => {
		expect(presetOf(WORK)).toBe(ANTHROPIC);
		for (const tier of TIERS)
			expect(modelFor(tier, { provider: WORK }, { provider: "anthropic", modelId: "x" })).toEqual({
				provider: WORK,
				modelId: ANTHROPIC.models[tier],
			});
		expect(
			modelFor("deep", { provider: WORK, overrides: { anthropic: { deep: "other" } } }, { provider: "a", modelId: "x" })
				.modelId,
		).toBe(ANTHROPIC.models.deep);
		expect(
			modelFor("deep", { provider: WORK, overrides: { [WORK]: { deep: "own" } } }, { provider: "a", modelId: "x" }),
		).toEqual({ provider: WORK, modelId: "own" });
	});

	it("is forgotten, label and all, when its credential is", async () => {
		const home = await tempHome();
		const credentials = new FileCredentialStore(home);
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-personal" }));
		await credentials.modify(WORK, async () => ({ type: "api_key", key: "sk-work" }));
		await credentials.label(WORK, "Work");
		const file = JSON.parse(await readFile(join(home, "auth", "providers.json"), "utf8"));
		expect(Value.Check(ProvidersFile, file)).toBe(true);
		expect(file.accounts).toEqual({ [WORK]: { label: "Work" } });
		await credentials.delete(WORK);
		expect(await credentials.labels()).toEqual({});
		expect(await credentials.read(WORK)).toBeUndefined();
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "sk-personal" });
	});

	it("is counted under its own id in the usage ledger", async () => {
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials });
		const faux = fauxProvider({
			provider: "anthropic",
			models: [...new Set(TIERS.map((tier) => ANTHROPIC.models[tier]))].map((id) => ({ id })),
		});
		models.setProvider(faux.provider);
		faux.setResponses(
			Array.from(
				{ length: 100 },
				() => (ctx: { messages: readonly { role: string }[] }) =>
					ctx.messages.at(-1)?.role === "user"
						? fauxAssistantMessage([fauxToolCall("message_user", { text: "on it" })], { stopReason: "toolUse" })
						: fauxAssistantMessage("done"),
			) as never,
		);
		models.setProvider(accountProvider(models.getProvider("anthropic")!, WORK));
		await credentials.modify(WORK, async () => ({ type: "api_key", key: "sk-work" }));
		const configured = { provider: "anthropic", modelId: ANTHROPIC.models.quick };
		const gateway = new FakeGateway();
		const core = defineCore({ blobs: blobStore(), gateway: () => gateway, model: () => configured });
		const tiers = defineTierSwitch(() => configured);
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(tiers.extension);
		const harness = await openStore(await tempHome(), { models, registry });
		harness.resume();
		try {
			await harness.commit((tx) => setModels(tx, { provider: WORK }), context);
			const got = await core.receive(harness, {
				id: randomUUID(),
				origin: { gateway: "fake", peer: OWNER, thread: "a" },
				text: "hi",
			});
			if (!("turn" in got)) throw new Error(JSON.stringify(got));
			await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
			const usage = await harness.snapshot(UsageDoc, got.chat as ConversationId, context);
			expect(Object.keys(usage?.models ?? {})).toEqual([`${WORK}/${ANTHROPIC.models.quick}`]);
		} finally {
			await harness.close(context);
		}
	});
});
