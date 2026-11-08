/**
 * Provider accounts through the API against a daemon: another account added by its label, listed, thought with, kept
 * over a restart and signed out of; the same key twice is the account already connected.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import { presetOf, TIERS } from "../src/core/tiers.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { TiersView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until } from "./helpers.ts";

const ANTHROPIC = presetOf("anthropic")!;
const WORK = "anthropic@work";

/** A faux Anthropic that takes a key (resolving only one stored) and records which account each request went to. */
function keyedAnthropic(home: string) {
	const models = createModels({ credentials: new FileCredentialStore(home) });
	const faux = fauxProvider({
		provider: "anthropic",
		models: [...new Set(TIERS.map((tier) => ANTHROPIC.models[tier]))].map((id) => ({ id })),
	});
	const requests: string[] = [];
	faux.setResponses(
		Array.from(
			{ length: 1000 },
			() =>
				(
					ctx: { messages: readonly { role: string }[] },
					_options: unknown,
					_state: unknown,
					model: { provider: string },
				) => {
					requests.push(model.provider);
					return ctx.messages.at(-1)?.role === "user"
						? fauxAssistantMessage([fauxToolCall("message_user", { text: "on it" })], { stopReason: "toolUse" })
						: fauxAssistantMessage("done");
				},
		) as never,
	);
	models.setProvider({
		...faux.provider,
		name: "Anthropic",
		auth: {
			apiKey: {
				name: "Test key",
				login: async ({ prompt }: { prompt: (ask: { type: "secret"; message: string }) => Promise<string> }) => ({
					type: "api_key" as const,
					key: await prompt({ type: "secret", message: "Key" }),
				}),
				resolve: async ({ credential }: { credential?: { key?: string } }) =>
					credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined,
			},
		},
	} as never);
	return { models, requests };
}

type Accounts = { id: string; accounts: { id: string; label: string; connected: boolean; error?: string }[] }[];

describe("provider accounts in the app", () => {
	async function start(home: string) {
		const web = join(home, "web");
		await mkdir(web, { recursive: true });
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "anthropic", modelId: "x" } }));
		const llm = keyedAnthropic(home);
		const daemon = await startDaemon({ home, port: 0, models: llm.models, log: () => {}, box: hostBox(home), web });
		const token = (await readDaemonFile(home))!.token!;
		const call = async (path: string, init: RequestInit = {}) =>
			fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, ...init.headers },
			});
		const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const response = await call(path, init);
			if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
			return (await response.json()) as T;
		};
		const anthropic = async () => (await api<Accounts>("/providers")).find((each) => each.id === "anthropic")!.accounts;
		return { daemon, call, api, anthropic, ...llm };
	}
	const post = (body: object) => ({ method: "POST", body: JSON.stringify(body) });

	it("adds another account by its label, thinks with it, keeps it over a restart and signs out of it", async () => {
		const home = await tempHome();
		let s = await start(home);
		try {
			await s.api("/providers/anthropic", post({ type: "api_key", key: "sk-one" }));
			// the same key again is the account already connected, not another
			const twice = await s.call(
				"/providers/anthropic/accounts",
				post({ label: "Work", type: "api_key", key: "sk-one" }),
			);
			expect(twice.status).toBe(409);
			expect(await twice.text()).toMatch(/connected already/);
			expect((await s.anthropic()).map((each) => each.id)).toEqual(["anthropic"]);
			expect(
				await s.api("/providers/anthropic/accounts", post({ label: "Work", type: "api_key", key: "sk-two" })),
			).toEqual({
				id: WORK,
			});
			// a label is the account's own among its backend's
			expect(
				(await s.call("/providers/anthropic/accounts", post({ label: "work", type: "api_key", key: "k" }))).status,
			).toBe(400);
			expect(await s.anthropic()).toMatchObject([
				{ id: "anthropic", label: "Anthropic", connected: true },
				{ id: WORK, label: "Work", connected: true },
			]);
			const tiers = await s.api<TiersView>("/tiers");
			expect(tiers.provider).toMatchObject({ id: WORK, name: "Anthropic · Work" });
			expect(tiers.providers.map((each) => [each.id, each.name])).toEqual([
				["anthropic", "Anthropic"],
				[WORK, "Anthropic · Work"],
			]);
			await s.api("/messages", post({ id: randomUUID(), thread: randomUUID(), text: "hi" }));
			await until(() => s.requests.length >= 2);
			expect(s.requests.slice(0, 2)).toEqual([WORK, WORK]);
		} finally {
			await s.daemon.close();
		}
		s = await start(home);
		try {
			expect(await s.anthropic()).toMatchObject([
				{ id: "anthropic", connected: true },
				{ id: WORK, label: "Work", connected: true },
			]);
			expect((await s.api<TiersView>("/tiers")).provider.id).toBe(WORK);
			await s.api(`/providers/${encodeURIComponent(WORK)}`, { method: "DELETE" });
			expect((await s.anthropic()).map((each) => each.id)).toEqual(["anthropic"]);
			expect((await s.api<TiersView>("/tiers")).provider.id).toBe("anthropic");
			const file = JSON.parse(await readFile(join(home, "auth", "providers.json"), "utf8"));
			expect(file).toEqual({ credentials: { anthropic: { type: "api_key", key: "sk-one" } } });
		} finally {
			await s.daemon.close();
		}
	});

	it("adds the backend's first account when it has none, and leaves nothing of one it refused", async () => {
		const home = await tempHome();
		const s = await start(home);
		try {
			expect(
				await s.api("/providers/anthropic/accounts", post({ label: "Personal", type: "api_key", key: "sk-one" })),
			).toEqual({ id: "anthropic" });
			expect(await s.anthropic()).toMatchObject([{ id: "anthropic", label: "Personal", connected: true }]);
			// this backend takes no sign-in: the account it refused is not left registered
			const refused = await s.call("/providers/anthropic/accounts", post({ label: "Work", type: "oauth" }));
			expect(refused.status).toBe(400);
			expect((await s.anthropic()).map((each) => each.id)).toEqual(["anthropic"]);
		} finally {
			await s.daemon.close();
		}
	});
});
