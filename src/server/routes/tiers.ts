/**
 * Model tiers (DESIGN.md "The companion"): Quick, Balanced and Deep. The tier new chats start on is a pick of the
 * companion's (`PUT /api/companion`); here are the models the tiers run on (`GET` and `PUT /api/tiers`) and a chat's own
 * tier (`POST /api/chats/:id/tier`), which changes from the chat's next run on (`defineTierSwitch`).
 */
import type { ModelRef } from "@earendil-works/pi-durable";
import { accountsOf } from "../../core/account-provider.ts";
import { ChatTier, defineTierSwitch } from "../../core/agents.ts";
import { Companion, type CompanionDoc, setModels } from "../../core/companion.ts";
import { isCustomProvider } from "../../core/custom-providers.ts";
import { accountTitle, backendOf, parseAccount } from "../../core/provider-accounts.ts";
import { FileCredentialStore } from "../../core/provider-credentials.ts";
import { context } from "../../core/store.ts";
import { isTier, modelFor, PRESETS, presetOf, providerOf, TIERS, type Tier } from "../../core/tiers.ts";
import { DEFAULT_MODEL } from "../../home.ts";
import type { TiersView } from "../api.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule, Deps } from "./area.ts";
import { credentialOf } from "./providers.ts";

/** Each daemon's switch, by its core: the task it installs is the one its routes create. */
const switches = new WeakMap<object, ReturnType<typeof defineTierSwitch>>();

/** A provider in plain words, as who sees a chat names it. */
const providerName = (deps: Deps, provider: string) => deps.seen({ provider, modelId: "" })?.name ?? provider;

/** The custom providers registered here, by id (`../../core/custom-provider.ts`). */
export const customIds = (deps: Pick<Deps, "models">): string[] =>
	deps.models
		.getProviders()
		.map((provider) => provider.id)
		.filter(isCustomProvider);

/** Whether each tier of custom provider `id` names one of its models, as the owner chose them. */
export const mapped = (deps: Pick<Deps, "models">, choice: CompanionDoc, id: string): boolean =>
	TIERS.every((tier) => {
		const modelId = choice.overrides?.[id]?.[tier];
		return modelId !== undefined && deps.models.getModel(id, modelId) !== undefined;
	});

/**
 * The provider accounts the owner may pick: those of backends with presets that have credentials, the configured
 * model's, and the custom providers that can be reached (a key given, or none needed) and have a model for each tier;
 * each named by its backend, with its label once the backend has more than one, and `ambient` with its `source` when
 * its credential came from outside banda.
 */
export async function offered(deps: Deps, fallback: ModelRef): Promise<TiersView["providers"][number][]> {
	const customs = customIds(deps);
	const choice: CompanionDoc = customs.length === 0 ? {} : ((await deps.harness.snapshot(Companion, context)) ?? {});
	const candidates = [
		...new Set([
			...PRESETS.flatMap((preset) => accountsOf(deps.models, preset.provider)),
			...accountsOf(deps.models, backendOf(fallback.provider)),
			fallback.provider,
			...customs.filter((id) => mapped(deps, choice, id)),
		]),
	];
	const usable = await Promise.all(
		candidates.map(async (id) => {
			try {
				return (await deps.models.getAvailable(id)).length > 0;
			} catch {
				return false;
			}
		}),
	);
	const kept = candidates.filter((_, n) => usable[n]);
	const labels = await new FileCredentialStore(deps.home).labels();
	return Promise.all(
		kept.map(async (id) => {
			if (isCustomProvider(id)) return { id, name: deps.models.getProvider(id)?.name ?? id };
			const { ambient, source } = await credentialOf(deps.models, id);
			const many = kept.filter((each) => backendOf(each) === backendOf(id)).length > 1;
			return {
				id,
				name: accountTitle(providerName(deps, id), labels[id] ?? parseAccount(id).account, many),
				...(ambient ? { ambient } : {}),
				...(source === undefined ? {} : { source }),
			};
		}),
	);
}

async function view(deps: Deps): Promise<TiersView> {
	const choice: CompanionDoc = (await deps.harness.snapshot(Companion, context)) ?? {};
	const fallback = deps.config.model;
	const id = providerOf(choice, fallback);
	const custom = isCustomProvider(id);
	const presets = presetOf(id) !== undefined || custom;
	const seen = deps.seen(modelFor("quick", choice, fallback));
	const model = (tier: Tier) => {
		const ref = modelFor(tier, choice, fallback);
		const own = presets && !custom && choice.overrides?.[id]?.[tier] !== undefined;
		return {
			id: ref.modelId,
			name: deps.models.getModel(ref.provider, ref.modelId)?.name ?? ref.modelId,
			...(own ? { own: true as const } : {}),
		};
	};
	const providers = await offered(deps, fallback);
	return {
		provider: {
			id,
			name: providers.find((each) => each.id === id)?.name ?? seen?.name ?? id,
			local: seen?.local ?? false,
		},
		presets,
		models: { quick: model("quick"), balanced: model("balanced"), deep: model("deep") },
		providers,
		// the owner's pick: one made in the app, or a model config.json names; never the default alone
		chosen:
			choice.provider !== undefined ||
			fallback.provider !== DEFAULT_MODEL.provider ||
			fallback.modelId !== DEFAULT_MODEL.modelId,
		catalog: presets ? deps.models.getModels(id).map((each) => ({ id: each.id, name: each.name })) : [],
	};
}

