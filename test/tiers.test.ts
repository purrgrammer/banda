import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
	AgentDoc,
	type ConversationId,
	createRegistry,
	type Harness,
	LiveDoc,
	type ModelRef,
	type SetTimer,
	type TaskId,
} from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Accepted, ChatTier, defineTierSwitch, parseAgent, shaOf } from "../src/core/agents.ts";
import { setCompanion, setModels } from "../src/core/companion.ts";
import { type Origin, OWNER, routeKey } from "../src/core/gateway.ts";
import { parseRoutine, routinePath } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import { DEFAULT_TIER, modelFor, PRESETS, presetOf, TIERS, type Tier } from "../src/core/tiers.ts";
import { defineCore, Routes, type TurnResult } from "../src/core/turn.ts";
import { startDaemon } from "../src/daemon.ts";
import { DEFAULT_MODEL, readDaemonFile } from "../src/home.ts";
import type { ChatRow, CompanionView, TiersView } from "../src/server/api.ts";
import { NAMES } from "../src/server/seen.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const ANTHROPIC = presetOf("anthropic")!;
const OPENAI = presetOf("openai")!;
/** The configured model, as a fresh home's: Deep's, which tiers now step down from. */
const CONFIGURED: ModelRef = { provider: "anthropic", modelId: ANTHROPIC.models.deep };
const owner = (thread: string): Origin => ({ gateway: "fake", peer: OWNER, thread });

describe("the presets", () => {
	it("every preset's model is in pi-ai's catalog, so a bump that drops one fails here", () => {
		for (const { provider, models } of PRESETS)
			for (const tier of TIERS) {
				const catalog = getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0]);
				expect(
					catalog.some((model) => model.id === models[tier]),
					`${provider} ${tier}: ${models[tier]}`,
				).toBe(true);
			}
	});

	it("every provider with presets is named in plain words", () => {
		for (const { provider } of PRESETS) expect(NAMES[provider], provider).toBeDefined();
	});

	it("a provider without presets runs the configured model on every tier; an override replaces one tier's", () => {
		for (const tier of TIERS) expect(modelFor(tier, {}, FAUX_MODEL)).toEqual(FAUX_MODEL);
		expect(modelFor("quick", {}, CONFIGURED)).toEqual({ provider: "anthropic", modelId: "claude-haiku-5-5" });
		expect(modelFor("deep", { overrides: { anthropic: { deep: "claude-fable-5-1" } } }, CONFIGURED)).toEqual({
			provider: "anthropic",
			modelId: "claude-fable-5-1",
		});
		// an override of another provider's is not this one's
		expect(modelFor("deep", { overrides: { openai: { deep: "x" } } }, CONFIGURED).modelId).toBe("claude-opus-5-5");
		expect(modelFor("balanced", { provider: "openai" }, CONFIGURED)).toEqual({
			provider: "openai",
			modelId: "gpt-6.1-sol",
		});
	});

	it("a routine's file says no tier: it runs as its agent's chat thinks", () => {
		expect(parseRoutine("tea", "---\ndescription: Tea\nevery: 1d\ntier: deep\n---\nTea.")).toEqual({
			errors: ['"tier" is not a field: use description, every, at, cron, zone, runs_a_day'],
		});
	});
});

/**
 * A faux Anthropic with the preset's three models: each request is recorded by its model; an owner's input is
 * answered with `message_user`, then the run ends. While `hold` is set, the first request of a run waits on it.
 */
