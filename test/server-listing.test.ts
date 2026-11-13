/**
 * A server's list of models, read through the daemon when the owner asks, against the scripted server answering each
 * route as its documentation shows (`./fixtures/compat-server.ts`): what each reader keeps, that nothing is guessed,
 * that a model of pi-ai's catalog with the same id is offered and never taken, what a failed listing says, and that a
 * listing asks no model to answer. Then each of pi-ai's adapters a server may speak, through the same guard: a keyless
 * one sends no key in any header, a redirect is refused.
 */
import { createModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it } from "vitest";
import { customProvider } from "../src/core/custom-provider.ts";
import type { CustomProvider, ServerKind } from "../src/core/custom-providers.ts";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ListingView } from "../src/server/api.ts";
import { type CompatOptions, type CompatServer, compatServer } from "./fixtures/compat-server.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome } from "./helpers.ts";

const servers: CompatServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});
const serve = async (options: CompatOptions = {}) => {
	const server = await compatServer(options);
	servers.push(server);
	return server;
};
const nowhere = { env: async () => undefined, fileExists: async () => false };

async function daemon() {
	const home = await tempHome();
	const models = builtinModels({ credentials: new FileCredentialStore(home), authContext: nowhere });
	const running = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home) });
	const token = (await readDaemonFile(home))!.token!;
	const list = async (provider: { kind: ServerKind; baseUrl: string; key: "none" | "required" }, key?: string) => {
		const response = await fetch(`http://127.0.0.1:${running.port}/api/custom-providers/list`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify({ provider, ...(key === undefined ? {} : { key }) }),
		});
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
		return (await response.json()) as ListingView;
	};
	return { running, list, token };
}

const root = (server: CompatServer) => server.url.replace(/\/v1$/, "");
const posts = (server: CompatServer) => server.requests.filter((request) => request.method === "POST");

