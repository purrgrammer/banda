/**
 * Every built-in provider pi-ai has is offered, presets or not, and a cloud's own form signs it in: each form's fields,
 * through the daemon, answer pi-ai's own login (its real prompts, offline: none of these logins reaches the network)
 * and store the credential pi-ai expects. A provider without a preset is connected without being used, and starts on
 * one model the owner picks.
 */
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import { PROVIDER_FORMS } from "../src/core/provider-forms.ts";
import { presetOf } from "../src/core/tiers.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ModelsListView, TiersView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome } from "./helpers.ts";

type ProviderView = { readonly id: string; readonly presets: boolean; readonly apiKey: boolean };

/** Nothing from this computer's environment or files: every credential is the one the form stored. */
const nowhere = { env: async () => undefined, fileExists: async () => false };

async function start(
	home: string,
	models = builtinModels({ credentials: new FileCredentialStore(home), authContext: nowhere }),
) {
	const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home) });
	const token = (await readDaemonFile(home))!.token!;
	const call = (path: string, init: RequestInit = {}) =>
		fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, ...init.headers },
		});
	const api = async <T>(path: string, init: RequestInit = {}) => {
		const response = await call(path, init);
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	};
	const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
	return { daemon, call, api, json };
}

describe("the built-in providers", () => {
	it("are all offered, presets or not, but the legacy Codex and pi-ai's providers without a chat model", async () => {
		const home = await tempHome();
		const s = await start(home);
		try {
			const listed = (await s.api<ProviderView[]>("/providers")).map((provider) => provider.id);
			const chat = builtinModels({ authContext: nowhere })
				.getProviders()
				.filter((provider) => provider.getModels().length > 0)
				.map((provider) => provider.id)
				.filter((id) => id !== "openai-codex");
			expect([...listed].sort()).toEqual([...chat].sort());
			expect(listed.length).toBeGreaterThan(35);
			expect(listed).not.toContain("openai-codex");
			expect(listed).not.toContain("typesafe");
			// those with presets come first, as before
			expect(listed.slice(0, 3)).toEqual(["anthropic", "openai", "azure"]);
			for (const id of ["together", "fireworks", "huggingface", "cloudflare-workers-ai", "radius", "zai"])
				expect(listed, id).toContain(id);
			const together = (await s.api<ProviderView[]>("/providers")).find((provider) => provider.id === "together");
			expect(together).toMatchObject({ presets: false, apiKey: true });
			// its models are pi-ai's catalog, said so
			const catalog = await s.api<ModelsListView>("/providers/together/models");
			expect(catalog.source).toBe("catalog");
			expect(catalog.models.length).toBeGreaterThan(0);
			expect(catalog.models[0]).toMatchObject({ contextWindow: expect.any(Number), cost: expect.any(Object) });
			// a static catalog has nothing to refresh
			expect((await s.call("/providers/together/refresh", { method: "POST" })).status).toBe(400);
		} finally {
			await s.daemon.close();
		}
	});
});

