/**
 * A server's list of models, read when the owner asks: the route its kind documents (`SERVER_KINDS`), and only what that
 * route documents of each model. No model runs. Nothing is guessed: a fact the route does not give is left out, for
 * the owner to give for the model they start on. Each reader follows the documentation of its server:
 *
 * - OpenAI-compatible (and vLLM, and the Responses API): `GET <base>/models`, ids alone.
 * - Ollama: `GET /api/tags`, then `POST /api/show` for each, whose `capabilities` say `completion` for a model that
 *   answers at all, `tools`, `thinking` and `vision`, whose `parameters` may set `num_ctx`, and whose `model_info` has
 *   `<general.architecture>.context_length`, the most the model was made for; and `GET /api/ps`, whose loaded models
 *   carry the `context_length` Ollama runs them with. Ollama runs a model with far less than its most (4,096 tokens on
 *   many machines) unless told otherwise, and cuts a longer prompt silently: the context is what it runs with, from
 *   `num_ctx` or a loaded model, never the model's most, which is told apart (`contextLimit`).
 * - LM Studio: `GET /api/v0/models`, with `type` (`llm`, `vlm`, `embeddings`) and `max_context_length`, the most the
 *   model takes, not what it is loaded with: a limit, not the context.
 * - llama.cpp: `GET <base>/models`, and `GET /props`, whose `default_generation_settings.n_ctx` is the context the
 *   server runs with.
 * - Anthropic: `GET <base>/v1/models`, a page at a time, with `max_input_tokens`, `max_tokens` and `capabilities`.
 * - Mistral: `GET <base>/v1/models`, with `max_context_length` and `capabilities`.
 *
 * `test/fixtures/compat-server.ts` answers each route as its documentation shows.
 */
import type { CustomProvider, Listing } from "./custom-providers.ts";
import { SERVER_KINDS } from "./custom-providers.ts";

/** The most models one listing keeps, and the most bytes one answer may weigh. */
export const MAX_LISTED = 500;
const MAX_BYTES = 4 * 1024 * 1024;
/** The most models whose details an Ollama listing asks for, one request each. */
export const MAX_SHOWN = 40;
/** The most pages an Anthropic listing follows. */
const MAX_PAGES = 5;

/** A model a server listed, with what its route said of it. */
export type Listed = {
	readonly id: string;
	readonly name?: string;
	/** The context the server runs it with. */
	readonly contextWindow?: number;
	/** The most the model itself was made for, when the server runs it with less or does not say: a hint, never used. */
	readonly contextLimit?: number;
	readonly maxTokens?: number;
	readonly images?: boolean;
	readonly reasoning?: boolean;
	/** The route says it does not chat (an embedding model): it cannot be kept. */
	readonly chats?: false;
	/** The route says it calls no tools, which every agent of banda's does: it cannot be kept. */
	readonly tools?: false;
};

/** What a listing read: its routes, as said to the owner, and the models. */
export type ModelList = { readonly routes: readonly string[]; readonly models: readonly Listed[] };

/** The listing refused to make sense of an answer: what the route was expected to say. */
export class Unreadable extends Error {}

type Get = (url: string, init?: { method?: string; body?: string }) => Promise<unknown>;

const whole = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const list = (value: unknown, where: string): unknown[] => {
	if (!Array.isArray(value)) throw new Unreadable(`${where} is not a list`);
	return value.slice(0, MAX_LISTED);
};
/** A listed model with only the facts its route gave: an unknown one is left out, never kept as undefined. */
const drop = (
	value: { readonly id: string } & { readonly [K in Exclude<keyof Listed, "id">]?: Listed[K] | undefined },
): Listed => Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as Listed;

/** The address with its API's path (`/v1`) taken off: where a server's own routes (`/api/tags`, `/props`) answer. */
export function rootOf(baseUrl: string): string {
	const url = new URL(baseUrl);
	return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
}