/** Change the models as the owner chose, each part checked before any is stored. */
async function change(deps: Deps, body: Record<string, unknown>): Promise<void> {
	const choice: CompanionDoc = (await deps.harness.snapshot(Companion, context)) ?? {};
	const fallback = deps.config.model;
	let provider: string | undefined;
	if (body.provider !== undefined) {
		if (typeof body.provider !== "string") throw new BadRequest("provider is a provider's id, as text");
		if (!(await offered(deps, fallback)).some((each) => each.id === body.provider))
			throw new BadRequest(`${providerName(deps, body.provider)} has no key set up here: add one, then pick it`);
		provider = body.provider;
	}
	let override: { provider: string; tier: Tier; modelId: string | null } | undefined;
	if (body.override !== undefined) {
		const { tier, modelId } = (body.override ?? {}) as { tier?: unknown; modelId?: unknown };
		if (!isTier(tier)) throw new BadRequest(`override.tier is one of ${TIERS.join(", ")}`);
		if (modelId !== null && typeof modelId !== "string")
			throw new BadRequest("override.modelId is a model's id, or null for the preset");
		const of = provider ?? providerOf(choice, fallback);
		if (presetOf(of) === undefined && !isCustomProvider(of))
			throw new BadRequest(`${providerName(deps, of)} runs one model on every tier: there is no tier to change`);
		if (modelId === null && isCustomProvider(of))
			throw new BadRequest(`${providerName(deps, of)} has no preset: each tier runs one of its models, as you chose`);
		if (modelId !== null && deps.models.getModel(of, modelId) === undefined)
			throw new BadRequest(`${providerName(deps, of)} has no model "${modelId}"`);
		override = { provider: of, tier, modelId };
	}
	const switcher = switches.get(deps.core);
	if (switcher === undefined) throw new Error("the tiers area started before it was installed");
	await deps.harness.commit(async (tx) => {
		await setModels(tx, {
			...(provider === undefined ? {} : { provider }),
			...(override === undefined ? {} : { override }),
		});
		await switcher.modelsChanged(tx);
	}, context);
}

/**
 * Run custom provider `provider`'s tiers on `models`, one of its models each (the same one on several is fine), and
 * think with it when `use`; in one commit, so a chat that follows the tiers moves with them.
 */
export async function setTiers(
	deps: Deps,
	provider: string,
	models: { readonly [T in Tier]: string },
	use = false,
): Promise<void> {
	const switcher = switches.get(deps.core);
	if (switcher === undefined) throw new Error("the tiers area started before it was installed");
	await deps.harness.commit(async (tx) => {
		for (const tier of TIERS) await setModels(tx, { override: { provider, tier, modelId: models[tier] } });
		if (use) await setModels(tx, { provider });
		const choice = await tx.doc(Companion);
		if (providerOf(choice, deps.config.model) === provider) await switcher.modelsChanged(tx);
	}, context);
}

/** Forget custom provider `provider`'s tiers: it is gone. */
export async function clearTiers(deps: Deps, provider: string): Promise<void> {
	await deps.harness.commit(async (tx) => {
		for (const tier of TIERS) await setModels(tx, { override: { provider, tier, modelId: null } });
	}, context);
}

/** A completed sign-in selects its account in the daemon, even if the settings view was closed meanwhile. */
export async function selectConnectedProvider(deps: Deps, provider: string): Promise<void> {
	await change(deps, { provider });
}

/**
 * After signing out of `provider` (an account): if the band thought with it, it moves to the first account still usable, so it never
 * stays on one it cannot reach. With none left the choice stays, and the app asks for a provider again.
 */
export async function leaveProvider(deps: Deps, provider: string): Promise<void> {
	const choice: CompanionDoc = (await deps.harness.snapshot(Companion, context)) ?? {};
	if (providerOf(choice, deps.config.model) !== provider) return;
	const next = (await offered(deps, deps.config.model)).find((each) => each.id !== provider);
	if (next !== undefined) await change(deps, { provider: next.id });
}

export const tiers: AreaModule = {
	install: (boot) => {
		const tierSwitch = defineTierSwitch(() => boot.config.model);
		switches.set(boot.core, tierSwitch);
		return [tierSwitch.extension];
	},
	start: (deps) => {
		const tierSwitch = switches.get(deps.core);
		if (tierSwitch === undefined) throw new Error("the tiers area started before it was installed");
		return {
			// a chat's tier shows on its row
			watch: [ChatTier],
			route: async (request) => {
				if (request.path === "/tiers" && request.method === "GET") return { body: await view(deps) };
				if (request.path === "/tiers" && request.method === "PUT") {
					await change(deps, await request.json());
					return { body: await view(deps) };
				}
				const chat = /^\/chats\/(\d+)\/tier$/.exec(request.path);
				if (chat !== null && request.method === "POST") {
					const { tier } = await request.json();
					if (!isTier(tier)) throw new BadRequest(`tier is how hard it thinks: ${TIERS.join(", ")}`);
					const refused = await tierSwitch.switchTier(deps.harness, Number(chat[1]), tier);
					if (refused?.refused === "unknown") throw new BadRequest("no such chat", 404);
					if (refused?.refused === "custom")
						throw new BadRequest("this chat runs the model its agent's file names, whatever the tier", 409);
					deps.changed();
					return { body: { tier } };
				}
				return undefined;
			},
		};
	},
};