describe("a cloud's form", () => {
	const cases: readonly [string, string | undefined, Record<string, string>, unknown][] = [
		[
			"cloudflare-workers-ai",
			undefined,
			{ key: "cf-token-123456", account: "acc-1" },
			{ type: "api_key", key: "cf-token-123456", env: { CLOUDFLARE_ACCOUNT_ID: "acc-1" } },
		],
		[
			"cloudflare-ai-gateway",
			undefined,
			{ key: "cf-token-654321", account: "acc-2", gateway: "gw-1" },
			{
				type: "api_key",
				key: "cf-token-654321",
				env: { CLOUDFLARE_ACCOUNT_ID: "acc-2", CLOUDFLARE_GATEWAY_ID: "gw-1" },
			},
		],
		["amazon-bedrock", "bearer-token", { key: "bedrock-token-1" }, { type: "api_key", key: "bedrock-token-1" }],
		["amazon-bedrock", "aws-profile", { profile: "work" }, { type: "api_key", env: { AWS_PROFILE: "work" } }],
		["amazon-bedrock", "credential-chain", {}, { type: "api_key" }],
		["google-vertex", "api-key", { key: "vertex-key-1" }, { type: "api_key", key: "vertex-key-1" }],
		[
			"google-vertex",
			"adc",
			{ project: "my-project", location: "us-central1" },
			{ type: "api_key", env: { GOOGLE_CLOUD_PROJECT: "my-project", GOOGLE_CLOUD_LOCATION: "us-central1" } },
		],
		[
			"google-vertex",
			"service-account",
			{ project: "p", location: "europe-west4", file: "/keys/sa.json" },
			{
				type: "api_key",
				env: {
					GOOGLE_CLOUD_PROJECT: "p",
					GOOGLE_CLOUD_LOCATION: "europe-west4",
					GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json",
				},
			},
		],
		[
			"azure",
			undefined,
			{ key: "azure-key-1", resource: "my-resource" },
			{ type: "api_key", key: "azure-key-1", env: { AZURE_OPENAI_RESOURCE_NAME: "my-resource" } },
		],
	];

	it.each(cases)("%s (%s) stores what pi-ai's login asks for", async (provider, method, fields, stored) => {
		const home = await tempHome();
		const s = await start(home);
		try {
			const form = PROVIDER_FORMS[provider];
			expect(form).toBeDefined();
			await s.api(
				`/providers/${provider}`,
				s.json("POST", { type: "api_key", ...(method === undefined ? {} : { method }), fields, use: false }),
			);
			expect(await new FileCredentialStore(home).read(provider)).toEqual(stored);
			// nothing reads a secret back out
			if (fields.key !== undefined) expect(JSON.stringify(await s.api("/providers"))).not.toContain(fields.key);
		} finally {
			await s.daemon.close();
		}
	});

	it("says what is missing, and stores nothing", async () => {
		const home = await tempHome();
		const s = await start(home);
		try {
			const refused = await s.call(
				"/providers/cloudflare-ai-gateway",
				s.json("POST", { type: "api_key", fields: { key: "k", account: "a" }, use: false }),
			);
			expect(refused.status).toBe(400);
			expect(((await refused.json()) as { error: string }).error).toBe("Gateway ID is needed");
			const azure = await s.call("/providers/azure", s.json("POST", { type: "api_key", fields: { key: "k" } }));
			expect(((await azure.json()) as { error: string }).error).toBe("Give resource name or its endpoint");
			expect(await new FileCredentialStore(home).list()).toEqual([]);
		} finally {
			await s.daemon.close();
		}
	});
});

describe("a provider without a preset", () => {
	it("is connected without being used, then starts on one model for every tier, and is used only when asked", async () => {
		const home = await tempHome();
		const credentials = new FileCredentialStore(home);
		const models = createModels({ credentials });
		const anthropic = fauxProvider({ provider: "anthropic", models: [{ id: presetOf("anthropic")!.models.quick }] });
		models.setProvider({
			...anthropic.provider,
			auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "x" }, source: "stored credential" }) } },
		} as never);
		const together = fauxProvider({ provider: "together", models: [{ id: "small-1" }, { id: "large-1" }] });
		models.setProvider({
			...together.provider,
			name: "Together",
			auth: {
				apiKey: {
					name: "Together key",
					login: async ({ prompt }: { prompt: (ask: { type: "secret"; message: string }) => Promise<string> }) => ({
						type: "api_key" as const,
						key: await prompt({ type: "secret", message: "Key" }),
					}),
					resolve: async ({ credential }: { credential?: { key?: string } }) =>
						credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined,
				},
			},
		} as never);
		const s = await start(home, models as never);
		try {
			await s.api("/tiers", s.json("PUT", { provider: "anthropic" }));
			await s.api("/providers/together", s.json("POST", { type: "api_key", key: "together-key", use: false }));
			let tiers = await s.api<TiersView>("/tiers");
			expect(tiers.provider.id).toBe("anthropic");
			// connected, not started: not offered yet, and picking it says why
			expect(tiers.providers.map((each) => each.id)).not.toContain("together");
			const early = await s.call("/tiers", s.json("PUT", { provider: "together" }));
			expect(((await early.json()) as { error: string }).error).toBe("Pick the model Together starts on first");
			// started on one model: offered, still not used
			tiers = await s.api<TiersView>("/tiers", s.json("PUT", { start: { provider: "together", model: "large-1" } }));
			expect(tiers.provider.id).toBe("anthropic");
			expect(tiers.providers.map((each) => each.id)).toContain("together");
			// used when the owner says so: every tier runs the one model, until refined
			tiers = await s.api<TiersView>("/tiers", s.json("PUT", { provider: "together" }));
			expect(tiers.provider.id).toBe("together");
			expect([tiers.models.quick.id, tiers.models.balanced.id, tiers.models.deep.id]).toEqual([
				"large-1",
				"large-1",
				"large-1",
			]);
			expect(tiers.catalog.map((each) => each.id)).toEqual(["small-1", "large-1"]);
			tiers = await s.api<TiersView>("/tiers", s.json("PUT", { override: { tier: "quick", modelId: "small-1" } }));
			expect(tiers.models.quick.id).toBe("small-1");
			const reset = await s.call("/tiers", s.json("PUT", { override: { tier: "quick", modelId: null } }));
			expect(reset.status).toBe(400);
		} finally {
			await s.daemon.close();
		}
	});
});