function anthropic(withOpenai = false, openaiAuth?: "key" | "oauth") {
	const requests: string[] = [];
	const control: { hold?: Promise<void> | undefined; entered?: (() => void) | undefined } = {};
	const faux = fauxProvider({
		provider: "anthropic",
		models: [...new Set(TIERS.map((tier) => ANTHROPIC.models[tier]))].map((id) => ({ id })),
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const openai = withOpenai
		? fauxProvider({
				provider: "openai",
				models: [...new Set(TIERS.map((tier) => OPENAI.models[tier]))].map((id) => ({ id })),
			})
		: undefined;
	if (openai !== undefined) {
		const auth =
			openaiAuth === "key"
				? {
						apiKey: {
							name: "Test key",
							login: async ({ prompt }: { prompt: (ask: { type: "secret"; message: string }) => Promise<string> }) => ({
								type: "api_key" as const,
								key: await prompt({ type: "secret", message: "Key" }),
							}),
							resolve: async ({ credential }: { credential?: { key?: string } }) =>
								credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined,
						},
					}
				: openaiAuth === "oauth"
					? {
							oauth: {
								name: "Test sign-in",
								login: async ({
									notify,
									prompt,
								}: {
									notify: (event: { type: "auth_url"; url: string }) => void;
									prompt: (ask: { type: "manual_code"; message: string }) => Promise<string>;
								}) => {
									notify({ type: "auth_url", url: "https://example.invalid/sign-in" });
									if ((await prompt({ type: "manual_code", message: "Code" })) !== "approved")
										throw new Error("Sign-in cancelled");
									return {
										type: "oauth" as const,
										access: "access",
										refresh: "refresh",
										expires: Date.now() + 3_600_000,
									};
								},
								refresh: async (credential: { type: "oauth"; access: string; refresh: string; expires: number }) =>
									credential,
								toAuth: async () => ({ apiKey: "access" }),
							},
						}
					: openai.provider.auth;
		models.setProvider({ ...openai.provider, auth });
	}
	const respond = async (
		ctx: { messages: readonly { role: string }[] },
		_options: unknown,
		_state: unknown,
		model: { id: string },
	) => {
		requests.push(model.id);
		if (ctx.messages.at(-1)?.role === "user") {
			control.entered?.();
			if (control.hold !== undefined) await control.hold;
			return fauxAssistantMessage([fauxToolCall("message_user", { text: "on it" })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("done");
	};
	faux.setResponses(Array.from({ length: 10_000 }, () => respond as never));
	openai?.setResponses(Array.from({ length: 10_000 }, () => respond as never));
	return { models, requests, control };
}

/** A clock a test moves by hand, and timers that look at it often. */
function testClock() {
	const clock = { now: Date.UTC(2026, 10, 2, 8) };
	const setTimer: SetTimer = (callback, delay, { background }) => {
		const timer = setTimeout(callback, Math.max(0, Math.min(delay, 5)));
		if (background) timer.unref();
		return () => clearTimeout(timer);
	};
	return { clock, now: () => clock.now, setTimer };
}

function setup(time?: ReturnType<typeof testClock>) {
	const llm = anthropic();
	const gateway = new FakeGateway();
	const core = defineCore({
		blobs: blobStore(),
		gateway: () => gateway,
		model: () => CONFIGURED,
		retryDelay: () => 5,
		...(time === undefined ? {} : { now: time.now }),
	});
	const tiers = defineTierSwitch(() => CONFIGURED);
	const open = async () => {
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(tiers.extension);
		const harness = await openStore(await tempHome(), {
			models: llm.models,
			registry,
			...(time === undefined ? {} : { now: time.now, setTimer: time.setTimer }),
		});
		harness.resume();
		return harness;
	};
	return { ...llm, core, tiers, open };
}

const modelOf = async (harness: Harness, chat: number) =>
	(await harness.snapshot(AgentDoc, chat as ConversationId, context))?.model?.modelId;
const idle = async (harness: Harness, chat: number) =>
	(await harness.snapshot(LiveDoc, chat as ConversationId, context))?.run === undefined;

/** Say `text` in `thread` and wait for its Turn; the requests its run made. */
async function say(s: ReturnType<typeof setup>, harness: Harness, thread: string, text: string) {
	const from = s.requests.length;
	const got = await s.core.receive(harness, { id: randomUUID(), origin: owner(thread), text });
	if (!("turn" in got)) throw new Error(JSON.stringify(got));
	await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
	return { chat: got.chat, requests: s.requests.slice(from) };
}

describe("a chat's tier", () => {
	it("a new chat starts on the companion's tier; Quick until the owner picks another", async () => {
		const s = setup();
		const harness = await s.open();
		try {
			const first = await say(s, harness, "a", "hi");
			expect(first.requests).toEqual([ANTHROPIC.models.quick, ANTHROPIC.models.quick]);
			expect((await harness.snapshot(ChatTier, context))?.chats[first.chat]).toEqual({
				tier: DEFAULT_TIER,
				inherited: true,
			});
			await setCompanion(harness, { tier: "deep" });
			const second = await say(s, harness, "b", "hi");
			expect(second.requests).toEqual([ANTHROPIC.models.deep, ANTHROPIC.models.deep]);
			// the first chat keeps its tier
			expect((await say(s, harness, "a", "again")).requests[0]).toBe(ANTHROPIC.models.quick);
		} finally {
			await harness.close(context);
		}
	});

	it("an agent file's own model is kept: no tier changes it", async () => {
		const s = setup();
		const harness = await s.open();
		try {
			const text = `---\ndescription: a reader\nmodel: anthropic/${ANTHROPIC.models.balanced}\n---\nRead.`;
			expect(parseAgent("reader", text)).toMatchObject({ agent: { model: { modelId: ANTHROPIC.models.balanced } } });
			await harness.commit(async (tx) => {
				(await tx.doc(Accepted)).files["agents/reader.md"] = { sha: shaOf(text), text, at: 0 };
			}, context);
			const got = await s.core.receive(harness, { id: "m1", origin: owner("r"), text: "hi", agent: "reader" });
			if (!("turn" in got)) throw new Error(JSON.stringify(got));
			await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
			expect(await modelOf(harness, got.chat)).toBe(ANTHROPIC.models.balanced);
			expect(await s.tiers.switchTier(harness, got.chat, "deep")).toEqual({ refused: "custom" });
			expect(await s.tiers.switchTier(harness, 999, "deep")).toEqual({ refused: "unknown" });
		} finally {
			await harness.close(context);
		}
	});

	it("spike: a switch while a run works changes the model from the next run on, never inside the run", async () => {
		const s = setup();
		const harness = await s.open();
		try {
			const { chat } = await say(s, harness, "a", "hi");
			// idle: the model changes in the switch's own commit
			await s.tiers.switchTier(harness, chat, "balanced");
			expect(await modelOf(harness, chat)).toBe(ANTHROPIC.models.balanced);
			// busy: the run that works keeps its model to its end
			let release = () => {};
			s.control.hold = new Promise<void>((resolve) => {
				release = resolve;
			});
			const entered = new Promise<void>((resolve) => {
				s.control.entered = resolve;
			});
			const from = s.requests.length;
			const got = await s.core.receive(harness, { id: "m-busy", origin: owner("a"), text: "work" });
			if (!("turn" in got)) throw new Error(JSON.stringify(got));
			await entered;
			await s.tiers.switchTier(harness, chat, "deep");
			expect((await harness.snapshot(ChatTier, context))?.chats[chat]?.tier).toBe("deep");
			expect(await modelOf(harness, chat)).toBe(ANTHROPIC.models.balanced);
			s.control.hold = undefined;
			release();
			await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
			expect(s.requests.slice(from)).toEqual([ANTHROPIC.models.balanced, ANTHROPIC.models.balanced]);
			await until(async () => (await modelOf(harness, chat)) === ANTHROPIC.models.deep);
			expect((await say(s, harness, "a", "next")).requests).toEqual([ANTHROPIC.models.deep, ANTHROPIC.models.deep]);
		} finally {
			s.control.entered = undefined;
			await harness.close(context);
		}
	});

	it("a provider choice during a run takes effect after that run, without changing its model", async () => {
		const s = setup();
		const harness = await s.open();
		try {
			const { chat } = await say(s, harness, "a", "hi");
			let release = () => {};
			s.control.hold = new Promise<void>((resolve) => {
				release = resolve;
			});
			const entered = new Promise<void>((resolve) => {
				s.control.entered = resolve;
			});
			const from = s.requests.length;
			const got = await s.core.receive(harness, { id: "during-choice", origin: owner("a"), text: "work" });
			if (!("turn" in got)) throw new Error(JSON.stringify(got));
			await entered;
			await harness.commit(async (tx) => {
				await setModels(tx, { override: { provider: "anthropic", tier: "quick", modelId: ANTHROPIC.models.deep } });
				await s.tiers.modelsChanged(tx);
			}, context);
			expect(await modelOf(harness, chat)).toBe(ANTHROPIC.models.quick);
			s.control.hold = undefined;
			release();
			await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
			expect(s.requests.slice(from)).toEqual([ANTHROPIC.models.quick, ANTHROPIC.models.quick]);
			await until(async () => (await modelOf(harness, chat)) === ANTHROPIC.models.deep);
			expect((await say(s, harness, "a", "next")).requests).toEqual([ANTHROPIC.models.deep, ANTHROPIC.models.deep]);
		} finally {
			s.control.hold = undefined;
			s.control.entered = undefined;
			await harness.close(context);
		}
	});

	it("property: every run asks one model, its chat's tier's at the run's start", async () => {
		type Op =
			| { kind: "default"; tier: Tier }
			| { kind: "say"; thread: number }
			| { kind: "switch"; thread: number; tier: Tier }
			| { kind: "switch-while-working"; thread: number; tier: Tier };
		const tier = fc.constantFrom(...TIERS);
		const thread = fc.integer({ min: 0, max: 2 });
		const op: fc.Arbitrary<Op> = fc.oneof(
			fc.record({ kind: fc.constant("default" as const), tier }),
			fc.record({ kind: fc.constant("say" as const), thread }),
			fc.record({ kind: fc.constant("switch" as const), thread, tier }),
			fc.record({ kind: fc.constant("switch-while-working" as const), thread, tier }),
		);
		await fc.assert(
			fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 8 }), async (ops) => {
				const s = setup();
				const harness = await s.open();
				try {
					let companion: Tier = DEFAULT_TIER;
					/** Each thread's chat and its tier, once it has one. */
					const chats = new Map<number, { chat: number; tier: Tier }>();
					const expectRun = (requests: readonly string[], on: Tier) => {
						expect(requests.length).toBeGreaterThan(0);
						for (const asked of requests) expect(asked).toBe(ANTHROPIC.models[on]);
					};
					for (const each of ops) {
						if (each.kind === "default") {
							await setCompanion(harness, { tier: each.tier });
							companion = each.tier;
							continue;
						}
						const known = chats.get(each.thread);
						if (each.kind === "switch") {
							if (known === undefined) continue;
							await s.tiers.switchTier(harness, known.chat, each.tier);
							known.tier = each.tier;
							continue;
						}
						if (each.kind === "say") {
							const ran = await say(s, harness, `t${each.thread}`, "hi");
							const on = known?.tier ?? companion;
							expectRun(ran.requests, on);
							chats.set(each.thread, { chat: ran.chat, tier: on });
							continue;
						}
						if (known === undefined) continue;
						// a switch while the chat works: that run keeps its model; the next one asks the new
						let release = () => {};
						s.control.hold = new Promise<void>((resolve) => {
							release = resolve;
						});
						const entered = new Promise<void>((resolve) => {
							s.control.entered = resolve;
						});
						const from = s.requests.length;
						const got = await s.core.receive(harness, {
							id: randomUUID(),
							origin: owner(`t${each.thread}`),
							text: "w",
						});
						if (!("turn" in got)) throw new Error(JSON.stringify(got));
						await entered;
						s.control.entered = undefined;
						await s.tiers.switchTier(harness, known.chat, each.tier);
						s.control.hold = undefined;
						release();
						await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
						expectRun(s.requests.slice(from), known.tier);
						known.tier = each.tier;
						await until(
							async () =>
								(await idle(harness, known.chat)) &&
								(await modelOf(harness, known.chat)) === ANTHROPIC.models[each.tier],
						);
					}
				} finally {
					s.control.hold = undefined;
					s.control.entered = undefined;
					await harness.close(context);
				}
			}),
			{ numRuns: pbtRuns(8) },
		);
	}, 60_000);
});

describe("tiers in the app", () => {
	async function start(withOpenai = false, openaiAuth?: "key" | "oauth", configured: ModelRef = CONFIGURED) {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: configured }));
		const web = join(home, "web");
		await mkdir(web, { recursive: true });
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const llm = anthropic(withOpenai, openaiAuth);
		const daemon = await startDaemon({ home, port: 0, models: llm.models, log: () => {}, box: hostBox(home), web });
		const token = (await readDaemonFile(home))!.token!;
		const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, ...init.headers },
			});
			if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
			return (await response.json()) as T;
		};
		const send = async (thread: string, text: string) => {
			await api("/messages", { method: "POST", body: JSON.stringify({ id: randomUUID(), thread, text }) });
		};
		return { home, daemon, api, send, ...llm };
	}

	it("the provider is the owner's pick once they choose one, or once config.json names a model; never by default", async () => {
		const byDefault = await start(false, undefined, DEFAULT_MODEL);
		try {
			expect((await byDefault.api<TiersView>("/tiers")).chosen).toBe(false);
			await byDefault.api("/tiers", { method: "PUT", body: JSON.stringify({ provider: "anthropic" }) });
			expect((await byDefault.api<TiersView>("/tiers")).chosen).toBe(true);
		} finally {
			await byDefault.daemon.close();
		}
		const configured = await start(false, undefined, { provider: "anthropic", modelId: ANTHROPIC.models.quick });
		try {
			expect((await configured.api<TiersView>("/tiers")).chosen).toBe(true);
		} finally {
			await configured.daemon.close();
		}
	});

	it("connecting a provider selects it even without a settings view, and an existing chat uses it", async () => {
		const s = await start(true, "key");
		try {
			const thread = randomUUID();
			await s.send(thread, "hi");
			await until(() => s.requests.length >= 2);
			expect((await s.api<TiersView>("/tiers")).provider.id).toBe("anthropic");
			expect(
				(await s.api<{ id: string; accounts: { connected: boolean }[] }[]>("/providers")).find((p) => p.id === "openai")
					?.accounts[0]?.connected,
			).toBe(false);
			await s.api("/providers/openai", { method: "POST", body: JSON.stringify({ type: "api_key", key: "test-key" }) });
			expect((await s.api<TiersView>("/tiers")).provider.id).toBe("openai");
			await s.send(thread, "again");
			await until(() => s.requests.length >= 4);
			expect(s.requests.slice(2)).toEqual([OPENAI.models.quick, OPENAI.models.quick]);
		} finally {
			await s.daemon.close();
		}
	});

	it("signing out of the band's provider moves it to one still usable; another's sign-out leaves the choice", async () => {
		const s = await start(true, "key");
		try {
			const thread = randomUUID();
			await s.api("/providers/openai", { method: "POST", body: JSON.stringify({ type: "api_key", key: "test-key" }) });
			expect((await s.api<TiersView>("/tiers")).provider.id).toBe("openai");
			await s.send(thread, "hi");
			await until(() => s.requests.length >= 2);
			expect(s.requests.slice(0, 2)).toEqual([OPENAI.models.quick, OPENAI.models.quick]);
			await s.api("/providers/openai", { method: "DELETE" });
			const after = await s.api<TiersView>("/tiers");
			expect(after.provider.id).toBe("anthropic");
			expect(after.providers.map((p) => p.id)).toEqual(["anthropic"]);
			await s.send(thread, "again");
			await until(() => s.requests.length >= 4);
			expect(s.requests.slice(2)).toEqual([ANTHROPIC.models.quick, ANTHROPIC.models.quick]);
			await s.api("/providers/openai", { method: "POST", body: JSON.stringify({ type: "api_key", key: "test-key" }) });
			await s.api("/tiers", { method: "PUT", body: JSON.stringify({ provider: "anthropic" }) });
			await s.api("/providers/openai", { method: "DELETE" });
			expect((await s.api<TiersView>("/tiers")).provider.id).toBe("anthropic");
		} finally {
			await s.daemon.close();
		}
	});

	it("a sign-in selects its provider after completion, even if no settings view remains", async () => {
		const s = await start(true, "oauth");
		try {
			const thread = randomUUID();
			await s.send(thread, "hi");
			await until(() => s.requests.length >= 2);
			expect(await s.api("/providers/openai", { method: "POST", body: JSON.stringify({ type: "oauth" }) })).toEqual({
				url: "https://example.invalid/sign-in",
			});
			expect((await s.api<TiersView>("/tiers")).provider.id).toBe("anthropic");
			await s.api("/providers/openai/answer", { method: "POST", body: JSON.stringify({ value: "cancelled" }) });
			await until(
				async () =>
					(await s.api<{ id: string; accounts: { error?: string }[] }[]>("/providers")).find((p) => p.id === "openai")
						?.accounts[0]?.error,
			);
			expect((await s.api<TiersView>("/tiers")).provider.id).toBe("anthropic");
			expect(await s.api("/providers/openai", { method: "POST", body: JSON.stringify({ type: "oauth" }) })).toEqual({
				url: "https://example.invalid/sign-in",
			});
			await s.api("/providers/openai/answer", { method: "POST", body: JSON.stringify({ value: "approved" }) });
			await until(async () => (await s.api<TiersView>("/tiers")).provider.id === "openai");
			await s.send(thread, "again");
			await until(() => s.requests.length >= 4);
			expect(s.requests.slice(2)).toEqual([OPENAI.models.quick, OPENAI.models.quick]);
		} finally {
			await s.daemon.close();
		}
	});

	it("selecting a connected provider updates an existing chat's next run", async () => {
		const s = await start(true);
		try {
			const thread = randomUUID();
			await s.send(thread, "hi");
			await until(() => s.requests.length >= 2);
			expect(s.requests.slice(0, 2)).toEqual([ANTHROPIC.models.quick, ANTHROPIC.models.quick]);
			expect(
				(await s.api<TiersView>("/tiers", { method: "PUT", body: JSON.stringify({ provider: "openai" }) })).provider.id,
			).toBe("openai");
			await s.send(thread, "again");
			await until(() => s.requests.length >= 4);
			expect(s.requests.slice(2)).toEqual([OPENAI.models.quick, OPENAI.models.quick]);
		} finally {
			await s.daemon.close();
		}
	});

	it("the companion's tier, the models, a chat's switch, and what is refused", async () => {
		const s = await start();
		try {
			expect((await s.api<CompanionView>("/companion")).tier).toBe("quick");
			const tiers = await s.api<TiersView>("/tiers");
			expect(tiers).toMatchObject({
				// the faux provider's endpoint is this computer's
				provider: { id: "anthropic", name: "Anthropic", local: true },
				presets: true,
				models: { quick: { id: "claude-haiku-5-5" }, deep: { id: "claude-opus-5-5" } },
				providers: [{ id: "anthropic", name: "Anthropic" }],
			});
			expect(tiers.catalog.map((model) => model.id)).toContain("claude-sonnet-5-5");
			// a provider without credentials, a model it does not have, a tier that is not one: refused
			await expect(s.api("/tiers", { method: "PUT", body: JSON.stringify({ provider: "openai" }) })).rejects.toThrow(
				/400.*OpenAI has no key/,
			);
			await expect(
				s.api("/tiers", { method: "PUT", body: JSON.stringify({ override: { tier: "deep", modelId: "nope" } }) }),
			).rejects.toThrow(/400.*Anthropic has no model/);
			await expect(s.api("/companion", { method: "PUT", body: JSON.stringify({ tier: "max" }) })).rejects.toThrow(
				/400/,
			);
			// one tier's own model, then back to the preset
			const own = await s.api<TiersView>("/tiers", {
				method: "PUT",
				body: JSON.stringify({ override: { tier: "balanced", modelId: "claude-opus-5-5" } }),
			});
			expect(own.models.balanced).toMatchObject({ id: "claude-opus-5-5", own: true });
			const back = await s.api<TiersView>("/tiers", {
				method: "PUT",
				body: JSON.stringify({ override: { tier: "balanced", modelId: null } }),
			});
			expect(back.models.balanced).toEqual({ id: "claude-sonnet-5-5", name: "claude-sonnet-5-5" });

			// a new chat starts on the companion's tier
			await s.api("/companion", { method: "PUT", body: JSON.stringify({ tier: "balanced" }) });
			expect((await s.api<CompanionView>("/companion")).tier).toBe("balanced");
			const thread = randomUUID();
			await s.send(thread, "hi");
			const row = await until(async () =>
				(await s.api<ChatRow[]>("/chats")).find((each) => each.state === "idle" && each.tier !== undefined),
			);
			expect(row.tier).toBe("balanced");
			await until(() => s.requests.length >= 2);
			expect(s.requests).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
			// the owner starts to write: the chat just spoke, so its cache is warm already
			expect(await s.api(`/chats/${row.chat}/warm`, { method: "POST" })).toEqual({ skipped: "warm" });
			await expect(s.api("/chats/999/warm", { method: "POST" })).rejects.toThrow(/404/);
			// the owner switches it: the next run asks the new model
			expect(
				await s.api(`/chats/${row.chat}/tier`, { method: "POST", body: JSON.stringify({ tier: "deep" }) }),
			).toEqual({ tier: "deep" });
			expect((await s.api<ChatRow[]>("/chats")).find((each) => each.chat === row.chat)?.tier).toBe("deep");
			await s.send(thread, "again");
			await until(() => s.requests.length >= 4);
			expect(s.requests.slice(2)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
			await expect(
				s.api(`/chats/${row.chat}/tier`, { method: "POST", body: JSON.stringify({ tier: "max" }) }),
			).rejects.toThrow(/400/);
			await expect(
				s.api("/chats/999/tier", { method: "POST", body: JSON.stringify({ tier: "deep" }) }),
			).rejects.toThrow(/404/);
		} finally {
			await s.daemon.close();
		}
	});
});

describe("a routine's wake", () => {
	it("goes to its agent's one chat, which thinks as that chat does, never a chat of its own", async () => {
		const time = testClock();
		const s = setup(time);
		const harness = await s.open();
		try {
			await setCompanion(harness, { tier: "balanced" });
			const text = "---\ndescription: Check\nevery: 10m\n---\nCheck.\n";
			await harness.commit(async (tx) => {
				(await tx.doc(Accepted)).files[routinePath("check")] = { sha: shaOf(text), text, at: time.now() };
			}, context);
			await s.core.reconcile(harness);
			time.clock.now += 10 * 60_000;
			const chat = await until(
				async () =>
					(await harness.snapshot(Routes, context))?.routes[routeKey({ gateway: "web", peer: OWNER, thread: "main" })]
						?.chat,
			);
			const routes = (await harness.snapshot(Routes, context))?.routes ?? {};
			expect(Object.keys(routes).filter((key) => key.includes("routine"))).toEqual([]);
			const tiers = (await harness.snapshot(ChatTier, context))?.chats ?? {};
			expect(tiers[chat]?.tier).toBe("balanced");
		} finally {
			await harness.close(context);
		}
	});
});
