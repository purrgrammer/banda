/**
 * Custom providers (DESIGN.md "How hard it thinks is three words"): an endpoint the owner names that speaks OpenAI's
 * chat completions, hosted or on a computer of their own, with the models they declare by hand. pi-ai has no loader for
 * such a provider; banda owns its definition, `<home>/custom-providers.json`, outside the box and the store, written
 * only through the owner's API (`../server/routes/custom-providers.ts`) and checked against `./custom-provider.ts`'s
 * schema on every read. Its key, if it takes one, is a provider credential like any other (`./provider-credentials.ts`).
 *
 * Plain data and rules, shared with the web, which says the same things before the daemon refuses them.
 */

/** Every custom provider's id starts so: no pi-ai provider does, and none is an account (`@`) or a path (`/`). */
export const CUSTOM_PREFIX = "custom-";
export const isCustomProvider = (id: string): boolean => id.startsWith(CUSTOM_PREFIX);

export const MAX_NAME = 60;
export const MAX_MODELS = 32;
export const MAX_MODEL_ID = 200;
export const MAX_URL = 2000;
/** The widest context a model may declare, and the most it may answer, in tokens. */
export const MAX_CONTEXT = 10_000_000;
export const MAX_OUTPUT = 1_000_000;
/** The highest price, in dollars per million tokens, a model may declare: a typo, past it. */
export const MAX_PRICE = 10_000;

/** A model the owner declares: what the endpoint calls it, and what it can do, by their word. */
export type CustomModel = {
	/** The endpoint's own name for it, sent as `model`. */
	readonly id: string;
	/** Its name in the app; the id when unset. */
	readonly name?: string;
	/** Whether it reads images as well as text. */
	readonly images: boolean;
	/** Whether it thinks before it answers (a reasoning model). */
	readonly reasoning: boolean;
	/** How many tokens it reads at once, its answer included. */
	readonly contextWindow: number;
	/** The most tokens one answer takes. */
	readonly maxTokens: number;
	/** What it costs, in dollars per million tokens; 0 when free or unknown. */
	readonly cost: { readonly input: number; readonly output: number };
};

/**
 * How the endpoint differs from OpenAI's own, where they commonly do; unset fields take banda's defaults for an
 * endpoint it does not know (`COMPAT_DEFAULTS`), which most local servers accept. A bounded set, never free-form.
 */
export type CustomCompat = {
	/** The role of the instructions to a reasoning model: `developer` (OpenAI's) or `system`. */
	readonly instructions?: "system" | "developer";
	/** The field the answer's length limit goes in. */
	readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
	/** Send `store: false`, as OpenAI takes it. */
	readonly store?: boolean;
	/** Send `reasoning_effort` to a reasoning model. */
	readonly reasoningEffort?: boolean;
};

export const COMPAT_DEFAULTS: Required<CustomCompat> = {
	instructions: "system",
	maxTokensField: "max_tokens",
	store: false,
	reasoningEffort: false,
};

/** A custom provider as `<home>/custom-providers.json` holds it. */
export type CustomProvider = {
	readonly id: string;
	readonly name: string;
	/** The address its API answers under, as `https://host/v1`: `chat/completions` follows it. */
	readonly baseUrl: string;
	/** Whether it takes a key; the key itself is a provider credential, never here. */
	readonly key: "required" | "none";
	readonly models: readonly CustomModel[];
	readonly compat?: CustomCompat;
};

/** `<home>/custom-providers.json`. */
export type CustomProvidersFile = { readonly providers: readonly CustomProvider[] };

/**
 * Where an address sends what the band says, as the owner should read it: on the computer banda runs on (`computer`,
 * which on a phone is still that computer, never the phone), elsewhere on their own network (`network`, an address no
 * one outside it reaches), or out on the internet (`internet`).
 */
export type Place = "computer" | "network" | "internet";

export type Destination = {
	readonly place: Place;
	/** The host and port, as the owner wrote them. */
	readonly host: string;
	readonly secure: boolean;
	/** The address, normalized: no trailing slash. */
	readonly url: string;
};

const ipv4 = (host: string): number[] | undefined => {
	const parts = host.split(".");
	if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined;
	const numbers = parts.map(Number);
	return numbers.every((n) => n <= 255) ? numbers : undefined;
};

/** Where `host` (a URL's hostname, an IPv6 one in brackets) is, or why banda will not send anything there. */
function placeOf(host: string): Place | { readonly refused: string } {
	const name = host.toLowerCase().replace(/\.$/, "");
	if (name === "localhost" || name.endsWith(".localhost")) return "computer";
	const v4 = ipv4(name);
	if (v4 !== undefined) {
		const [a = 0, b = 0] = v4;
		if (a === 127) return "computer";
		if (a === 0) return { refused: "0.0.0.0 is no address to send to: write 127.0.0.1 for this computer" };
		if (a === 169 && b === 254)
			return { refused: "169.254.x.x is a link-local address (a cloud's metadata service among them), not a model" };
		if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127))
			return "network";
		if (a >= 224) return { refused: `${name} is not an address a server answers on` };
		return "internet";
	}
	if (name.startsWith("[")) {
		const v6 = name.slice(1, -1);
		if (v6 === "::1") return "computer";
		if (v6 === "::" || v6.startsWith("::ffff:"))
			return { refused: "write the address as IPv4, or 127.0.0.1 for this computer" };
		if (/^fe[89ab]/.test(v6)) return { refused: `${name} is a link-local address, not a model` };
		if (/^f[cd]/.test(v6)) return "network";
		return "internet";
	}
	// a name of the owner's own network: one word, or one of the names kept for local networks
	if (!name.includes(".") || /\.(local|lan|home\.arpa|internal)$/.test(name)) return "network";
	return "internet";
}