describe("a listing", () => {
	it("reads each documented route, keeps what it says, and guesses nothing", async () => {
		const { running, list } = await daemon();
		try {
			const ollama = await serve({
				models: [
					{ id: "qwen3:8b", context: 40_960 },
					{ id: "llava:7b", context: 4096, vision: true },
					{ id: "nomic-embed-text", embedding: true },
				],
			});
			expect(await list({ kind: "ollama", baseUrl: ollama.url, key: "none" })).toEqual({
				ok: true,
				routes: ["GET /api/tags", "POST /api/show"],
				models: [
					{ id: "qwen3:8b", contextWindow: 40_960, images: false },
					{ id: "llava:7b", contextWindow: 4096, images: true },
					{ id: "nomic-embed-text", images: false, chats: false },
				],
			});
			// /api/show describes a model; it does not run one
			expect(posts(ollama).every((request) => request.path === "/api/show")).toBe(true);

			const lmstudio = await serve({
				models: [
					{ id: "gemma-4-e4b", context: 131_072, vision: true },
					{ id: "text-embedding-x", embedding: true },
				],
			});
			expect(await list({ kind: "lmstudio", baseUrl: lmstudio.url, key: "none" })).toEqual({
				ok: true,
				routes: ["GET /api/v0/models"],
				models: [
					{ id: "gemma-4-e4b", contextWindow: 131_072, images: true },
					{ id: "text-embedding-x", images: false, chats: false },
				],
			});

			const llamacpp = await serve({ models: [{ id: "model.gguf", context: 8192 }] });
			expect(await list({ kind: "llamacpp", baseUrl: llamacpp.url, key: "none" })).toEqual({
				ok: true,
				routes: ["GET /models", "GET /props"],
				models: [{ id: "model.gguf", contextWindow: 8192 }],
			});

			// OpenAI's own shape names ids alone: nothing else is taken from it
			const vllm = await serve({ models: [{ id: "Qwen/Qwen3-8B", context: 32_768 }] });
			// (pi-ai's catalog has a model of that id: offered beside it, not taken)
			const listed = await list({ kind: "vllm", baseUrl: vllm.url, key: "none" });
			expect(listed).toMatchObject({ ok: true, routes: ["GET /models"] });
			const [qwen] = listed.ok ? listed.models : [];
			expect(qwen).toEqual({ id: "Qwen/Qwen3-8B", catalog: expect.objectContaining({ ref: expect.any(String) }) });

			const anthropic = await serve({
				flavor: "anthropic",
				key: "sk-ant-scripted-0000",
				models: [
					{
						id: "relay-model",
						displayName: "Relay Model",
						context: 200_000,
						maxTokens: 64_000,
						vision: true,
						thinking: true,
					},
				],
			});
			expect(
				await list({ kind: "anthropic", baseUrl: root(anthropic), key: "required" }, "sk-ant-scripted-0000"),
			).toEqual({
				ok: true,
				routes: ["GET /v1/models"],
				models: [
					{
						id: "relay-model",
						name: "Relay Model",
						contextWindow: 200_000,
						maxTokens: 64_000,
						images: true,
						reasoning: true,
					},
				],
			});
			expect(anthropic.requests[0]?.headers["x-api-key"]).toBe("sk-ant-scripted-0000");
			expect(anthropic.requests[0]?.headers["anthropic-version"]).toBe("2023-06-01");

			const mistral = await serve({
				flavor: "mistral",
				models: [
					{ id: "mistral-small-local", context: 65_536, vision: true },
					{ id: "embed-local", embedding: true },
				],
			});
			const read = await list({ kind: "mistral", baseUrl: root(mistral), key: "none" });
			expect(read).toMatchObject({
				ok: true,
				models: [
					{ id: "mistral-small-local", contextWindow: 65_536, images: true },
					{ id: "embed-local", chats: false },
				],
			});
			// keyless: no key in any header
			for (const server of [ollama, lmstudio, llamacpp, vllm, mistral])
				for (const request of server.requests) {
					expect(request.headers.authorization).toBeUndefined();
					expect(request.headers["x-api-key"]).toBeUndefined();
				}
		} finally {
			await running.close();
		}
	});

	it("offers pi-ai's limits for a model of the same id, never its price, and takes nothing on its word", async () => {
		const { running, list } = await daemon();
		try {
			const server = await serve({ models: ["claude-haiku-5-5", "my-own-finetune"] });
			const read = await list({ kind: "openai", baseUrl: server.url, key: "none" });
			if (!read.ok) throw new Error(read.detail);
			const [known, own] = read.models;
			// offered beside it, the listed model itself still says only what the server said
			expect(known).toMatchObject({
				id: "claude-haiku-5-5",
				catalog: { ref: expect.stringMatching(/claude-haiku-5-5$/) },
			});
			expect(known).not.toHaveProperty("contextWindow");
			expect(known?.catalog).not.toHaveProperty("cost");
			expect(own).toEqual({ id: "my-own-finetune" });
		} finally {
			await running.close();
		}
	});

	it("says why it failed from the request: a refused key, nothing there, a redirect, an answer that is no list", async () => {
		const { running, list, token } = await daemon();
		try {
			const keyed = await serve({ key: "sk-right-0000000000" });
			expect(await list({ kind: "openai", baseUrl: keyed.url, key: "required" }, "sk-wrong-1111111111")).toMatchObject({
				ok: false,
				failure: "auth",
				status: 401,
			});
			const failed = await list({ kind: "openai", baseUrl: keyed.url, key: "required" }, "sk-wrong-1111111111");
			expect(failed.ok ? "" : failed.detail).not.toContain("sk-wrong-1111111111");

			const gone = await serve();
			const nowhereUrl = gone.url;
			await gone.close();
			servers.splice(servers.indexOf(gone), 1);
			expect(await list({ kind: "ollama", baseUrl: nowhereUrl, key: "none" })).toMatchObject({
				ok: false,
				failure: "unreachable",
			});

			// a listing that redirects is refused, and nothing reaches where it pointed
			const elsewhere = await serve();
			const moved = await serve({ redirect: `${elsewhere.url}/models` });
			expect(await list({ kind: "openai", baseUrl: moved.url, key: "none" })).toMatchObject({
				ok: false,
				failure: "redirect",
			});
			expect(moved.requests).toHaveLength(1);
			expect(elsewhere.requests).toHaveLength(0);

			// an answer that is not the list its kind documents
			const other = await serve({ flavor: "mistral" });
			expect(await list({ kind: "openai", baseUrl: other.url, key: "none" })).toMatchObject({
				ok: false,
				failure: "unreadable",
			});
			// a keyed one is not listed without its key
			const unkeyed = await fetch(`http://127.0.0.1:${running.port}/api/custom-providers/list`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify({ provider: { kind: "openai", baseUrl: keyed.url, key: "required" } }),
			});
			expect(unkeyed.status).toBe(400);
		} finally {
			await running.close();
		}
	});
});

