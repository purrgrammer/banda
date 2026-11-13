/**
 * Custom providers: an OpenAI-compatible endpoint the owner defines, with models declared by hand, against a scripted
 * server on loopback (`./fixtures/compat-server.ts`), never a live one. The address rules, the definition's file, what
 * a request to the endpoint carries, the tiers that never fall back to another provider's model, and the daemon's API:
 * adding one without a network call, a chat answered by it, a restart that resumes on it, an edit or removal refused
 * while something runs on it, and a check the owner asks for.
 */
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createModels } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { shaOf } from "../src/core/agents.ts";
import {
	customProvider,
	customProvidersPath,
	readCustomProviders,
	redact,
	registerCustomProviders,
} from "../src/core/custom-provider.ts";
import { type CustomProvider, customId, destinationOf, problemsOf } from "../src/core/custom-providers.ts";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import { modelFor, TIERS } from "../src/core/tiers.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ChatRow, Checked, CustomProvidersView, TiersView } from "../src/server/api.ts";
import { type CompatServer, compatServer } from "./fixtures/compat-server.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until } from "./helpers.ts";

const servers: CompatServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});
async function serve(options: Parameters<typeof compatServer>[0] = {}) {
	const server = await compatServer(options);
	servers.push(server);
	return server;
}

const model = (id: string, more: Partial<CustomProvider["models"][number]> = {}) => ({
	id,
	images: false,
	reasoning: false,
	contextWindow: 32_768,
	maxTokens: 4096,
	cost: { input: 0, output: 0 },
	...more,
});
const definition = (baseUrl: string, more: Partial<CustomProvider> = {}): CustomProvider => ({
	id: "custom-local",
	name: "Local",
	baseUrl,
	key: "none",
	models: [model("small"), model("large")],
	...more,
});
const ask = (text = "hi") => ({ messages: [{ role: "user" as const, content: text, timestamp: Date.now() }] });