/**
 * The address `value` names, checked: http or https, no credentials, query or fragment in it, and plain http only on
 * this computer or the owner's own network, where nothing they say crosses the internet in the clear.
 */
export function destinationOf(value: string): Destination | { readonly error: string } {
	const text = value.trim();
	if (text === "") return { error: "Write the address its API answers on, such as http://localhost:11434/v1" };
	if (text.length > MAX_URL) return { error: `The address is at most ${MAX_URL} characters` };
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { error: "That is not an address: write it whole, with http:// or https://" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		return { error: "The address starts with http:// or https://" };
	if (url.username !== "" || url.password !== "")
		return { error: "Leave the name and password out of the address: give a key below instead" };
	if (url.search !== "" || url.hash !== "") return { error: "Leave ? and # out of the address" };
	if (url.hostname === "") return { error: "The address names no host" };
	const place = placeOf(url.hostname);
	if (typeof place !== "string") return { error: `${place.refused[0]?.toUpperCase()}${place.refused.slice(1)}` };
	const secure = url.protocol === "https:";
	if (!secure && place === "internet")
		return {
			error: `Use https:// for ${url.hostname}: over http, everything the band says and its key would cross the internet unencrypted`,
		};
	return { place, host: url.host, secure, url: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

/** An address's origin, as a key is bound to it: changing it asks for the key again. */
export const originOf = (baseUrl: string): string | undefined => {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return undefined;
	}
};

/** The id a new provider named `name` gets, unique among `taken`. */
export function customId(name: string, taken: ReadonlySet<string>): string {
	const base =
		name
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32) || "provider";
	const id = `${CUSTOM_PREFIX}${base}`;
	if (!taken.has(id)) return id;
	for (let n = 2; ; n++) if (!taken.has(`${id}-${n}`)) return `${id}-${n}`;
}

const whole = (value: number, low: number, high: number) =>
	Number.isSafeInteger(value) && value >= low && value <= high;
const price = (value: number) => Number.isFinite(value) && value >= 0 && value <= MAX_PRICE;
/** A model id: printable, no spaces or control characters, as servers name them (`llama3.1:8b`, `org/model`). */
const MODEL_ID = /^[^\s\p{C}]+$/u;

/**
 * What is wrong with `provider` as the owner wrote it, in their words, by the field it is about (`name`, `baseUrl`,
 * `models`, `models.2.contextWindow`, …); empty when nothing is. `others` are the names of the other custom providers.
 */
export function problemsOf(
	provider: Omit<CustomProvider, "id">,
	others: readonly string[] = [],
): { readonly field: string; readonly message: string }[] {
	const problems: { field: string; message: string }[] = [];
	const say = (field: string, message: string) => problems.push({ field, message });
	const name = provider.name.trim();
	if (name === "") say("name", "Give it a name you will know it by");
	else if (name.length > MAX_NAME) say("name", `The name is at most ${MAX_NAME} characters`);
	else if (others.some((other) => other.trim().toLowerCase() === name.toLowerCase()))
		say("name", `There is a provider called ${name} already: name this one differently`);
	const destination = destinationOf(provider.baseUrl);
	if ("error" in destination) say("baseUrl", destination.error);
	if (provider.models.length === 0) say("models", "Add the model it runs: at least one");
	if (provider.models.length > MAX_MODELS) say("models", `At most ${MAX_MODELS} models`);
	const seen = new Set<string>();
	provider.models.forEach((model, n) => {
		const at = (field: string) => `models.${n}.${field}`;
		const id = model.id.trim();
		if (id === "") say(at("id"), "Write the model's name as the server knows it");
		else if (id.length > MAX_MODEL_ID || !MODEL_ID.test(id))
			say(at("id"), "A model's name has no spaces, and is at most 200 characters");
		else if (seen.has(id)) say(at("id"), `${id} is listed twice`);
		seen.add(id);
		if ((model.name ?? "").length > MAX_NAME) say(at("name"), `A name is at most ${MAX_NAME} characters`);
		if (!whole(model.contextWindow, 1024, MAX_CONTEXT))
			say(at("contextWindow"), "The context is a whole number of tokens, from 1,024 to 10,000,000");
		if (!whole(model.maxTokens, 16, MAX_OUTPUT))
			say(at("maxTokens"), "The longest answer is a whole number of tokens, from 16 to 1,000,000");
		else if (whole(model.contextWindow, 1024, MAX_CONTEXT) && model.maxTokens > model.contextWindow)
			say(at("maxTokens"), "The longest answer cannot be more than the context it fits in");
		if (!price(model.cost.input)) say(at("cost.input"), "A price is a number of dollars, 0 or more");
		if (!price(model.cost.output)) say(at("cost.output"), "A price is a number of dollars, 0 or more");
	});
	return problems;
}

/** A model's name in the app. */
export const modelName = (model: Pick<CustomModel, "id" | "name">): string =>
	model.name === undefined || model.name.trim() === "" ? model.id : model.name.trim();