const READERS: { readonly [L in Listing]: (base: string, get: Get) => Promise<ModelList> } = {
	openai: async (base, get) => {
		const body = record(await get(`${base}/models`));
		return {
			routes: ["GET /models"],
			models: list(body?.data, "data").flatMap((each) => {
				const id = text(record(each)?.id);
				return id === undefined ? [] : [{ id }];
			}),
		};
	},
	ollama: async (base, get) => {
		const root = rootOf(base);
		const tags = list(record(await get(`${root}/api/tags`))?.models, "models");
		const names = tags.flatMap((each) => text(record(each)?.name) ?? []);
		// the models loaded now, with the context Ollama runs each with
		const loaded = new Map<string, number>();
		if (names.length > 0) {
			const ps = record(await get(`${root}/api/ps`).catch(() => undefined));
			for (const each of Array.isArray(ps?.models) ? ps.models : []) {
				const name = text(record(each)?.name);
				const context = whole(record(each)?.context_length);
				if (name !== undefined && context !== undefined) loaded.set(name, context);
			}
		}
		const models: Listed[] = [];
		for (const [n, id] of names.entries()) {
			if (n >= MAX_SHOWN) {
				models.push(drop({ id, contextWindow: loaded.get(id) }));
				continue;
			}
			// a model Ollama can't describe is listed without its facts; the others keep theirs
			const shown = record(
				await get(`${root}/api/show`, { method: "POST", body: JSON.stringify({ model: id }) }).catch(() => undefined),
			);
			const info = record(shown?.model_info);
			const arch = text(info?.["general.architecture"]);
			const capabilities = Array.isArray(shown?.capabilities) ? shown.capabilities : undefined;
			const has = (name: string) => (capabilities === undefined ? undefined : capabilities.includes(name));
			const set = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(text(shown?.parameters) ?? "")?.[1];
			const context = (set === undefined ? undefined : whole(Number(set))) ?? loaded.get(id);
			const limit = arch === undefined ? undefined : whole(info?.[`${arch}.context_length`]);
			models.push(
				drop({
					id,
					contextWindow: context,
					contextLimit: limit !== undefined && limit !== context ? limit : undefined,
					images: has("vision"),
					reasoning: has("thinking"),
					chats: has("completion") === false ? (false as const) : undefined,
					tools: has("completion") === true && has("tools") === false ? (false as const) : undefined,
				}),
			);
		}
		return {
			routes: ["GET /api/tags", ...(names.length === 0 ? [] : ["GET /api/ps", "POST /api/show"])],
			models,
		};
	},
	lmstudio: async (base, get) => {
		const data = list(record(await get(`${rootOf(base)}/api/v0/models`))?.data, "data");
		return {
			routes: ["GET /api/v0/models"],
			models: data.flatMap((each) => {
				const model = record(each);
				const id = text(model?.id);
				if (id === undefined) return [];
				const type = text(model?.type);
				return [
					drop({
						id,
						contextLimit: whole(model?.max_context_length),
						images: type === undefined ? undefined : type === "vlm",
						chats: type === "embeddings" ? (false as const) : undefined,
					}),
				];
			}),
		};
	},
	llamacpp: async (base, get) => {
		const data = list(record(await get(`${base}/models`))?.data, "data");
		const props = record(await get(`${rootOf(base)}/props`).catch(() => undefined));
		// the context the server was started with: one model, served at that size
		const context = whole(record(props?.default_generation_settings)?.n_ctx);
		return {
			routes: ["GET /models", "GET /props"],
			models: data.flatMap((each) => {
				const id = text(record(each)?.id);
				return id === undefined ? [] : [drop({ id, contextWindow: data.length === 1 ? context : undefined })];
			}),
		};
	},
	anthropic: async (base, get) => {
		const models: Listed[] = [];
		let after: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const body = record(
				await get(`${base}/v1/models?limit=1000${after === undefined ? "" : `&after_id=${encodeURIComponent(after)}`}`),
			);
			for (const each of list(body?.data, "data")) {
				const model = record(each);
				const id = text(model?.id);
				if (id === undefined) continue;
				const capabilities = record(model?.capabilities);
				const supported = (name: string) => {
					const value = record(capabilities?.[name])?.supported;
					return typeof value === "boolean" ? value : undefined;
				};
				models.push(
					drop({
						id,
						name: text(model?.display_name),
						contextWindow: whole(model?.max_input_tokens),
						maxTokens: whole(model?.max_tokens),
						images: supported("image_input"),
						reasoning: supported("thinking"),
					}),
				);
			}
			after = body?.has_more === true ? text(body.last_id) : undefined;
			if (after === undefined || models.length >= MAX_LISTED) break;
		}
		return { routes: ["GET /v1/models"], models: models.slice(0, MAX_LISTED) };
	},
	mistral: async (base, get) => {
		const body = await get(`${base}/v1/models`);
		// documented both as a bare list and as `{ data }`
		const data = list(Array.isArray(body) ? body : record(body)?.data, "data");
		return {
			routes: ["GET /v1/models"],
			models: data.flatMap((each) => {
				const model = record(each);
				const id = text(model?.id);
				if (id === undefined) return [];
				const capabilities = record(model?.capabilities);
				const flag = (name: string) =>
					typeof capabilities?.[name] === "boolean" ? (capabilities[name] as boolean) : undefined;
				return [
					drop({
						id,
						contextWindow: whole(model?.max_context_length),
						images: flag("vision"),
						chats: flag("completion_chat") === false ? (false as const) : undefined,
					}),
				];
			}),
		};
	},
};

/** The headers a listing sends its key in, as the server's kind takes it. */
function headersOf(definition: Pick<CustomProvider, "kind">, key: string | undefined): Record<string, string> {
	const api = SERVER_KINDS[definition.kind].api;
	if (api === "anthropic-messages")
		return { "anthropic-version": "2023-06-01", ...(key === undefined ? {} : { "x-api-key": key }) };
	return key === undefined ? {} : { authorization: `Bearer ${key}` };
}

/**
 * The models `definition`'s server lists, through `fetch` (the daemon's guard: no redirect, no key to a keyless one).
 * Throws what the request did (a status, a network error) or `Unreadable`.
 */
export async function listModels(
	definition: Pick<CustomProvider, "kind" | "baseUrl">,
	key: string | undefined,
	fetch: typeof globalThis.fetch,
	signal?: AbortSignal,
): Promise<ModelList> {
	const headers = headersOf(definition, key);
	const get: Get = async (url, init = {}) => {
		const response = await fetch(url, {
			method: init.method ?? "GET",
			headers: {
				accept: "application/json",
				...headers,
				...(init.body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(init.body === undefined ? {} : { body: init.body }),
			...(signal === undefined ? {} : { signal }),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new ListingStatus(response.status);
		}
		const body = await bounded(response);
		try {
			return JSON.parse(body) as unknown;
		} catch {
			throw new Unreadable("the answer is not JSON");
		}
	};
	const base = definition.baseUrl.replace(/\/+$/, "");
	return READERS[SERVER_KINDS[definition.kind].listing](base, get);
}

/** A response's body as text, refused once it passes `MAX_BYTES`: read as it comes, never whole first. */
async function bounded(response: Response): Promise<string> {
	const tooLarge = () => new Unreadable("the answer is too large to be a list of models");
	if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) {
		await response.body?.cancel().catch(() => {});
		throw tooLarge();
	}
	if (response.body === null) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BYTES) {
			await reader.cancel().catch(() => {});
			throw tooLarge();
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A listing's request answered with a status that is no list. */
export class ListingStatus extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`the server answered ${status}`);
		this.status = status;
	}
}
