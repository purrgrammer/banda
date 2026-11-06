/**
 * Model tiers (DESIGN.md "The companion"): Quick, Balanced and Deep. The tier new chats start on is a pick of the
 * companion's (`PUT /api/companion`); here are the models the tiers run on (`GET` and `PUT /api/tiers`) and a chat's own
 * tier (`POST /api/chats/:id/tier`), which changes from the chat's next run on (`defineTierSwitch`); and warming a chat's
 * prompt cache as the owner starts to write (`POST /api/chats/:id/warm`, `../warm.ts`).
 */
import type { ModelRef } from "@earendil-works/pi-durable";
import { ChatTier, defineTierSwitch } from "../../core/agents.ts";
import { Companion, type CompanionDoc, setModels } from "../../core/companion.ts";
import { context } from "../../core/store.ts";
import { isTier, modelFor, PRESETS, presetOf, providerOf, TIERS, type Tier } from "../../core/tiers.ts";
import { DEFAULT_MODEL } from "../../home.ts";
import type { TiersView } from "../api.ts";
import { BadRequest } from "../http.ts";
import { defineWarm } from "../warm.ts";
import type { AreaModule, Deps } from "./area.ts";
import { credentialOf } from "./providers.ts";

/** Each daemon's switch, by its core: the task it installs is the one its routes create. */
const switches = new WeakMap<object, ReturnType<typeof defineTierSwitch>>();

/** A provider in plain words, as who sees a chat names it. */
const providerName = (deps: Deps, provider: string) => deps.seen({ provider, modelId: "" })?.name ?? provider;

/**
 * The providers the owner may pick: those with presets that have credentials, and the configured model's; each
 * `ambient` with its `source` when its credential came from outside banda.
 */
export async function offered(deps: Deps, fallback: ModelRef): Promise<TiersView["providers"][number][]> {
	const candidates = [...new Set([...PRESETS.map((preset) => preset.provider), fallback.provider])];
	const usable = await Promise.all(
		candidates.map(async (id) => {
			try {
				return (await deps.models.getAvailable(id)).length > 0;
			} catch {
				return false;
			}
		}),
	);
	return Promise.all(
		candidates
			.filter((_, n) => usable[n])
			.map(async (id) => {
				const { ambient, source } = await credentialOf(deps.models, id);
				return {
					id,
					name: providerName(deps, id),
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
	const presets = presetOf(id) !== undefined;
	const seen = deps.seen(modelFor("quick", choice, fallback));
	const model = (tier: Tier) => {
		const ref = modelFor(tier, choice, fallback);
		const own = presets && choice.overrides?.[id]?.[tier] !== undefined;
		return {
			id: ref.modelId,
			name: deps.models.getModel(ref.provider, ref.modelId)?.name ?? ref.modelId,
			...(own ? { own: true as const } : {}),
		};
	};
	return {
		provider: { id, name: seen?.name ?? id, local: seen?.local ?? false },
		presets,
		models: { quick: model("quick"), balanced: model("balanced"), deep: model("deep") },
		providers: await offered(deps, fallback),
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
		if (presetOf(of) === undefined)
			throw new BadRequest(`${providerName(deps, of)} runs one model on every tier: there is no tier to change`);
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

/** A completed sign-in selects its provider in the daemon, even if the settings view was closed meanwhile. */
export async function selectConnectedProvider(deps: Deps, provider: string): Promise<void> {
	await change(deps, { provider });
}

/**
 * After signing out of `provider`: if the band thought with it, it moves to the first provider still usable, so it never
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
		const warmer = defineWarm({ harness: deps.harness, models: deps.models, log: deps.log });
		return {
			// a chat's tier shows on its row
			watch: [ChatTier],
			route: async (request) => {
				if (request.path === "/tiers" && request.method === "GET") return { body: await view(deps) };
				if (request.path === "/tiers" && request.method === "PUT") {
					await change(deps, await request.json());
					return { body: await view(deps) };
				}
				// the owner is about to write: the chat's prompt cache warms meanwhile, if it went cold
				const warming = /^\/chats\/(\d+)\/warm$/.exec(request.path);
				if (warming !== null && request.method === "POST") {
					const started = await warmer.warm(Number(warming[1]));
					if ("skipped" in started && started.skipped === "unknown") throw new BadRequest("no such chat", 404);
					return { status: 202, body: "skipped" in started ? { skipped: started.skipped } : { warming: true } };
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
