/**
 * Custom providers: an OpenAI-compatible endpoint the owner defines, with models declared by hand, against a scripted
 * server on loopback (`./fixtures/compat-server.ts`), never a live one. The address rules, the definition's file, what
 * a request to the endpoint carries, the tiers that never fall back to another provider's model, and the daemon's API:
 * adding one without a network call, a chat answered by it, a restart that resumes on it, an edit or removal refused
 * while something runs on it, and a check the owner asks for.
 */
import { randomUUID } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { createModels } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { shaOf } from "../src/core/agents.ts";
import {
	customProvider,
	customProvidersPath,
	guardedFetch,
	readCustomProviders,
	redact,
	registerCustomProviders,
} from "../src/core/custom-provider.ts";
import {
	type CustomProvider,
	checkFailure,
	customId,
	destinationOf,
	problemsOf,
} from "../src/core/custom-providers.ts";
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
	source: { listed: false, limits: "owner" as const },
	...more,
});
const definition = (baseUrl: string, more: Partial<CustomProvider> = {}): CustomProvider => ({
	id: "custom-local",
	name: "Local",
	kind: "openai",
	baseUrl,
	key: "none",
	billing: "none",
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
		["http://metadata.google.internal/v1", /metadata service/],
		["http://100.100.100.200/v1", /metadata service/],
		["http://[fd00:ec2::254]/v1", /metadata service/],
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
				kind: "openai",
				baseUrl: "http://example.com/v1",
				key: "none",
				billing: "none",
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

	it("asks for a model's limits and, when it charges per token, its rates, rather than guessing them", () => {
		const messages = problemsOf({
			...definition("http://localhost:1/v1"),
			billing: "rates",
			models: [
				model("m", { contextWindow: Number.NaN, maxTokens: Number.NaN, cost: { input: Number.NaN, output: 0 } }),
			],
		}).map((problem) => `${problem.field}: ${problem.message}`);
		expect(messages).toEqual([
			"models.0.contextWindow: Write its context window in tokens, as its server or model card says",
			"models.0.maxTokens: Write how many tokens banda may ask for in one answer (sent as max_tokens), within what the server allows",
			"models.0.cost.input: Write what it charges per million tokens, as its provider bills it",
		]);
		// a model of a server that charges none has no price at all, never a 0 standing in for one
		expect(
			problemsOf({
				...definition("http://localhost:1/v1"),
				models: [model("m", { cost: { input: 0, output: 0 } })],
			})[0],
		).toMatchObject({ field: "models.0.cost.input" });
		expect(problemsOf({ ...definition("http://localhost:1/v1"), billing: undefined as never })[0]).toMatchObject({
			field: "billing",
		});
		// compatibility settings only for chat completions
		expect(
			problemsOf({ ...definition("https://a.example/v1"), kind: "anthropic", compat: { store: true } })[0],
		).toMatchObject({ field: "compat" });
	});

	it("gets an id of its own that no pi-ai provider or account has", () => {
		expect(customId("LM Studio", new Set())).toBe("custom-lm-studio");
		expect(customId("LM Studio", new Set(["custom-lm-studio"]))).toBe("custom-lm-studio-2");
		expect(customId("🦙", new Set())).toBe("custom-provider");
	});
});