describe("each adapter a server may speak", () => {
	const definition = (kind: ServerKind, baseUrl: string, key: "none" | "required"): CustomProvider => ({
		id: "custom-relay",
		name: "Relay",
		kind,
		baseUrl,
		key,
		billing: "none",
		models: [
			{
				id: "m",
				images: false,
				reasoning: false,
				contextWindow: 32_768,
				maxTokens: 1024,
				source: { listed: true, limits: "owner" },
			},
		],
	});
	const ask = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };

	it("Anthropic's answers through the guard, with no key header when keyless and its own when keyed", async () => {
		const server = await serve();
		const models = createModels();
		models.setProvider(customProvider(definition("anthropic", root(server), "none")));
		const answer = await models.completeSimple(models.getModel("custom-relay", "m")!, ask);
		expect(answer.stopReason).toBe("stop");
		expect(answer.content).toEqual([{ type: "text", text: "OK from m" }]);
		expect(server.requests[0]?.path).toBe("/v1/messages");
		expect(server.requests[0]?.headers["x-api-key"]).toBeUndefined();
		expect(server.requests[0]?.headers.authorization).toBeUndefined();

		const keyed = await serve({ key: "sk-relay-key-0000000" });
		const home = await tempHome();
		const credentials = new FileCredentialStore(home);
		await credentials.modify("custom-relay", async () => ({ type: "api_key", key: "sk-relay-key-0000000" }));
		const withKey = createModels({ credentials });
		withKey.setProvider(customProvider(definition("anthropic", root(keyed), "required")));
		expect((await withKey.completeSimple(withKey.getModel("custom-relay", "m")!, ask)).stopReason).toBe("stop");
		expect(keyed.requests[0]?.headers["x-api-key"]).toBe("sk-relay-key-0000000");
	});

	it.each([
		["openai", "/v1/chat/completions"],
		["openai-responses", "/v1/responses"],
		["anthropic", "/v1/messages"],
		["mistral", "/v1/chat/completions"],
	] as const)("%s refuses a redirect once, and nothing reaches where it pointed", async (kind, path) => {
		const elsewhere = await serve();
		const server = await serve({ redirect: `${elsewhere.url}/chat/completions` });
		const models = createModels();
		const baseUrl = kind === "anthropic" || kind === "mistral" ? root(server) : server.url;
		models.setProvider(customProvider(definition(kind, baseUrl, "none")));
		const answer = await models.completeSimple(models.getModel("custom-relay", "m")!, ask, { maxRetries: 0 });
		expect(answer.stopReason).toBe("error");
		expect(answer.errorMessage).toMatch(/redirects \(307\)/);
		expect(server.requests.map((request) => request.path)).toEqual([path]);
		expect(server.requests[0]?.headers.authorization).toBeUndefined();
		expect(server.requests[0]?.headers["x-api-key"]).toBeUndefined();
		expect(elsewhere.requests).toHaveLength(0);
	});
});