describe("an address", () => {
	it.each([
		["http://localhost:11434/v1", "computer"],
		["http://127.0.0.1:1234/v1/", "computer"],
		["http://[::1]:8080/v1", "computer"],
		["http://192.168.1.20:8000/v1", "network"],
		["http://10.0.0.5/v1", "network"],
		["http://172.20.1.1/v1", "network"],
		["http://100.101.1.2:11434/v1", "network"],
		["http://gpu-box:8000/v1", "network"],
		["http://studio.local:1234/v1", "network"],
		["https://api.example.com/v1", "internet"],
		["https://203.0.113.9/v1", "internet"],
	])("%s is on %s", (url, place) => {
		const destination = destinationOf(url);
		expect("error" in destination ? destination.error : destination.place).toBe(place);
	});

	it.each([
		["http://api.example.com/v1", /https:\/\/ for api\.example\.com/],
		["http://203.0.113.9/v1", /https/],
		["ftp://example.com", /http:\/\/ or https:\/\//],
		["https://user:pass@example.com/v1", /name and password/],
		["https://example.com/v1?key=x", /\? and #/],
		["http://169.254.169.254/v1", /link-local/],
		["http://0.0.0.0:8000/v1", /127\.0\.0\.1/],
		["http://[fe80::1]/v1", /link-local/],
		["localhost:11434", /^That is not an address|http:\/\/ or https:\/\//],
		["", /Write the address/],
	])("%s is refused", (url, why) => {
		const destination = destinationOf(url);
		expect("error" in destination ? destination.error : "accepted").toMatch(why);
	});

	it("is kept without a trailing slash", () => {
		expect(destinationOf("http://localhost:1234/v1/")).toMatchObject({ url: "http://localhost:1234/v1" });
	});
});

describe("a definition", () => {
	it("says each thing wrong with it, by field", () => {
		const problems = problemsOf(
			{
				name: " ",
				baseUrl: "http://example.com/v1",
				key: "none",
				models: [model("a b"), model("ok", { contextWindow: 1000 }), model("ok", { maxTokens: 64_000 })],
			},
			[],
		);
		expect(problems.map((problem) => problem.field)).toEqual([
			"name",
			"baseUrl",
			"models.0.id",
			"models.1.contextWindow",
			"models.2.id",
			"models.2.maxTokens",
		]);
		expect(problemsOf({ ...definition("http://localhost:1/v1"), name: "local" }, ["Local"])[0]?.message).toMatch(
			/called local already/,
		);
		expect(problemsOf({ ...definition("http://localhost:1/v1"), models: [] })[0]?.field).toBe("models");
	});

	it("gets an id of its own that no pi-ai provider or account has", () => {
		expect(customId("LM Studio", new Set())).toBe("custom-lm-studio");
		expect(customId("LM Studio", new Set(["custom-lm-studio"]))).toBe("custom-lm-studio-2");
		expect(customId("🦙", new Set())).toBe("custom-provider");
	});
});

describe("the file", () => {
	it("one that does not fit registers no provider, and says why", async () => {
		const home = await tempHome();
		await writeFile(customProvidersPath(home), JSON.stringify({ providers: [{ id: "custom-x", name: "X" }] }));
		await expect(readCustomProviders(home)).rejects.toThrow(/does not fit its schema/);
		const models = createModels();
		const { error } = await registerCustomProviders(models, home);
		expect(error).toMatch(/does not fit its schema/);
		expect(models.getProvider("custom-x")).toBeUndefined();
		// one that fits the schema but breaks a rule is refused too: plain http to the internet
		await writeFile(
			customProvidersPath(home),
			JSON.stringify({ providers: [definition("http://api.example.com/v1")] }),
		);
		expect((await registerCustomProviders(models, home)).error).toMatch(/baseUrl: Use https/);
	});
});

describe("a request to the endpoint", () => {
	it("a keyless provider sends no Authorization header, banda's conservative fields and no others", async () => {
		const server = await serve();
		const models = createModels();
		models.setProvider(customProvider(definition(server.url)));
		const answer = await models.completeSimple(models.getModel("custom-local", "small")!, {
			systemPrompt: "be brief",
			...ask(),
		});
		expect(answer.stopReason).toBe("stop");
		expect(answer.content).toEqual([{ type: "text", text: "OK from small" }]);
		const [request] = server.requests;
		expect(request?.headers.authorization).toBeUndefined();
		expect(request?.body).toMatchObject({ model: "small", stream: true, max_tokens: expect.any(Number) });
		expect(request?.body).not.toHaveProperty("store");
		expect(request?.body).not.toHaveProperty("max_completion_tokens");
		expect((request?.body?.messages as { role: string }[] | undefined)?.[0]?.role).toBe("system");
	});

	it("the owner's compatibility choices change the fields it sends", async () => {
		const server = await serve();
		const models = createModels();
		models.setProvider(
			customProvider(
				definition(server.url, {
					models: [model("thinker", { reasoning: true })],
					compat: {
						instructions: "developer",
						maxTokensField: "max_completion_tokens",
						store: true,
						reasoningEffort: true,
					},
				}),
			),
		);
		await models.completeSimple(
			models.getModel("custom-local", "thinker")!,
			{ systemPrompt: "x", ...ask() },
			{ reasoning: "low" },
		);
		const body = server.requests[0]?.body;
		expect(body).toMatchObject({ store: false, max_completion_tokens: expect.any(Number), reasoning_effort: "low" });
		expect((body?.messages as { role: string }[] | undefined)?.[0]?.role).toBe("developer");
	});

	it("a keyed provider sends only the key stored for it, never one from the environment", async () => {
		const home = await tempHome();
		const server = await serve({ key: "sk-local-secret-123456" });
		const credentials = new FileCredentialStore(home);
		const models = createModels({
			credentials,
			authContext: { env: async () => "sk-from-the-environment", fileExists: async () => false },
		});
		models.setProvider(customProvider(definition(server.url, { key: "required" })));
		expect(await models.checkAuth("custom-local")).toBeUndefined();
		await credentials.modify("custom-local", async () => ({ type: "api_key", key: "sk-local-secret-123456" }));
		const answer = await models.completeSimple(models.getModel("custom-local", "small")!, ask());
		expect(answer.stopReason).toBe("stop");
		expect(server.requests[0]?.headers.authorization).toBe("Bearer sk-local-secret-123456");
	});

	it("a redirect is refused once, not followed, so neither prompt nor key goes elsewhere", async () => {
		const elsewhere = await serve();
		const server = await serve({ redirect: `${elsewhere.url}/chat/completions` });
		const models = createModels();
		models.setProvider(customProvider(definition(server.url)));
		const answer = await models.completeSimple(models.getModel("custom-local", "small")!, ask());
		expect(answer.stopReason).toBe("error");
		expect(answer.errorMessage).toMatch(/redirects \(307\).*does not follow/);
		expect(server.requests).toHaveLength(1);
		expect(elsewhere.requests).toHaveLength(0);
	});

	it("an error that echoes the key is told without it", async () => {
		const home = await tempHome();
		const server = await serve({ key: "sk-the-right-one-000000" });
		const credentials = new FileCredentialStore(home);
		const models = createModels({ credentials });
		models.setProvider(customProvider(definition(server.url, { key: "required" })));
		await credentials.modify("custom-local", async () => ({ type: "api_key", key: "sk-wrong-key-abcdef123" }));
		const answer = await models.completeSimple(models.getModel("custom-local", "small")!, ask());
		expect(answer.stopReason).toBe("error");
		expect(answer.errorMessage).toMatch(/401/);
		expect(answer.errorMessage).not.toContain("sk-wrong-key-abcdef123");
		expect(answer.errorMessage).not.toContain("abcdef123");
		expect(redact("Bearer abc.def and sk-1234567890abcdef", ["zzzz"])).toBe("Bearer [key] and [key]");
	});
});

describe("the tiers", () => {
	const CONFIGURED: ModelRef = { provider: "anthropic", modelId: "claude-opus-5-5" };

	it("a custom provider runs the owner's model for each tier, the same one on several if they say so", () => {
		const choice = {
			provider: "custom-local",
			overrides: { "custom-local": { quick: "small", balanced: "small", deep: "large" } },
		};
		expect(TIERS.map((tier) => modelFor(tier, choice, CONFIGURED).modelId)).toEqual(["small", "small", "large"]);
	});

	it("a custom provider's tier without a model names none: it never runs on the configured model instead", () => {
		for (const tier of TIERS)
			expect(modelFor(tier, { provider: "custom-gone" }, CONFIGURED)).toEqual({ provider: "custom-gone", modelId: "" });
	});
});

describe("the daemon", () => {
	async function start(home: string) {
		const credentials = new FileCredentialStore(home);
		const daemon = await startDaemon({
			home,
			port: 0,
			models: createModels({ credentials }),
			log: () => {},
			box: hostBox(home),
		});
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
		const refused = async (path: string, init: RequestInit) => {
			const response = await call(path, init);
			return { status: response.status, error: ((await response.json()) as { error?: string }).error ?? "" };
		};
		const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
		return { daemon, api, refused, json };
	}
	const body = (baseUrl: string, more: Partial<CustomProvider> = {}) => {
		const { id: _, ...rest } = definition(baseUrl, more);
		return rest;
	};
	const TIERS_ON = { quick: "small", balanced: "small", deep: "large" };

	it("adds a keyless provider without reaching it, answers a chat on it, and resumes on it after a restart", async () => {
		const home = await tempHome();
		const server = await serve();
		let s = await start(home);
		try {
			const { id } = await s.api<{ id: string }>(
				"/custom-providers",
				s.json("POST", { provider: body(server.url), tiers: TIERS_ON, use: true }),
			);
			expect(id).toBe("custom-local");
			// saving is not a check: nothing was sent
			expect(server.requests).toHaveLength(0);
			expect((await stat(customProvidersPath(home))).mode & 0o777).toBe(0o600);
			const view = await s.api<CustomProvidersView>("/custom-providers");
			expect(view.providers[0]).toMatchObject({
				id,
				key: "none",
				using: true,
				tiers: TIERS_ON,
				destination: { place: "computer" },
			});
			const tiers = await s.api<TiersView>("/tiers");
			expect(tiers.provider).toMatchObject({ id, name: "Local", local: true });
			expect(tiers.models.quick.id).toBe("small");
			expect(tiers.models.deep.id).toBe("large");
			expect(tiers.catalog.map((each) => each.id)).toEqual(["small", "large"]);
			const thread = randomUUID();
			await s.api("/messages", s.json("POST", { id: randomUUID(), thread, text: "hello" }));
			await until(() => server.requests.some((request) => request.path.endsWith("/chat/completions")));
			expect(server.requests.at(-1)?.body?.model).toBe("small");
			// the turn ends on it: nothing ran on another provider
			await until(async () => (await s.api<ChatRow[]>("/chats")).some((row) => row.state === "idle"));
			expect(server.requests.every((request) => request.body?.model === "small")).toBe(true);
		} finally {
			await s.daemon.close();
		}
		const before = server.requests.length;
		s = await start(home);
		try {
			// registered before the store opened: the chat answers on it again
			expect((await s.api<TiersView>("/tiers")).provider.id).toBe("custom-local");
			const [row] = await s.api<ChatRow[]>("/chats");
			await s.api("/messages", s.json("POST", { id: randomUUID(), thread: row!.origin.thread, text: "again" }));
			await until(() => server.requests.length > before);
			expect(server.requests.at(-1)?.body?.model).toBe("small");
		} finally {
			await s.daemon.close();
		}
	});

	it("a turn in flight on it when the daemon stops resumes on it after the restart", async () => {
		const home = await tempHome();
		const server = await serve({ delayMs: 60_000 });
		let s = await start(home);
		try {
			await s.api("/custom-providers", s.json("POST", { provider: body(server.url), tiers: TIERS_ON, use: true }));
			await s.api("/messages", s.json("POST", { id: randomUUID(), thread: randomUUID(), text: "slow one" }));
			await until(() => server.requests.some((request) => request.path.endsWith("/chat/completions")));
		} finally {
			await s.daemon.close();
		}
		const before = server.requests.length;
		server.set({ delayMs: 0 });
		s = await start(home);
		try {
			// the provider is registered before the store resumes the turn: its request goes to the same model again
			await until(() => server.requests.length > before);
			expect(server.requests.at(-1)?.body?.model).toBe("small");
			await until(async () => (await s.api<ChatRow[]>("/chats")).every((row) => row.state === "idle"));
		} finally {
			await s.daemon.close();
		}
	});

	it("a definition whose tiers were never committed (a crash between the two) is listed, never offered, until edited", async () => {
		const home = await tempHome();
		const server = await serve();
		await writeFile(customProvidersPath(home), JSON.stringify({ providers: [definition(server.url)] }));
		const s = await start(home);
		try {
			expect((await s.api<CustomProvidersView>("/custom-providers")).providers[0]).toMatchObject({
				id: "custom-local",
				tiers: {},
				using: false,
			});
			expect((await s.api<TiersView>("/tiers")).providers.map((each) => each.id)).not.toContain("custom-local");
			const refused = await s.refused("/tiers", s.json("PUT", { provider: "custom-local" }));
			expect(refused.status).toBe(400);
			await s.api("/custom-providers/custom-local", s.json("PUT", { provider: body(server.url), tiers: TIERS_ON }));
			await s.api("/tiers", s.json("PUT", { provider: "custom-local" }));
			expect((await s.api<TiersView>("/tiers")).models.deep.id).toBe("large");
			expect(server.requests).toHaveLength(0);
		} finally {
			await s.daemon.close();
		}
	});

	it("keeps a key in the credentials alone, and never shows it", async () => {
		const home = await tempHome();
		const server = await serve({ key: "sk-hosted-key-7777777" });
		const s = await start(home);
		try {
			const missing = await s.refused(
				"/custom-providers",
				s.json("POST", { provider: body(server.url, { key: "required" }), tiers: TIERS_ON }),
			);
			expect(missing).toEqual({ status: 400, error: "Give its key, or say it needs none" });
			await s.api(
				"/custom-providers",
				s.json("POST", {
					provider: body(server.url, { key: "required" }),
					tiers: TIERS_ON,
					key: "sk-hosted-key-7777777",
				}),
			);
			expect(await readFile(customProvidersPath(home), "utf8")).not.toContain("sk-hosted");
			expect(JSON.stringify(await s.api("/custom-providers"))).not.toContain("sk-hosted");
			expect(await new FileCredentialStore(home).read("custom-local")).toEqual({
				type: "api_key",
				key: "sk-hosted-key-7777777",
			});
			expect((await s.api<CustomProvidersView>("/custom-providers")).providers[0]?.key).toBe("stored");
			// a new address does not take the old key along
			const moved = await s.refused(
				"/custom-providers/custom-local",
				s.json("PUT", { provider: body("http://127.0.0.1:9/v1", { key: "required" }), tiers: TIERS_ON }),
			);
			expect(moved).toEqual({ status: 409, error: "The address changed: give the key again, for the new address" });
			expect(server.requests).toHaveLength(0);
		} finally {
			await s.daemon.close();
		}
	});

	it("a check is one request the owner asks for, and says what went wrong without the key", async () => {
		const home = await tempHome();
		const server = await serve();
		const s = await start(home);
		try {
			await s.api("/custom-providers", s.json("POST", { provider: body(server.url), tiers: TIERS_ON }));
			const ok = await s.api<Checked>("/custom-providers/custom-local/check", s.json("POST", {}));
			expect(ok).toMatchObject({ ok: true, model: "small", reply: "OK from small" });
			expect(server.requests).toHaveLength(1);
			server.set({ fail: { status: 500, message: "model crashed; token sk-leaky-abcdefghijkl" } });
			const failed = await s.api<Checked>("/custom-providers/custom-local/check", s.json("POST", { model: "large" }));
			expect(failed).toMatchObject({ ok: false, model: "large" });
			// a failed check is not retried: still one request each
			expect(server.requests).toHaveLength(2);
			expect(failed.ok ? "" : failed.why).toMatch(/500.*model crashed/);
			expect(failed.ok ? "" : failed.why).not.toContain("sk-leaky");
			expect((await s.api<CustomProvidersView>("/custom-providers")).providers[0]?.checked).toMatchObject({
				ok: false,
			});
		} finally {
			await s.daemon.close();
		}
	});

	it("refuses to remove a provider, or a model of it, while something runs on it, until the owner moves it", async () => {
		const home = await tempHome();
		const server = await serve();
		const s = await start(home);
		try {
			await s.api("/custom-providers", s.json("POST", { provider: body(server.url), tiers: TIERS_ON, use: true }));
			const inUse = await s.refused("/custom-providers/custom-local", { method: "DELETE" });
			expect(inUse.status).toBe(409);
			expect(inUse.error).toMatch(/The band thinks with it: use another provider first/);
			// a second one, and the band moves to it
			await s.api(
				"/custom-providers",
				s.json("POST", {
					provider: { ...body(server.url), name: "Other" },
					tiers: TIERS_ON,
					use: true,
				}),
			);
			expect((await s.api<TiersView>("/tiers")).provider.id).toBe("custom-other");
			// an agent's file names a model of the first: it stays until the file names another
			const named = "---\ndescription: writes\nmodel: custom-local/large\n---\nWrite.\n";
			await s.api("/agents/scribe", s.json("PUT", { text: named, base: null }));
			const byFile = await s.refused("/custom-providers/custom-local", { method: "DELETE" });
			expect(byFile.status).toBe(409);
			expect(byFile.error).toMatch(/scribe's file names large: change its model first/i);
			const moved = "---\ndescription: writes\nmodel: custom-other/small\n---\nWrite.\n";
			await s.api("/agents/scribe", s.json("PUT", { text: moved, base: shaOf(named) }));
			await s.api("/custom-providers/custom-local", { method: "DELETE" });
			expect(await new FileCredentialStore(home).read("custom-local")).toBeUndefined();
			expect((await s.api<TiersView>("/tiers")).providers.map((each) => each.id)).not.toContain("custom-local");
			expect((await s.api<CustomProvidersView>("/custom-providers")).providers.map((each) => each.id)).toEqual([
				"custom-other",
			]);
			// removing a model a tier runs on is refused unless the same change moves the tier
			const kept = await s.refused(
				"/custom-providers/custom-other",
				s.json("PUT", {
					provider: { ...body(server.url, { models: [model("small")] }), name: "Other" },
					tiers: TIERS_ON,
				}),
			);
			expect(kept).toEqual({ status: 400, error: "Pick one of its models for Deep" });
			await s.api(
				"/custom-providers/custom-other",
				s.json("PUT", {
					provider: { ...body(server.url, { models: [model("small")] }), name: "Other" },
					tiers: { quick: "small", balanced: "small", deep: "small" },
				}),
			);
			expect((await s.api<TiersView>("/tiers")).models.deep.id).toBe("small");
			expect(server.requests).toHaveLength(0);
		} finally {
			await s.daemon.close();
		}
	});
});