describe("a failed check", () => {
	it.each([
		[true, { status: 500 }, "timeout"],
		[false, { code: "ECONNREFUSED" }, "unreachable"],
		[false, { code: "ENOTFOUND" }, "unknown-host"],
		[false, { code: "CERT_HAS_EXPIRED" }, "certificate"],
		[false, { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }, "certificate"],
		[false, { status: 307 }, "redirect"],
		[false, { status: 401 }, "auth"],
		[false, { status: 403 }, "auth"],
		[false, { status: 404 }, "not-found"],
		[false, { status: 422 }, "rejected"],
		[false, { status: 429 }, "limited"],
		[false, { status: 503 }, "server"],
		[false, { status: 200 }, "unreadable"],
		[false, undefined, "other"],
	] as const)("timed out %s, showing %j, is %s", (timedOut, observed, failure) => {
		expect(checkFailure(timedOut, observed)).toBe(failure);
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

	it("plain http goes only where the name resolves now to this computer or the owner's network", async () => {
		const sent: string[] = [];
		const base = (async (input: string | URL | Request) => {
			sent.push(String(input));
			return new Response("{}");
		}) as typeof fetch;
		const at = (address: string) => async () => [{ address, family: address.includes(":") ? 6 : 4 }];
		// a one-word name looks local; where it resolves decides
		const outside = await guardedFetch({ key: "none" }, base, at("203.0.113.9"))("http://gpu-box:8000/v1/models");
		expect(outside.status).toBe(421);
		expect(((await outside.json()) as { error: { message: string } }).error.message).toMatch(/on the internet/);
		const metadata = await guardedFetch({ key: "none" }, base, at("169.254.169.254"))("http://gpu-box/v1/models");
		expect(((await metadata.json()) as { error: { message: string } }).error.message).toMatch(/link-local/);
		expect(sent).toEqual([]);
		await guardedFetch({ key: "none" }, base, at("192.168.1.20"))("http://gpu-box:8000/v1/models");
		// https is the certificate's to vouch for: never looked up
		const never = async () => {
			throw new Error("looked up");
		};
		await guardedFetch({ key: "none" }, base, never)("https://llm.example.com/v1/models");
		expect(sent).toEqual(["http://gpu-box:8000/v1/models", "https://llm.example.com/v1/models"]);
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
				s.json("POST", { provider: body(server.url), start: "small" }),
			);
			expect(id).toBe("custom-local");
			// saving is not a check: nothing was sent
			expect(server.requests).toHaveLength(0);
			expect((await stat(customProvidersPath(home))).mode & 0o777).toBe(0o600);
			const view = await s.api<CustomProvidersView>("/custom-providers");
			// saved, started on one model for every tier, and not used until the owner says so
			expect(view.providers[0]).toMatchObject({
				id,
				key: "none",
				billing: "none",
				using: false,
				tiers: { quick: "small", balanced: "small", deep: "small" },
				destination: { place: "computer" },
			});
			expect((await s.api<TiersView>("/tiers")).provider.id).not.toBe(id);
			await s.api("/tiers", s.json("PUT", { provider: id }));
			await s.api("/tiers", s.json("PUT", { override: { tier: "deep", modelId: "large" } }));
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
			await s.api("/custom-providers", s.json("POST", { provider: body(server.url), start: "small" }));
			await s.api("/tiers", s.json("PUT", { provider: "custom-local" }));
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

	it("an edit whose file can't be written changes nothing: not the tiers, not the key", async () => {
		const home = await tempHome();
		const server = await serve({ key: "sk-first-key-1111111" });
		const s = await start(home);
		try {
			const provider = body(server.url, { key: "required" });
			await s.api("/custom-providers", s.json("POST", { provider, start: "small", key: "sk-first-key-1111111" }));
			await s.api("/custom-providers/custom-local", s.json("PUT", { provider, tiers: TIERS_ON }));
			// the file is written beside itself and renamed into place: a home that takes no new file fails the write
			await chmod(home, 0o500);
			const refused = await s.refused(
				"/custom-providers/custom-local",
				s.json("PUT", {
					provider,
					tiers: { quick: "large", balanced: "large", deep: "large" },
					key: "sk-second-key-2222222",
				}),
			);
			await chmod(home, 0o700);
			expect(refused.status).toBeGreaterThanOrEqual(400);
			const view = await s.api<CustomProvidersView>("/custom-providers");
			expect(view.providers[0]?.tiers).toEqual(TIERS_ON);
			expect(await new FileCredentialStore(home).read("custom-local")).toEqual({
				type: "api_key",
				key: "sk-first-key-1111111",
			});
		} finally {
			await chmod(home, 0o700);
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
				s.json("POST", { provider: body(server.url, { key: "required" }), start: "small" }),
			);
			expect(missing).toEqual({ status: 400, error: "Give its key, or say it needs none" });
			await s.api(
				"/custom-providers",
				s.json("POST", {
					provider: body(server.url, { key: "required" }),
					start: "small",
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
			await s.api("/custom-providers", s.json("POST", { provider: body(server.url), start: "small" }));
			const ok = await s.api<Checked>("/custom-providers/custom-local/check", s.json("POST", {}));
			expect(ok).toMatchObject({ ok: true, model: "small", reply: "OK from small" });
			expect(server.requests).toHaveLength(1);
			server.set({ fail: { status: 500, message: "model crashed; token sk-leaky-abcdefghijkl" } });
			const failed = await s.api<Checked>("/custom-providers/custom-local/check", s.json("POST", { model: "large" }));
			expect(failed).toMatchObject({ ok: false, model: "large", failure: "server", status: 500 });
			// a failed check is not retried: still one request each
			expect(server.requests).toHaveLength(2);
			expect(failed.ok ? "" : failed.detail).toMatch(/500.*model crashed/);
			expect(failed.ok ? "" : failed.detail).not.toContain("sk-leaky");
			expect((await s.api<CustomProvidersView>("/custom-providers")).providers[0]?.checked).toMatchObject({
				ok: false,
			});
		} finally {
			await s.daemon.close();
		}
	});

	it("a failed check says why from the request itself: its status, or the network's error", async () => {
		const home = await tempHome();
		const server = await serve({ key: "sk-right-key-0000000000" });
		const closed = await serve();
		const nowhere = closed.url;
		await closed.close();
		servers.splice(servers.indexOf(closed), 1);
		const s = await start(home);
		const check = async (id: string) => s.api<Checked>(`/custom-providers/${id}/check`, s.json("POST", {}));
		const add = (name: string, baseUrl: string, more: Partial<CustomProvider> = {}, key?: string) =>
			s.api(
				"/custom-providers",
				s.json("POST", { provider: { ...body(baseUrl, more), name }, start: "small", ...(key ? { key } : {}) }),
			);
		try {
			await add("Wrong key", server.url, { key: "required" }, "sk-wrong-key-1111111111");
			expect(await check("custom-wrong-key")).toMatchObject({ ok: false, failure: "auth", status: 401 });
			await add("Wrong path", server.url.replace(/\/v1$/, "/v2"), { key: "required" }, "sk-right-key-0000000000");
			expect(await check("custom-wrong-path")).toMatchObject({ ok: false, failure: "not-found", status: 404 });
			await add("Nothing there", nowhere);
			expect(await check("custom-nothing-there")).toMatchObject({ ok: false, failure: "unreachable" });
			server.set({ key: undefined, refuses: ["max_tokens"] });
			await add("Strict", server.url);
			expect(await check("custom-strict")).toMatchObject({ ok: false, failure: "rejected", status: 400 });
			server.set({ refuses: [], redirect: "http://127.0.0.1:9/v1/chat/completions" });
			expect(await check("custom-strict")).toMatchObject({ ok: false, failure: "redirect" });
			server.set({ redirect: undefined, fail: { status: 429, message: "slow down" } });
			expect(await check("custom-strict")).toMatchObject({ ok: false, failure: "limited", status: 429 });
		} finally {
			await s.daemon.close();
		}
	});

	it("counts cost only as the owner says it is billed: no per-token charge, or its rates, never a silent 0", async () => {
		const home = await tempHome();
		const server = await serve();
		const s = await start(home);
		try {
			const { billing: _, ...unsaid } = body(server.url);
			expect(await s.refused("/custom-providers", s.json("POST", { provider: unsaid, start: "small" }))).toEqual({
				status: 400,
				error: 'provider.billing says whether it charges per token: "none" or "rates"',
			});
			expect(
				await s.refused(
					"/custom-providers",
					s.json("POST", { provider: { ...body(server.url), billing: "rates" }, start: "small" }),
				),
			).toEqual({ status: 400, error: "provider.models.0.cost is what it charges per million tokens in and out" });
			const priced = {
				...body(server.url),
				billing: "rates",
				models: [model("small", { cost: { input: 0.25, output: 1 } })],
			};
			await s.api("/custom-providers", s.json("POST", { provider: priced, start: "small" }));
			const kept = (await s.api<CustomProvidersView>("/custom-providers")).providers[0];
			expect(kept).toMatchObject({ billing: "rates", models: [{ id: "small", cost: { input: 0.25, output: 1 } }] });
		} finally {
			await s.daemon.close();
		}
	});

	it("refuses to remove a provider, or a model of it, while something runs on it, until the owner moves it", async () => {
		const home = await tempHome();
		const server = await serve();
		const s = await start(home);
		try {
			await s.api("/custom-providers", s.json("POST", { provider: body(server.url), start: "small" }));
			await s.api("/tiers", s.json("PUT", { provider: "custom-local" }));
			const inUse = await s.refused("/custom-providers/custom-local", { method: "DELETE" });
			expect(inUse.status).toBe(409);
			expect(inUse.error).toMatch(/The band thinks with it: use another provider first/);
			// a second one, and the band moves to it
			await s.api(
				"/custom-providers",
				s.json("POST", {
					provider: { ...body(server.url), name: "Other" },
					start: "small",
				}),
			);
			await s.api("/tiers", s.json("PUT", { provider: "custom-other" }));
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
					tiers: { quick: "small", balanced: "small", deep: "large" },
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
