/** Owner-supplied remote MCP configuration. Credentials never belong in this shape. */
import { parseConnection, remoteUrl } from "./connections.ts";

export type McpConfig = {
	readonly url: string;
	readonly service: string;
	readonly auth: "auto" | "oauth" | "key" | "none";
	readonly client?: string;
	readonly scopes?: readonly string[];
};

export const MCP_CONFIG_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["url"],
	properties: {
		url: { type: "string", maxLength: 2000, description: "Remote HTTP MCP endpoint. No credentials or fragment." },
		service: { type: "string", maxLength: 80 },
		auth: { enum: ["auto", "oauth", "key", "none"], default: "auto" },
		client: { type: "string", maxLength: 200 },
		scopes: { type: "array", maxItems: 50, items: { type: "string", maxLength: 200 } },
	},
} as const;

/** Parts of a host that say where a server is, not whose it is. */
const GENERIC = new Set(["mcp", "api", "www", "app", "com", "dev", "io", "net", "org", "ai"]);

/** The word a server's address names it by: its host's first part that is not generic ("ernesto" of ernesto.example.com/mcp). */
export function hostWord(url: string): string {
	const host = new URL(url).hostname;
	// an address by number names nothing
	if (/^[\d.]+$/.test(host) || host.startsWith("[")) return "server";
	return host.split(".").find((part) => part !== "" && !GENERIC.has(part)) ?? host.split(".")[0] ?? "server";
}

/** A connection name made of `words`: lowercase, dashes, not starting with a digit, at most 40 characters. */
export function connectionWord(words: string): string {
	return (
		words
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.replace(/^(\d)/, "s$1")
			.slice(0, 40)
			.replace(/-+$/, "") || "server"
	);
}

/** How the owner reads a server that gave no name: its host's word, capitalised ("Ernesto"). */
export function serviceOf(url: string): string {
	const word = hostWord(url);
	return word.charAt(0).toUpperCase() + word.slice(1);
}

export function mcpConfig(input: unknown): McpConfig {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Give an MCP configuration.");
	const value = input as Record<string, unknown>;
	if (Object.keys(value).some((key) => !Object.hasOwn(MCP_CONFIG_SCHEMA.properties, key)))
		throw new Error("MCP configuration accepts url, service, auth, client and scopes. Enter credentials separately.");
	if (typeof value.url !== "string" || value.url.length > 2000 || !remoteUrl(value.url.trim()))
		throw new Error("Use an HTTPS server address, or HTTP on localhost, without credentials or a fragment.");
	const url = new URL(value.url.trim()).toString();
	const service = value.service === undefined || value.service === "" ? serviceOf(url) : value.service;
	if (
		typeof service !== "string" ||
		!service.trim() ||
		service.length > 80 ||
		/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(service)
	)
		throw new Error("Give the connection a short, single-line name.");
	const auth = value.auth ?? "auto";
	if (!["auto", "oauth", "key", "none"].includes(String(auth)))
		throw new Error("Choose automatic, OAuth, bearer or no sign-in.");
	if (value.client !== undefined && (typeof value.client !== "string" || !/^[\w.-]{1,200}$/.test(value.client)))
		throw new Error("Give a public OAuth client ID: letters, digits, dots, dashes and underscores.");
	if (
		value.scopes !== undefined &&
		(!Array.isArray(value.scopes) ||
			value.scopes.length > 50 ||
			!value.scopes.every((scope) => typeof scope === "string" && /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(scope)))
	)
		throw new Error("Give scopes as a list of names.");
	if ((auth === "key" || auth === "none") && (value.client !== undefined || value.scopes !== undefined))
		throw new Error("Client ID and scopes are only for OAuth.");
	const config: McpConfig = {
		url,
		service: service.trim(),
		auth: auth as McpConfig["auth"],
		...(value.client === undefined ? {} : { client: value.client as string }),
		...(value.scopes === undefined ? {} : { scopes: [...new Set(value.scopes as string[])] }),
	};
	// The file is the definition: configuration must round-trip without quoting or list ambiguity.
	const parsed = parseConnection("mcp", mcpDefinition(config, "oauth"));
	if (
		!("connection" in parsed) ||
		parsed.connection.service !== config.service ||
		JSON.stringify(parsed.connection.scopes) !== JSON.stringify(config.scopes)
	)
		throw new Error(
			"The name or scopes cannot be represented in a connection file. Remove surrounding quotes, brackets or commas.",
		);
	return config;
}

export function mcpDefinition(config: McpConfig, auth: "oauth" | "key" | "none"): string {
	return [
		"---",
		`service: ${config.service}`,
		`url: ${config.url}`,
		`auth: ${auth}`,
		...(config.client === undefined ? [] : [`client: ${config.client}`]),
		...(config.scopes === undefined ? [] : [`scopes: [${config.scopes.join(", ")}]`]),
		"reads: []",
		"ask: always",
		"---",
		"Added by you. Every tool asks first until you explicitly allow a read.",
		"",
	].join("\n");
}
