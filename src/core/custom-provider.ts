/**
 * A custom provider (`./custom-providers.ts`) as the daemon keeps and runs it: `<home>/custom-providers.json`, checked
 * against its schema on every read and written whole, owner-only, renamed into place; and the pi-ai provider each
 * definition makes, registered before the store opens so a chat that ran on one resumes on it.
 *
 * Its endpoint is a destination the owner trusts with every prompt, and with its key if it takes one. Nothing else
 * reaches it: the definition is never in the box or the store, and only the owner's API writes it. A request to it does
 * not follow redirects, so neither the key nor a prompt is sent anywhere the owner did not write; a keyless one sends
 * no Authorization header at all; and an error it answers with is told without the key or anything shaped like one.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type ApiKeyAuth,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	type Model,
	type MutableModels,
	type Provider,
	type ProviderStreams,
	type Static,
	Type,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Value } from "typebox/value";
import {
	COMPAT_DEFAULTS,
	CUSTOM_PREFIX,
	type CustomProvider,
	type CustomProvidersFile,
	MAX_CONTEXT,
	MAX_MODEL_ID,
	MAX_MODELS,
	MAX_NAME,
	MAX_OUTPUT,
	MAX_PRICE,
	MAX_URL,
	modelName,
	type Observed,
	problemsOf,
} from "./custom-providers.ts";

export const customProvidersPath = (home: string) => join(home, "custom-providers.json");

const Model_ = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: MAX_MODEL_ID }),
		name: Type.Optional(Type.String({ maxLength: MAX_NAME })),
		images: Type.Boolean(),
		reasoning: Type.Boolean(),
		contextWindow: Type.Integer({ minimum: 1024, maximum: MAX_CONTEXT }),
		maxTokens: Type.Integer({ minimum: 16, maximum: MAX_OUTPUT }),
		cost: Type.Object(
			{
				input: Type.Number({ minimum: 0, maximum: MAX_PRICE }),
				output: Type.Number({ minimum: 0, maximum: MAX_PRICE }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

/** `custom-providers.json`'s schema. */
export const CustomProvidersSchema = Type.Object(
	{
		providers: Type.Array(
			Type.Object(
				{
					id: Type.String({ pattern: `^${CUSTOM_PREFIX}[a-z0-9-]{1,40}$` }),
					name: Type.String({ minLength: 1, maxLength: MAX_NAME }),
					baseUrl: Type.String({ minLength: 1, maxLength: MAX_URL }),
					key: Type.Union([Type.Literal("required"), Type.Literal("none")]),
					models: Type.Array(Model_, { minItems: 1, maxItems: MAX_MODELS }),
					compat: Type.Optional(
						Type.Object(
							{
								instructions: Type.Optional(Type.Union([Type.Literal("system"), Type.Literal("developer")])),
								maxTokensField: Type.Optional(
									Type.Union([Type.Literal("max_tokens"), Type.Literal("max_completion_tokens")]),
								),
								store: Type.Optional(Type.Boolean()),
								reasoningEffort: Type.Optional(Type.Boolean()),
							},
							{ additionalProperties: false },
						),
					),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 64 },
		),
	},
	{ additionalProperties: false, title: "custom-providers.json" },
);
type Schema = Static<typeof CustomProvidersSchema>;
// the schema and the shared type say the same
const _same: (value: Schema) => CustomProvidersFile = (value) => value;
void _same;

/** What the file says is wrong with itself: its schema, then each definition's own rules, and no id twice. */
export function fileProblem(value: unknown): string | undefined {
	if (!Value.Check(CustomProvidersSchema, value)) {
		const [first] = Value.Errors(CustomProvidersSchema, value);
		return `custom-providers.json does not fit its schema${first === undefined ? "" : `: ${first.instancePath} ${first.message}`}`;
	}
	const ids = new Set<string>();
	for (const provider of value.providers) {
		if (ids.has(provider.id)) return `custom-providers.json names ${provider.id} twice`;
		ids.add(provider.id);
		const others = value.providers.filter((other) => other.id !== provider.id).map((other) => other.name);
		const [problem] = problemsOf(provider, others);
		if (problem !== undefined) return `custom-providers.json: ${provider.id} ${problem.field}: ${problem.message}`;
	}
	return undefined;
}

/** Writes to the file, in turn, per home: one change must not lose another. */
const chains = new Map<string, Promise<unknown>>();

/** The owner's custom providers, read whole and checked on every read; a file that does not fit throws, saying why. */
export async function readCustomProviders(home: string): Promise<CustomProvidersFile> {
	let text: string;
	try {
		text = await readFile(customProvidersPath(home), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: [] };
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("custom-providers.json is not JSON");
	}
	const problem = fileProblem(value);
	if (problem !== undefined) throw new Error(problem);
	return value as CustomProvidersFile;
}

/**
 * Change the file as `change` says, from what it holds now, in turn with every other change of this home's; nothing is
 * written when `change` throws or the result does not fit. Resolves with what `change` returned.
 */
export function changeCustomProviders<T>(
	home: string,
	change: (file: CustomProvidersFile) => Promise<{ file: CustomProvidersFile; result: T }>,
): Promise<T> {
	const key = customProvidersPath(home);
	const run = (chains.get(key) ?? Promise.resolve())
		.catch(() => {})
		.then(async () => {
			const { file, result } = await change(await readCustomProviders(home));
			const problem = fileProblem(file);
			if (problem !== undefined) throw new Error(problem);
			if (file.providers.length === 0) await rm(key, { force: true });
			else {
				await mkdir(home, { recursive: true, mode: 0o700 });
				const temporary = `${key}.${process.pid}.tmp`;
				await writeFile(temporary, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
				await rename(temporary, key);
			}
			return result;
		});
	chains.set(key, run);
	void run.finally(() => {
		if (chains.get(key) === run) chains.delete(key);
	});
	return run;
}

/**
 * The key a keyless provider's requests carry inside pi-ai, which needs one; the request itself never sends it
 * (`guardedFetch` drops the header).
 */
const KEYLESS = "banda-keyless";
/** pi-ai's label for a stored credential (`../server/routes/providers.ts`). */
const STORED = "stored credential";
/** What a keyless provider's auth says it came from. */
export const NO_KEY = "no key";

function auth(definition: CustomProvider): ApiKeyAuth {
	if (definition.key === "none")
		return {
			name: `${definition.name} (no key)`,
			resolve: async () => ({ auth: { apiKey: KEYLESS }, source: NO_KEY }),
		};
	return {
		name: `${definition.name} key`,
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: `Enter the key for ${definition.name}` });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		// only the key the owner gave banda for it: never one from the environment
		resolve: async ({ credential }) =>
			credential?.key ? { auth: { apiKey: credential.key }, source: STORED } : undefined,
	};
}

