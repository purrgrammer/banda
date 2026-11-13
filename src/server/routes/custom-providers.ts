/**
 * Custom providers (`../../core/custom-providers.ts`): the owner adds, edits and removes them here, and checks one when
 * they say so. Saving never reaches the endpoint; a check is one short request, asked for by name, to the address it
 * shows. The key goes to the provider credentials (`auth/providers.json`) and never comes back out; the definition
 * goes to `<home>/custom-providers.json`, and the tiers the owner chose for it to the companion's choice of models, as
 * any provider's own models do.
 *
 * A provider the band thinks with, or that an agent's file or a chat still runs on, is not removed, nor a model of it
 * one still runs on, until the owner moves them: nothing switches to another model on its own.
 */
import { AgentDoc, type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { Accepted, ChatTier, parseAgent } from "../../core/agents.ts";
import { Companion, type CompanionDoc } from "../../core/companion.ts";
import {
	changeCustomProviders,
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
	modelName,
	type Observed,
	originOf,
	problemsOf,
} from "../../core/custom-providers.ts";
import { FileCredentialStore } from "../../core/provider-credentials.ts";
import { context } from "../../core/store.ts";
import { usageRecorder } from "../../core/system-usage.ts";
import { providerOf, TIERS, type Tier } from "../../core/tiers.ts";
import type { Checked, CustomProvidersView } from "../api/custom-providers.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule, Deps } from "./area.ts";
import { clearTiers, setTiers } from "./tiers.ts";

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
	if (!Array.isArray(body.models)) throw new BadRequest("provider.models is a list");
	const models = body.models.map((each: unknown, n): CustomModel => {
		if (typeof each !== "object" || each === null) throw new BadRequest(`provider.models.${n} is a model`);
		const model = each as Record<string, unknown>;
		// a price is the owner's word, never a default: 0 is free, said so
		if (typeof model.cost !== "object" || model.cost === null)
			throw new BadRequest(`provider.models.${n}.cost is its price per million tokens in and out: 0 only if free`);
		const cost = model.cost as Record<string, unknown>;
		const name = model.name === undefined ? "" : text(model.name, `provider.models.${n}.name`).trim();
		return {
			id: text(model.id, `provider.models.${n}.id`).trim(),
			...(name === "" ? {} : { name }),
			images: flag(model.images ?? false, `provider.models.${n}.images`),
			reasoning: flag(model.reasoning ?? false, `provider.models.${n}.reasoning`),
			contextWindow: number(model.contextWindow, `provider.models.${n}.contextWindow`),
			maxTokens: number(model.maxTokens, `provider.models.${n}.maxTokens`),
			cost: {
				input: number(cost.input, `provider.models.${n}.cost.input`),
				output: number(cost.output, `provider.models.${n}.cost.output`),
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
		baseUrl: "error" in destination ? baseUrl : destination.url,
		key,
		models,
		...(compat === undefined || Object.keys(compat).length === 0 ? {} : { compat }),
	};
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
						baseUrl: provider.baseUrl,
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
			const tiers = tiersOf(body.tiers, definition.models);
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
			await setTiers(deps, id, tiers, body.use === true);
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
			const tiers = tiersOf(body.tiers, definition.models);
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
