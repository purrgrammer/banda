/**
 * Servers of the owner's (`../../core/custom-providers.ts`): added, edited and removed here; listed (the models the
 * server says it has) and checked (one short answer from it) only when the owner asks. Saving never reaches the server
 * and uses nothing: a new one starts on the model the owner picked, on every tier, and the band thinks with it only
 * once they pick Use. The key goes to the provider credentials (`auth/providers.json`) and never comes back out; the
 * definition goes to `<home>/custom-providers.json`, and its tiers to the companion's choice of models, as any
 * provider's own models do.
 *
 * A server the band thinks with, or that an agent's file or a chat still runs on, is not removed, nor a model of it one
 * still runs on, until the owner moves them: nothing switches to another model on its own.
 */
import { AgentDoc, type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { Accepted, ChatTier, parseAgent } from "../../core/agents.ts";
import { Companion, type CompanionDoc } from "../../core/companion.ts";
import {
	changeCustomProviders,
	guardedFetch,
	observingFetch,
	readCustomProviders,
	redact,
	registerCustomProviders,
} from "../../core/custom-provider.ts";
import {
	type CustomCompat,
	type CustomModel,
	type CustomProvider,
	checkFailure,
	customId,
	destinationOf,
	isCustomProvider,
	isServerKind,
	modelName,
	type Observed,
	originOf,
	problemsOf,
} from "../../core/custom-providers.ts";
import { listModels, Unreadable } from "../../core/model-listing.ts";
import { FileCredentialStore } from "../../core/provider-credentials.ts";
import { context } from "../../core/store.ts";
import { usageRecorder } from "../../core/system-usage.ts";
import { providerOf, TIERS, type Tier } from "../../core/tiers.ts";
import type { CatalogMatch, Checked, CustomProvidersView, ListingView } from "../api/custom-providers.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule, Deps } from "./area.ts";
import { clearTiers, setTiers } from "./tiers.ts";

/** How long a listing waits for the server, every request of it together. */
const LIST_MS = 20_000;

/**
 * pi-ai's built-in catalog by model id, where one id names one model's limits: a match a server's model may be offered,
 * never taken for it. An id two providers list with different limits is no match.
 */
function catalogIndex(deps: Deps): Map<string, CatalogMatch> {
	const index = new Map<string, CatalogMatch | null>();
	for (const provider of deps.models.getProviders()) {
		if (isCustomProvider(provider.id) || provider.id.includes("@")) continue;
		for (const model of provider.getModels()) {
			const match: CatalogMatch = {
				ref: `${provider.id}/${model.id}`,
				provider: provider.name,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				images: model.input.includes("image"),
				reasoning: model.reasoning,
			};
			const before = index.get(model.id);
			if (before === undefined) index.set(model.id, match);
			else if (
				before !== null &&
				(before.contextWindow !== match.contextWindow ||
					before.maxTokens !== match.maxTokens ||
					before.images !== match.images ||
					before.reasoning !== match.reasoning)
			)
				index.set(model.id, null);
		}
	}
	return new Map([...index].flatMap(([id, match]) => (match === null ? [] : [[id, match] as const])));
}

/** How long a check waits for an answer. */
const CHECK_MS = 30_000;
/** The longest key banda keeps. */
const MAX_KEY = 4096;

const text = (value: unknown, what: string): string => {
	if (typeof value !== "string") throw new BadRequest(`${what} is text`);
	return value;
};
const number = (value: unknown, what: string): number => {
	if (typeof value !== "number") throw new BadRequest(`${what} is a number`);
	return value;
};
const flag = (value: unknown, what: string): boolean => {
	if (typeof value !== "boolean") throw new BadRequest(`${what} is true or false`);
	return value;
};

/** The definition in a request's body, typed and trimmed; its rules are `problemsOf`'s. */
function definitionOf(value: unknown): Omit<CustomProvider, "id"> {
	if (typeof value !== "object" || value === null) throw new BadRequest("provider is the provider's definition");
	const body = value as Record<string, unknown>;
	const key = body.key;
	if (key !== "required" && key !== "none") throw new BadRequest('provider.key is "required" or "none"');
	if (!isServerKind(body.kind)) throw new BadRequest("provider.kind is the kind of server it is");
	const kind = body.kind;
	// whether it charges per token is the owner's word, never a default
	const billing = body.billing;
	if (billing !== "none" && billing !== "rates")
		throw new BadRequest('provider.billing says whether it charges per token: "none" or "rates"');
	if (!Array.isArray(body.models)) throw new BadRequest("provider.models is a list");
	const models = body.models.map((each: unknown, n): CustomModel => {
		if (typeof each !== "object" || each === null) throw new BadRequest(`provider.models.${n} is a model`);
		const model = each as Record<string, unknown>;
		let cost: CustomModel["cost"];
		if (billing === "rates") {
			if (typeof model.cost !== "object" || model.cost === null)
				throw new BadRequest(`provider.models.${n}.cost is what it charges per million tokens in and out`);
			const given = model.cost as Record<string, unknown>;
			cost = {
				input: number(given.input, `provider.models.${n}.cost.input`),
				output: number(given.output, `provider.models.${n}.cost.output`),
			};
		} else if (model.cost !== undefined)
			throw new BadRequest(`provider.models.${n}.cost: it charges no per-token price, so a model has none`);
		const source = (model.source ?? {}) as Record<string, unknown>;
		const limits = source.limits;
		const catalog = (limits as { catalog?: unknown } | undefined)?.catalog;
		if (limits !== "server" && limits !== "owner" && typeof catalog !== "string")
			throw new BadRequest(`provider.models.${n}.source.limits says where its limits came from`);
		const name = model.name === undefined ? "" : text(model.name, `provider.models.${n}.name`).trim();
		return {
			id: text(model.id, `provider.models.${n}.id`).trim(),
			...(name === "" ? {} : { name }),
			images: flag(model.images ?? false, `provider.models.${n}.images`),
			reasoning: flag(model.reasoning ?? false, `provider.models.${n}.reasoning`),
			contextWindow: number(model.contextWindow, `provider.models.${n}.contextWindow`),
			maxTokens: number(model.maxTokens, `provider.models.${n}.maxTokens`),
			...(cost === undefined ? {} : { cost }),
			source: {
				listed: flag(source.listed ?? false, `provider.models.${n}.source.listed`),
				limits: typeof catalog === "string" ? { catalog } : (limits as "server" | "owner"),
			},
		};
	});
	let compat: CustomCompat | undefined;
	if (body.compat !== undefined) {
		const given = body.compat as Record<string, unknown>;
		if (typeof given !== "object" || given === null) throw new BadRequest("provider.compat is an object");
		const { instructions, maxTokensField, store, reasoningEffort } = given;
		if (instructions !== undefined && instructions !== "system" && instructions !== "developer")
			throw new BadRequest('provider.compat.instructions is "system" or "developer"');
		if (maxTokensField !== undefined && maxTokensField !== "max_tokens" && maxTokensField !== "max_completion_tokens")
			throw new BadRequest('provider.compat.maxTokensField is "max_tokens" or "max_completion_tokens"');
		compat = {
			...(instructions === undefined ? {} : { instructions }),
			...(maxTokensField === undefined ? {} : { maxTokensField }),
			...(store === undefined ? {} : { store: flag(store, "provider.compat.store") }),
			...(reasoningEffort === undefined
				? {}
				: { reasoningEffort: flag(reasoningEffort, "provider.compat.reasoningEffort") }),
		};
	}
	const baseUrl = text(body.baseUrl, "provider.baseUrl");
	const destination = destinationOf(baseUrl);
	return {
		name: text(body.name, "provider.name").trim(),
		kind,
		baseUrl: "error" in destination ? baseUrl : destination.url,
		key,
		billing,
		models,
		...(compat === undefined || Object.keys(compat).length === 0 ? {} : { compat }),
	};
}

/** The model a new server starts on, from a request's body: one of `models`, for every tier. */
function startOf(value: unknown, models: readonly CustomModel[]): { readonly [T in Tier]: string } {
	if (typeof value !== "string" || !models.some((model) => model.id === value))
		throw new BadRequest("Pick the model it starts on: one of those you keep");
	return { quick: value, balanced: value, deep: value };
}

/** The tiers in a request's body: one of `models` each. */
function tiersOf(value: unknown, models: readonly CustomModel[]): { readonly [T in Tier]: string } {
	if (typeof value !== "object" || value === null) throw new BadRequest("tiers names a model for each tier");
	const given = value as Record<string, unknown>;
	const chosen = {} as { [T in Tier]: string };
	for (const tier of TIERS) {
		const id = given[tier];
		if (typeof id !== "string" || !models.some((model) => model.id === id))
			throw new BadRequest(`Pick one of its models for ${tier[0]?.toUpperCase()}${tier.slice(1)}`);
		chosen[tier] = id;
	}
	return chosen;
}

/** A key from a request's body, when it carries one. */
function keyOf(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") throw new BadRequest("key is the key, as text");
	if (value.length > MAX_KEY) throw new BadRequest(`A key is at most ${MAX_KEY} characters`);
	return value.trim();
}

/**
 * What still runs on provider `id` (on one of `models` of it, when given), in the owner's words: the band, when the
 * whole provider would go; the config; an agent's file; a chat with a model of its own, or one answering on it now.
 */
async function stillOn(deps: Deps, id: string, models?: ReadonlySet<string>): Promise<string[]> {
	const on = (ref: { provider: string; modelId: string } | undefined) =>
		ref !== undefined && ref.provider === id && (models === undefined || models.has(ref.modelId));
	const reasons: string[] = [];
	const choice: CompanionDoc = (await deps.harness.snapshot(Companion, context)) ?? {};
	if (models === undefined && providerOf(choice, deps.config.model) === id)
		reasons.push("The band thinks with it: use another provider first");
	else if (on(deps.config.model)) reasons.push("config.json names it as the band's model");
	const files = (await deps.harness.snapshot(Accepted, context))?.files ?? {};
	for (const [path, file] of Object.entries(files)) {
		const agent = /^agents\/(.+)\.md$/.exec(path)?.[1];
		if (agent === undefined) continue;
		const parsed = parseAgent(agent, file.text);
		if ("agent" in parsed && on(parsed.agent.model))
			reasons.push(`${parsed.agent.name}'s file names ${parsed.agent.model?.modelId}: change its model first`);
	}
	const busy = await deps.harness.commit(async (tx) => {
		let count = 0;
		for (const [chat, entry] of Object.entries((await tx.doc(ChatTier)).chats)) {
			const state = await tx.doc(AgentDoc, Number(chat) as ConversationId);
			if (!on(state.model)) continue;
			// an idle chat that follows the tiers moves with them; one answering now, or on a model of its own, does not
			if (entry?.custom === true || (await tx.doc(LiveDoc, Number(chat) as ConversationId)).run !== undefined) count++;
		}
		return count;
	}, context);
	if (busy > 0)
		reasons.push(
			busy === 1
				? "A chat is still answering on it: try again when it is done"
				: `${busy} chats are still answering on it: try again when they are done`,
		);
	return reasons;
}

export const customProviders: AreaModule = {
	start: (deps) => {
		const credentials = new FileCredentialStore(deps.home);
		const checks = new Map<string, Checked>();
		const checking = new Set<string>();
		const record = usageRecorder(deps.harness, "check.provider", deps.log);
		let error: string | undefined;
		/** Register what the file says now; a file that does not fit registers none, and the view says why. */
		const register = async () => {
			error = (await registerCustomProviders(deps.models, deps.home, deps.log)).error;
		};
		void register().then(deps.changed);

		const view = async (): Promise<CustomProvidersView> => {
			let file: Awaited<ReturnType<typeof readCustomProviders>>;
			try {
				file = await readCustomProviders(deps.home);
			} catch (thrown) {
				return { providers: [], error: thrown instanceof Error ? thrown.message : String(thrown) };
			}
			const choice: CompanionDoc = (await deps.harness.snapshot(Companion, context)) ?? {};
			const using = providerOf(choice, deps.config.model);
			const stored = new Set((await credentials.list()).map((each) => each.providerId));
			return {
				providers: file.providers.map((provider) => {
					const destination = destinationOf(provider.baseUrl);
					const checked = checks.get(provider.id);
					return {
						id: provider.id,
						name: provider.name,
						kind: provider.kind,
						baseUrl: provider.baseUrl,
						billing: provider.billing,
						destination:
							"error" in destination
								? { place: "internet", host: provider.baseUrl, secure: false, url: provider.baseUrl }
								: destination,
						key: provider.key === "none" ? "none" : stored.has(provider.id) ? "stored" : "missing",
						models: provider.models,
						...(provider.compat === undefined ? {} : { compat: provider.compat }),
						tiers: { ...choice.overrides?.[provider.id] },
						using: using === provider.id,
						...(checked === undefined ? {} : { checked }),
					};
				}),
				...(error === undefined ? {} : { error }),
			};
		};

		/** Store `key` for `id`, or forget its key (`null`). */
		const keep = async (id: string, key: string | null) => {
			if (key === null) await credentials.delete(id);
			else await credentials.modify(id, async () => ({ type: "api_key", key }));
		};

		const add = async (body: Record<string, unknown>) => {
			const definition = definitionOf(body.provider);
			const file = await readCustomProviders(deps.home);
			const [problem] = problemsOf(
				definition,
				file.providers.map((each) => each.name),
			);
			if (problem !== undefined) throw new BadRequest(problem.message);
			// one model the owner picked runs every tier until they refine one; nothing is used until they say Use
			const tiers = startOf(body.start, definition.models);
			const key = keyOf(body.key);
			if (definition.key === "required" && key === undefined)
				throw new BadRequest("Give its key, or say it needs none");
			if (definition.key === "none" && key !== undefined) throw new BadRequest("It needs no key: leave the key out");
			let kept: string | undefined;
			const id = await changeCustomProviders(deps.home, async (now) => {
				const id = customId(definition.name, new Set(now.providers.map((each) => each.id)));
				// the key first: a provider never stands registered without the key it said it takes
				if (key !== undefined) {
					await keep(id, key);
					kept = id;
				}
				return { file: { providers: [...now.providers, { id, ...definition }] }, result: id };
			}).catch(async (thrown: unknown) => {
				if (kept !== undefined) await keep(kept, null);
				throw thrown instanceof BadRequest
					? thrown
					: new BadRequest(thrown instanceof Error ? thrown.message : String(thrown));
			});
			await register();
			await setTiers(deps, id, tiers);
			deps.changed();
			return { id };
		};

		const edit = async (id: string, body: Record<string, unknown>) => {
			const definition = definitionOf(body.provider);
			const file = await readCustomProviders(deps.home);
			const before = file.providers.find((each) => each.id === id);
			if (before === undefined) throw new BadRequest("There is no such provider", 404);
			const [problem] = problemsOf(
				definition,
				file.providers.filter((each) => each.id !== id).map((each) => each.name),
			);
			if (problem !== undefined) throw new BadRequest(problem.message);
			const current = (await deps.harness.snapshot(Companion, context))?.overrides?.[id] ?? {};
			const tiers =
				body.tiers !== undefined
					? tiersOf(body.tiers, definition.models)
					: body.start !== undefined
						? startOf(body.start, definition.models)
						: tiersOf(current, definition.models);
			const key = keyOf(body.key);
			if (definition.key === "none" && key !== undefined) throw new BadRequest("It needs no key: leave the key out");
			const had = (await credentials.read(id)) !== undefined;
			if (definition.key === "required" && key === undefined) {
				if (!had) throw new BadRequest("Give its key, or say it needs none");
				// a key was given for one address: it goes to another only when the owner gives it again
				if (originOf(before.baseUrl) !== originOf(definition.baseUrl))
					throw new BadRequest("The address changed: give the key again, for the new address", 409);
			}
			const removed = new Set(
				before.models.map((model) => model.id).filter((model) => !definition.models.some((each) => each.id === model)),
			);
			if (removed.size > 0) {
				const reasons = await stillOn(deps, id, removed);
				if (reasons.length > 0) throw new BadRequest(`It still runs a model you removed. ${reasons.join(". ")}.`, 409);
			}
			// the tiers first, so nothing follows them onto a model that is about to go
			await setTiers(deps, id, tiers);
			await changeCustomProviders(deps.home, async (now) => {
				if (key !== undefined) await keep(id, key);
				else if (definition.key === "none" && had) await keep(id, null);
				return {
					file: { providers: now.providers.map((each) => (each.id === id ? { id, ...definition } : each)) },
					result: undefined,
				};
			});
			checks.delete(id);
			await register();
			deps.changed();
			return {};
		};

		const remove = async (id: string) => {
			const file = await readCustomProviders(deps.home);
			if (!file.providers.some((each) => each.id === id)) throw new BadRequest("There is no such provider", 404);
			const reasons = await stillOn(deps, id);
			if (reasons.length > 0) throw new BadRequest(`It is still in use. ${reasons.join(". ")}.`, 409);
			await changeCustomProviders(deps.home, async (now) => ({
				file: { providers: now.providers.filter((each) => each.id !== id) },
				result: undefined,
			}));
			await keep(id, null);
			await clearTiers(deps, id);
			checks.delete(id);
			await register();
			deps.changed();
			return {};
		};

		/**
		 * The models the server lists, when the owner asks: the route its kind documents, through the same guard as every
		 * request to it, which asks no model to answer. A model of the same id in pi-ai's catalog is offered beside it, its
		 * limits for the owner to take or not: an id is no promise that a server runs the same model, so nothing is taken
		 * on its word, and never its price.
		 */
		const list = async (body: Record<string, unknown>): Promise<ListingView> => {
			const given = (typeof body.provider === "object" && body.provider !== null ? body.provider : {}) as Record<
				string,
				unknown
			>;
			if (!isServerKind(given.kind)) throw new BadRequest("provider.kind is the kind of server it is");
			const kind = given.kind;
			const destination = destinationOf(text(given.baseUrl, "provider.baseUrl"));
			if ("error" in destination) throw new BadRequest(destination.error);
			const keyless = given.key === "none";
			let key = keyless ? undefined : keyOf(body.key);
			// an edit lists with the key kept for it, and only at the address it was given for
			if (!keyless && key === undefined && typeof body.id === "string") {
				const before = (await readCustomProviders(deps.home)).providers.find((each) => each.id === body.id);
				const stored = await credentials.read(body.id);
				if (
					before !== undefined &&
					originOf(before.baseUrl) === originOf(destination.url) &&
					stored?.type === "api_key"
				)
					key = stored.key;
			}
			if (!keyless && key === undefined) throw new BadRequest("Give its key first: it is sent with the request");
			const seen: Observed[] = [];
			const deadline = AbortSignal.timeout(LIST_MS);
			try {
				const listed = await listModels(
					{ kind, baseUrl: destination.url },
					key,
					guardedFetch({ key: keyless ? "none" : "required" }, observingFetch(seen)),
					deadline,
				);
				const catalog = catalogIndex(deps);
				return {
					ok: true,
					routes: listed.routes,
					models: listed.models.map((model) => {
						const match = catalog.get(model.id);
						return match === undefined ? model : { ...model, catalog: match };
					}),
				};
			} catch (thrown) {
				const last = seen.at(-1);
				const unreadable = thrown instanceof Unreadable;
				return {
					ok: false,
					failure: unreadable ? "unreadable" : checkFailure(deadline.aborted, last),
					...(last?.status === undefined ? {} : { status: last.status }),
					detail: deadline.aborted
						? `no answer in ${LIST_MS / 1000} seconds`
						: redact(
								[last?.code, thrown instanceof Error ? thrown.message : String(thrown)].filter(Boolean).join(": "),
								[key],
							),
				};
			}
		};

		/** One short request to the endpoint, with `modelId` (its Quick model unless given): the owner asked for it. */
		const check = async (id: string, body: Record<string, unknown>): Promise<Checked> => {
			const provider = deps.models.getProvider(id);
			if (provider === undefined) throw new BadRequest("There is no such provider", 404);
			const choice: CompanionDoc = (await deps.harness.snapshot(Companion, context)) ?? {};
			const modelId =
				typeof body.model === "string" ? body.model : (choice.overrides?.[id]?.quick ?? provider.getModels()[0]?.id);
			const model = modelId === undefined ? undefined : deps.models.getModel(id, modelId);
			if (model === undefined) throw new BadRequest(`It has no model ${modelId ?? ""}`.trim());
			if ((await deps.models.checkAuth(id).catch(() => undefined)) === undefined)
				throw new BadRequest("Give its key first: nothing is sent without it");
			if (checking.has(id)) throw new BadRequest("A check is under way already", 409);
			checking.add(id);
			const started = Date.now();
			const seen: Observed[] = [];
			const deadline = AbortSignal.timeout(CHECK_MS);
			try {
				const answer = await deps.models.completeSimple(
					model,
					{
						systemPrompt: "Answer with the one word OK.",
						messages: [{ role: "user", content: "Are you there?", timestamp: started }],
					},
					// one request, as the owner was told: never retried
					{ maxTokens: Math.min(64, model.maxTokens), maxRetries: 0, signal: deadline, fetch: observingFetch(seen) },
				);
				await record(answer);
				const reply = answer.content
					.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("")
					.trim();
				const last = seen.at(-1);
				const checked: Checked =
					answer.stopReason === "error" || answer.stopReason === "aborted"
						? {
								ok: false,
								at: Date.now(),
								model: modelName({ id: model.id, name: model.name }),
								failure: checkFailure(deadline.aborted, last),
								...(last?.status === undefined ? {} : { status: last.status }),
								detail: deadline.aborted
									? `no answer in ${CHECK_MS / 1000} seconds`
									: redact([last?.code, answer.errorMessage].filter(Boolean).join(": ") || "no detail"),
							}
						: {
								ok: true,
								at: Date.now(),
								model: modelName({ id: model.id, name: model.name }),
								ms: Date.now() - started,
								reply: redact(reply).slice(0, 200),
							};
				checks.set(id, checked);
				return checked;
			} finally {
				checking.delete(id);
				deps.changed();
			}
		};

		return {
			route: async (request) => {
				if (request.path === "/custom-providers" && request.method === "GET") return { body: await view() };
				if (request.path === "/custom-providers" && request.method === "POST")
					return { body: await add(await request.json()) };
				if (request.path === "/custom-providers/list" && request.method === "POST")
					return { body: await list(await request.json()) };
				const matched = /^\/custom-providers\/(custom-[a-z0-9-]+)(\/check)?$/.exec(request.path);
				if (matched === null) return undefined;
				const id = matched[1] ?? "";
				if (matched[2] === "/check" && request.method === "POST")
					return { body: await check(id, await request.json()) };
				if (matched[2] !== undefined) return undefined;
				if (request.method === "PUT") return { body: await edit(id, await request.json()) };
				if (request.method === "DELETE") return { body: await remove(id) };
				return undefined;
			},
		};
	},
};