/**
 * `fetch` for one provider's requests: a redirect is refused, not followed, so a prompt and a key go only to the
 * address the owner wrote; a keyless provider's carry no Authorization header.
 */
export function guardedFetch(definition: Pick<CustomProvider, "key">, base: typeof fetch = fetch): typeof fetch {
	return async (input, init) => {
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		if (definition.key === "none") headers.delete("authorization");
		const response = await base(input, { ...init, headers, redirect: "manual" });
		if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
			await response.body?.cancel().catch(() => {});
			// an answer of its own, not a thrown error: the client would retry a failed connection and say only that it
			// failed, where this is told as it is, once (421 is not one it retries)
			return Response.json(
				{
					error: {
						message: `the endpoint redirects (${response.status}) and banda does not follow a custom provider's redirects: write the address it redirects to`,
					},
				},
				{ status: 421 },
			);
		}
		return response;
	};
}

/** Anything long and key-shaped, and the key itself, out of `text`. */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
	let out = text;
	for (const secret of secrets)
		if (secret !== undefined && secret.length >= 4 && secret !== KEYLESS) out = out.split(secret).join("[key]");
	return out
		.replace(/\b(Bearer|Basic)\s+[^\s"',]+/gi, "$1 [key]")
		.replace(/\b(sk|pk|rk|key|api|tok|token)[-_][A-Za-z0-9_-]{8,}/gi, "[key]")
		.replace(/[A-Za-z0-9_-]{32,}/g, "[key]")
		.slice(0, 500);
}

/** `inner` with its error's words redacted of `key`. */
function redacted(inner: AssistantMessageEventStream, key: string | undefined): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of inner) outer.push(clean(event, key));
		} finally {
			outer.end();
		}
	})();
	return outer;
}

function clean(event: AssistantMessageEvent, key: string | undefined): AssistantMessageEvent {
	if (event.type !== "error" || event.error.errorMessage === undefined) return event;
	return { ...event, error: { ...event.error, errorMessage: redact(event.error.errorMessage, [key]) } };
}

/** pi-ai's openai-completions streams, every request through `guardedFetch` and every error redacted. */
function guardedApi(definition: CustomProvider, api: ProviderStreams = openAICompletionsApi()): ProviderStreams {
	// a caller's own fetch (a check's, which watches what its request showed) runs inside the guard, never around it
	const guarded = (given: typeof fetch | undefined) => guardedFetch(definition, given ?? globalThis.fetch);
	return {
		stream: (model, context, options) =>
			redacted(api.stream(model, context, { ...options, fetch: guarded(options?.fetch) }), options?.apiKey),
		streamSimple: (model, context, options) =>
			redacted(api.streamSimple(model, context, { ...options, fetch: guarded(options?.fetch) }), options?.apiKey),
	};
}

/** `fetch` that keeps what each request showed in `seen`: its status, or its network error's code. */
export function observingFetch(seen: Observed[], base: typeof fetch = globalThis.fetch): typeof fetch {
	return async (input, init) => {
		try {
			const response = await base(input, init);
			seen.push({ status: response.status });
			return response;
		} catch (error) {
			const cause = (error as { cause?: { code?: unknown } }).cause;
			const code = typeof cause?.code === "string" ? cause.code : (error as { code?: unknown }).code;
			seen.push({ code: typeof code === "string" ? code : "UNKNOWN" });
			throw error;
		}
	};
}

/** The pi-ai model a declared one is. */
export function modelOf(definition: CustomProvider, index: number): Model<"openai-completions"> {
	const model = definition.models[index];
	if (model === undefined) throw new Error(`${definition.id} has no model ${index}`);
	const compat = { ...COMPAT_DEFAULTS, ...definition.compat };
	return {
		id: model.id,
		name: modelName(model),
		api: "openai-completions",
		provider: definition.id,
		baseUrl: definition.baseUrl.replace(/\/+$/, ""),
		input: model.images ? ["text", "image"] : ["text"],
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: { input: model.cost.input, output: model.cost.output, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsDeveloperRole: compat.instructions === "developer",
			maxTokensField: compat.maxTokensField,
			supportsStore: compat.store,
			supportsReasoningEffort: compat.reasoningEffort,
			supportsUsageInStreaming: true,
			// never an OpenRouter or other host's quirks, whatever the address looks like
			thinkingFormat: "openai",
			sendSessionAffinityHeaders: false,
			supportsLongCacheRetention: false,
		},
	};
}

/** The pi-ai provider `definition` makes. */
export function customProvider(definition: CustomProvider, api?: ProviderStreams): Provider {
	return createProvider({
		id: definition.id,
		name: definition.name,
		baseUrl: definition.baseUrl,
		auth: { apiKey: auth(definition) },
		models: definition.models.map((_, n) => modelOf(definition, n)),
		api: guardedApi(definition, api),
	});
}

/**
 * Register every custom provider `home` defines in `models`, replacing what was registered for one, and forget those it
 * no longer defines. A file that does not fit registers none and says why: a chat on one then fails saying its model is
 * unknown, never runs on another.
 */
export async function registerCustomProviders(
	models: MutableModels,
	home: string,
	log: (line: string) => void = () => {},
	api?: ProviderStreams,
): Promise<{ readonly error?: string }> {
	let file: CustomProvidersFile;
	let error: string | undefined;
	try {
		file = await readCustomProviders(home);
	} catch (thrown) {
		error = thrown instanceof Error ? thrown.message : String(thrown);
		log(`custom providers: ${error}`);
		file = { providers: [] };
	}
	const defined = new Set(file.providers.map((provider) => provider.id));
	for (const provider of models.getProviders())
		if (provider.id.startsWith(CUSTOM_PREFIX) && !defined.has(provider.id)) models.deleteProvider(provider.id);
	for (const definition of file.providers) models.setProvider(customProvider(definition, api));
	return error === undefined ? {} : { error };
}
