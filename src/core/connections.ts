/**
 * Connections and the agent's own tools (DESIGN.md "Connections", "The workspace"): what the agent may use beyond its
 * box, each a "before" file it writes and the owner accepts.
 *
 * - `connections/<name>.md`: an MCP server, remote (`url`, called by the daemon outside the box with the credentials it
 *   keeps in `auth/`) or the agent's own (`command`, run in the box over stdio, reaching outside only through the egress
 *   proxy). The file says which of its tools only read; every other tool of a remote server is a write, a draft the
 *   owner approves, and a tool it names under a floor class asks every time.
 * - `tools/<name>.md`: a command in the box, with the JSON schema of the arguments the model gives it.
 *
 * The store holds what is in effect: the accepted files (in `Accepted`, like every "before" file), the tools a server
 * listed when it was connected for that accepted file, the accounts signed in to each (an account is one sign-in, named
 * by what the service calls the owner), and the owner's switches: per tool, and per agent and account. Credentials
 * never enter it: they live in `auth/connections/<connection>/<account>/`, bound to the URL they were given for, so a
 * changed URL never carries them along. The store is the truth of which accounts exist: credentials it does not name
 * are a sign-in that did not finish, or a sign-out that did, and are forgotten.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineDoc, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import { Accepted, AGENT_NAME, type Agent, agentPath, frontmatter, LEAD, parseAgent } from "./agents.ts";
import { FLOORS, type Floor } from "./floor.ts";
import { harnessToolsOf } from "./harness.ts";
import { DEFAULT_GOOGLE_CLIENT_ID, type OAuthClient, type OAuthServer, type Pending, type Tokens } from "./oauth.ts";
import { type ObjectKinds, parseObjects, plainLine } from "./objects.ts";
import { REST_APIS, type RestApiName, restApiNamed } from "./rest.ts";

export const connectionPath = (name: string) => `connections/${name}.md`;
export const toolPath = (name: string) => `tools/${name}.md`;

/** What a connection or tool file may weigh. */
export const MAX_DEFINITION_BYTES = 64 * 1024;

/** How the daemon signs in to a remote server: not at all, with a key the owner types, or with OAuth. */
export type AuthKind = "none" | "key" | "oauth";

/** A connection as its file says. */
export type Connection = {
	readonly name: string;
	/** The service, as the owner calls it: "your calendar", "Linear". */
	readonly service: string;
	/** A remote server's URL; or `command`, a server the agent built, run in its box. */
	readonly url?: string;
	readonly command?: string;
	/** A built-in daemon REST adapter, whose API does not speak MCP. */
	readonly api?: RestApiName;
	readonly auth: AuthKind;
	/** Uncurated remote tools ask every time; only owner-declared reads bypass approval. */
	readonly ask?: "always";
	/**
	 * The client the daemon signs in as, for a server that lets no app register itself (`auth: oauth` only). A public
	 * id: it names the app, proves nothing alone, and a sign-in with it is by code when the server offers that.
	 */
	readonly client?: string;
	/**
	 * The scopes a new account asks for unless the owner chooses others, as the file says: never what the server
	 * advertises it could grant. With every scope `needs` names, it is what an account may ask for (`ceilingOf`).
	 */
	readonly scopes?: readonly string[];
	/**
	 * The scope each tool always needs, as the file says (a ```json block, `{"needs": {tool: [scope, …]}}`): any one of
	 * those listed will do. The app shows a tool the sign-in was not given one for as needing it.
	 */
	readonly needs?: { readonly [tool: string]: readonly string[] };
	/**
	 * When a tool only reads for some arguments (one tool that runs many routes): a rule each, written in `reads` as
	 * `tool(arg=value)`. A call whose argument is exactly that string runs as a read; any other asks. No prefixes: a
	 * server may route `resolve-and-settle` or `resolve/../settle` elsewhere, which a prefix would let run unasked.
	 */
	readonly readsWhen?: { readonly [tool: string]: readonly ReadRule[] };
	/** The tools the agent says only read: they run when called. Every other tool of a remote server is a write. */
	readonly reads: readonly string[];
	/** Tools on the floor, by tool: they ask every time, whatever was allowed ahead. */
	readonly floors: { readonly [tool: string]: Floor };
	/**
	 * How the daemon learns whom a sign-in is for, once, right after it: a read tool of the server, called with no
	 * arguments, and the field of its JSON answer that names the owner there (`account: get_me.login`). Without it each
	 * sign-in is an account of its own, numbered.
	 */
	readonly account?: { readonly tool: string; readonly field: string };
	/** The things it names that the app draws as cards (DESIGN.md "Connections", objects), by kind. */
	readonly objects?: ObjectKinds;
	/** Why the agent wants it, in its words: an owner-added file's body; a definition banda ships has none. */
	readonly why?: string;
	/** What it lets the band do, in a line for the owner: a definition banda ships says it. */
	readonly about?: string;
	/** The access the owner chooses among before signing in, in words: a definition banda ships says them. */
	readonly access?: Access;
};

/**
 * The access an owner chooses for a connection before signing in: the words for the scopes every account asks for
 * (`required`, a built-in API's), each choice with the scopes it stands for, and what changing access means.
 */
export type Access = {
	readonly required?: string;
	readonly choices: readonly { readonly label: string; readonly note?: string; readonly scopes: readonly string[] }[];
	readonly note: string;
};

/** One argument and the one string it is: a call whose argument is exactly that only reads. */
export type ReadRule = { readonly arg: string; readonly value: string };

/** A rule in a `reads` list, `tool(arg=value)`: its value printable ASCII, no spaces or parentheses. */
const RULE = /^([A-Za-z0-9_.-]{1,64})\(([A-Za-z0-9_]{1,64})=([\x21-\x27\x2a-\x7e]{1,200})\)$/;

/** Whether `args` match one of `rules`: the named argument, at the top, is a string equal to the rule's value. */
export function readsFor(rules: readonly ReadRule[] | undefined, args: unknown): boolean {
	if (rules === undefined || typeof args !== "object" || args === null) return false;
	return rules.some((rule) => (args as { [arg: string]: unknown })[rule.arg] === rule.value);
}

/** A tool the agent built: a command in its box, and the schema of its arguments. */
export type OwnTool = {
	readonly name: string;
	readonly description: string;
	readonly command: string;
	readonly parameters: { readonly [key: string]: unknown };
};

const CONNECTION_FIELDS = [
	"service",
	"url",
	"command",
	"api",
	"auth",
	"ask",
	"client",
	"scopes",
	"account",
	"reads",
	...FLOORS,
] as const;
const TOOL_FIELDS = ["description", "command"] as const;

/** Whether `url` may be a remote server's: https, or http on this machine. */
export function remoteUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
		return (
			!parsed.username &&
			!parsed.password &&
			!parsed.hash &&
			(parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback))
		);
	} catch {
		return false;
	}
}

type ParsedConnection = { readonly connection: Connection } | { readonly errors: readonly string[] };

/** The newest connection files parsed, by name and text: a file is parsed once per version, however often it is read. */
const PARSED = new Map<string, ParsedConnection>();
const PARSED_KEPT = 32;

/**
 * Parse a connection file; every problem is reported, each saying what to write instead. The same text parses to the
 * same (shared, read-only) result: the accepted file is read at every object access, read and look.
 */
export function parseConnection(name: string, text: string): ParsedConnection {
	const key = `${name}\n${text}`;
	const known = PARSED.get(key);
	if (known !== undefined) return known;
	const parsed = parseConnectionText(name, text);
	PARSED.set(key, parsed);
	if (PARSED.size > PARSED_KEPT) PARSED.delete(PARSED.keys().next().value as string);
	return parsed;
}

function parseConnectionText(name: string, text: string): ParsedConnection {
	const read = frontmatter(text, CONNECTION_FIELDS);
	if (read === undefined) {
		const named = AGENT_NAME.test(name) ? [] : [nameError(name)];
		return { errors: [...named, "a connection file starts with its frontmatter between two --- lines"] };
	}
	const errors = [...read.errors];
	const floors: { [floor in Floor]?: readonly string[] } = {};
	for (const floor of FLOORS) floors[floor] = read.list(floor);
	const fields: ConnectionFields = {
		service: read.one("service"),
		url: read.one("url"),
		command: read.one("command"),
		api: read.one("api"),
		auth: read.one("auth"),
		ask: read.one("ask"),
		client: read.one("client"),
		...(read.values.has("scopes") ? { scopes: read.list("scopes") } : {}),
		account: read.one("account"),
		reads: read.list("reads"),
		floors,
	};
	let why = read.body;
	let needs: { [tool: string]: string[] } | undefined;
	let objects: unknown;
	const late: string[] = [];
	const block = /```json\s*\n([\s\S]*?)\n```/.exec(read.body);
	if (block !== null) {
		why = (read.body.slice(0, block.index) + read.body.slice(block.index + block[0].length)).trim();
		const problem = `the json block is {"needs": {"tool": ["scope", …]}, "objects": {…}}: the scopes each tool needs, any one will do, and the things it names`;
		let parsed: unknown;
		try {
			parsed = JSON.parse(block[1] ?? "") as unknown;
		} catch {
			late.push(problem);
		}
		if (parsed !== undefined) {
			const given = (parsed as { needs?: unknown } | null)?.needs;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Object.keys(parsed).some((key) => key !== "needs" && key !== "objects") ||
				(given !== undefined &&
					(typeof given !== "object" ||
						given === null ||
						Array.isArray(given) ||
						!Object.entries(given).every(
							([tool, list]) =>
								/^[A-Za-z0-9_.-]{1,64}$/.test(tool) &&
								Array.isArray(list) &&
								list.length > 0 &&
								list.every((scope) => typeof scope === "string" && /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(scope)),
						)))
			)
				late.push(problem);
			else if (given !== undefined) needs = given as { [tool: string]: string[] };
			objects = (parsed as { objects?: unknown } | null)?.objects;
		}
	}
	if (why.length > 2000) late.push("say why in a few lines");
	return connectionOf(
		name,
		{ ...fields, ...(needs === undefined ? {} : { needs }), ...(objects === undefined ? {} : { objects }), why },
		errors,
		late,
	);
}

const nameError = (name: string) =>
	`"${name}" is not a connection name: use lowercase letters, digits and dashes, such as "calendar"`;

/**
 * What a connection says, before the checks across its fields: read from a file's frontmatter, or from a definition
 * banda ships (`definitions.ts`), whose schema has checked each field's shape already.
 */
export type ConnectionFields = {
	readonly service: string | undefined;
	readonly url?: string | undefined;
	readonly command?: string | undefined;
	readonly api?: string | undefined;
	readonly auth?: string | undefined;
	readonly ask?: string | undefined;
	readonly client?: string | undefined;
	readonly scopes?: readonly string[];
	/** The read and the field of its answer that name the account: `get_me.login`. */
	readonly account?: string | undefined;
	readonly reads: readonly string[];
	readonly floors: { readonly [floor in Floor]?: readonly string[] };
	readonly needs?: { readonly [tool: string]: readonly string[] };
	readonly objects?: unknown;
	readonly why?: string;
	readonly about?: string;
	readonly access?: Access;
};

/**
 * The connection `fields` say, or every problem with them, each saying what to write instead: the checks a schema
 * cannot say (an address or a command but not both, a built-in's client and scopes within its registry's ceiling, a
 * read that is not also on a floor, the kinds' templates and paths, an access choice within what an account may ask
 * for). `before` are problems found first, `after` ones said last.
 */
export function connectionOf(
	name: string,
	fields: ConnectionFields,
	before: readonly string[] = [],
	after: readonly string[] = [],
): ParsedConnection {
	const errors: string[] = [];
	if (!AGENT_NAME.test(name)) errors.push(nameError(name));
	errors.push(...before);
	const service = fields.service ?? "";
	if (service === "") errors.push(`add "service:", the service as the owner calls it, such as "your calendar"`);
	const { url, command, client, scopes } = fields;
	const apiName = fields.api;
	const api = apiName === undefined ? undefined : restApiNamed(apiName);
	const builtIn = api === undefined ? undefined : REST_APIS[api];
	if ((url === undefined) === (command === undefined))
		errors.push(`give "url:" for a server elsewhere, or "command:" for one you run in your computer, not both`);
	if (url !== undefined && !remoteUrl(url)) errors.push(`"url: ${url}" is not an https address`);
	if (apiName !== undefined && (command !== undefined || builtIn === undefined || url !== builtIn.url))
		errors.push(
			`a built-in API is one of ${Object.entries(REST_APIS)
				.map(([name, { url }]) => `"${name}" at ${url}`)
				.join(", ")}`,
		);
	const auth = fields.auth ?? "none";
	if (auth !== "none" && auth !== "key" && auth !== "oauth")
		errors.push(`"auth: ${auth}": use none, key (the owner types one in) or oauth (the owner signs in)`);
	if (command !== undefined && auth !== "none")
		errors.push(`a server in your computer gets no credentials: drop "auth"`);
	const ask = fields.ask;
	if (ask !== undefined && (ask !== "always" || command !== undefined))
		errors.push('"ask: always" is for a remote connection whose non-read tools must ask every time');
	if (
		builtIn !== undefined &&
		(auth !== "oauth" ||
			client !== "google" ||
			scopes === undefined ||
			!builtIn.required.every((scope) => scopes.includes(scope)) ||
			!scopes.every((scope) => (builtIn.scopes as readonly string[]).includes(scope)) ||
			new Set(scopes).size !== scopes.length)
	)
		errors.push(
			`${builtIn.service} uses OAuth client "google", asks for ${builtIn.required.join(" and ")}, and may add ${builtIn.scopes
				.filter((scope) => !(builtIn.required as readonly string[]).includes(scope))
				.join(" or ")}`,
		);
	if (auth !== "oauth" && (client !== undefined || scopes !== undefined))
		errors.push(`"client" and "scopes" are for a server the owner signs in to: add "auth: oauth" or drop them`);
	if (client !== undefined && client !== "google" && !/^[\w.-]{1,200}$/.test(client))
		errors.push(`"client: ${client}" is not a client id: letters, digits, dots, dashes and underscores`);
	for (const scope of scopes ?? [])
		if (!/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(scope)) errors.push(`"${scope}" is not a scope`);
	const accountRead = fields.account;
	const accountParts =
		accountRead === undefined ? undefined : /^([A-Za-z0-9_.-]{1,64})\.([A-Za-z0-9_]{1,64})$/.exec(accountRead);
	if (accountRead !== undefined && (accountParts === null || accountParts === undefined))
		errors.push(
			`"account: ${accountRead}" is a read tool and the field naming you in its answer, such as get_me.login`,
		);
	if (accountRead !== undefined && (auth === "none" || command !== undefined))
		errors.push(`"account" is for a server the owner signs in to: drop it`);
	const reads: string[] = [];
	const readsWhen: { [tool: string]: ReadRule[] } = {};
	for (const item of fields.reads) {
		const rule = RULE.exec(item);
		if (rule === null) {
			if (/[()=]/.test(item))
				errors.push(
					`"${item}" is not a read: write a tool's name, or tool(arg=value) with the exact value it reads for`,
				);
			else reads.push(item);
			continue;
		}
		const [, tool = "", arg = "", value = ""] = rule;
		if (value.endsWith("*")) {
			errors.push(`"${item}": a rule names the exact value it reads for, not a prefix`);
			continue;
		}
		readsWhen[tool] = [...(readsWhen[tool] ?? []), { arg, value }];
	}
	for (const tool of Object.keys(readsWhen))
		if (reads.includes(tool)) errors.push(`"${tool}" is a read already: drop its rules, or its name`);
	const floors: { [tool: string]: Floor } = {};
	for (const floor of FLOORS)
		for (const tool of fields.floors[floor] ?? []) {
			if (floors[tool] !== undefined) errors.push(`"${tool}" is under two floors`);
			floors[tool] = floor;
			if (reads.includes(tool)) errors.push(`"${tool}" is a read and on the floor: a read sends nothing, so drop one`);
			if (readsWhen[tool] !== undefined)
				errors.push(`"${tool}" reads for some arguments and is on the floor: it asks every time, so drop its rules`);
		}
	const needs = fields.needs;
	let objects: ObjectKinds | undefined;
	if (fields.objects !== undefined) {
		const isRead = (tool: string, args: { readonly [arg: string]: unknown }) =>
			command === undefined && (reads.includes(tool) || readsFor(readsWhen[tool], args));
		const found = parseObjects(fields.objects, isRead);
		if ("errors" in found) errors.push(...found.errors);
		else objects = found.objects;
		if (url === undefined) errors.push(`"objects" are for a server elsewhere, read with its "url"`);
	}
	if (needs !== undefined && auth !== "oauth") errors.push(`"needs" is for a server the owner signs in to`);
	if (needs !== undefined && builtIn !== undefined) {
		const allowed: readonly string[] = builtIn.scopes;
		const beyond = [...new Set(Object.values(needs).flat())].filter((scope) => !allowed.includes(scope));
		if (beyond.length > 0)
			errors.push(`${builtIn.service}'s tools may need only ${allowed.join(", ")}: drop ${beyond.join(", ")}`);
	}
	const access = fields.access;
	if (access !== undefined) {
		const ceiling = ceilingOf({
			...(scopes === undefined ? {} : { scopes }),
			...(needs === undefined ? {} : { needs }),
		});
		for (const choice of access.choices)
			for (const scope of choice.scopes)
				if (ceiling === undefined || !ceiling.includes(scope))
					errors.push(`the access choice "${choice.label}" asks for ${scope}, which no account of it may ask for`);
		if (access.required !== undefined && builtIn === undefined)
			errors.push("a required access is the scopes every account asks for, which only a built-in API has");
	}
	errors.push(...after);
	if (errors.length > 0) return { errors };
	return {
		connection: {
			name,
			service,
			...(url === undefined ? {} : { url }),
			...(command === undefined ? {} : { command }),
			...(api === undefined ? {} : { api }),
			auth: auth as AuthKind,
			...(ask === "always" ? { ask: "always" as const } : {}),
			...(client === undefined ? {} : { client }),
			...(scopes === undefined ? {} : { scopes }),
			...(needs === undefined ? {} : { needs }),
			...(objects === undefined ? {} : { objects }),
			...(Object.keys(readsWhen).length === 0 ? {} : { readsWhen }),
			reads,
			floors,
			...(accountParts === null || accountParts === undefined
				? {}
				: { account: { tool: accountParts[1] ?? "", field: accountParts[2] ?? "" } }),
			...(fields.why === undefined ? {} : { why: fields.why }),
			...(fields.about === undefined ? {} : { about: fields.about }),
			...(access === undefined ? {} : { access }),
		},
	};
}

/**
 * `text` (a connection file) for a server that needs no sign-in: its `auth`, `client` and `scopes` dropped, every
 * other byte as it was; undefined when it would not read back as needing none.
 */
export function withoutSignIn(name: string, text: string): string | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (match === null) return undefined;
	const out: string[] = [];
	let skipping = false;
	for (const line of (match[1] ?? "").split("\n")) {
		if (/^(auth|client|scopes)\s*:/.test(line)) {
			skipping = true;
			continue;
		}
		if (skipping && /^\s*-\s/.test(line)) continue;
		skipping = false;
		out.push(line);
	}
	const rewritten = `---\n${out.join("\n")}\n---${text.slice(match[0].length)}`;
	const parsed = parseConnection(name, rewritten);
	return "connection" in parsed && parsed.connection.auth === "none" ? rewritten : undefined;
}

/** A connection's `reads` as written: its tools' names, then its rules. */
export const readItems = (connection: Connection): string[] => [
	...connection.reads,
	...Object.entries(connection.readsWhen ?? {}).flatMap(([tool, rules]) =>
		rules.map((rule) => `${tool}(${rule.arg}=${rule.value})`),
	),
];

/**
 * `text` (a connection file) with `tools` among its reads too, every other byte as it was; undefined when it would not
 * read back as exactly those reads.
 */
export function withReads(name: string, text: string, tools: readonly string[]): string | undefined {
	const parsed = parseConnection(name, text);
	if ("errors" in parsed) return undefined;
	const items = [...new Set([...readItems(parsed.connection), ...tools])];
	const rewritten = withList(text, "reads", items, ["scopes", "client", "auth", "url", "command"]);
	if (rewritten === undefined) return undefined;
	const again = parseConnection(name, rewritten);
	if ("errors" in again) return undefined;
	const read = readItems(again.connection);
	return read.length === items.length && read.every((item, i) => item === items[i]) ? rewritten : undefined;
}

/**
 * `text`'s frontmatter with `key` set to the list `values`: its line replaced (whatever form it was in), or added
 * after the first of `after` there is, else at the end. Undefined when there is no frontmatter.
 */
export function withList(
	text: string,
	key: string,
	values: readonly string[],
	after: readonly string[],
): string | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (match === null) return undefined;
	const lines = (match[1] ?? "").split("\n");
	const out: string[] = [];
	let skipping = false;
	const own = new RegExp(`^${key}\\s*:`);
	for (const line of lines) {
		if (own.test(line)) {
			skipping = true;
			continue;
		}
		if (skipping && /^\s*-\s/.test(line)) continue;
		skipping = false;
		out.push(line);
	}
	let at = -1;
	for (const field of after) {
		at = out.findIndex((line) => new RegExp(`^${field}\\s*:`).test(line));
		if (at !== -1) break;
	}
	out.splice(at === -1 ? out.length : at + 1, 0, `${key}: [${values.join(", ")}]`);
	return `---\n${out.join("\n")}\n---${text.slice(match[0].length)}`;
}

/** Parse a tool file: frontmatter, then the JSON schema of its arguments in a ```json block (none: it takes none). */
export function parseTool(
	name: string,
	text: string,
	taken: readonly string[] = [],
): { readonly tool: OwnTool } | { readonly errors: readonly string[] } {
	const errors: string[] = [];
	if (!AGENT_NAME.test(name))
		errors.push(`"${name}" is not a tool name: use lowercase letters, digits and dashes, such as "weather-now"`);
	if (taken.includes(name)) errors.push(`"${name}" is already a tool: pick another name`);
	const read = frontmatter(text, TOOL_FIELDS);
	if (read === undefined)
		return { errors: [...errors, "a tool file starts with its frontmatter between two --- lines"] };
	errors.push(...read.errors);
	const description = read.one("description") ?? "";
	if (description === "") errors.push(`add "description:", which is how the model knows when to call it`);
	const command = read.one("command") ?? "";
	if (command === "")
		errors.push(`add "command:", what runs in your computer; it gets the arguments as JSON in $BANDA_INPUT`);
	let parameters: { [key: string]: unknown } = { type: "object", properties: {} };
	const block = /```json\s*\n([\s\S]*?)\n```/.exec(read.body);
	if (block !== null)
		try {
			const parsed = JSON.parse(block[1] ?? "") as unknown;
			if (typeof parsed !== "object" || parsed === null || (parsed as { type?: unknown }).type !== "object")
				errors.push(`the schema is a JSON object with "type": "object"`);
			else parameters = parsed as { [key: string]: unknown };
		} catch (error) {
			errors.push(`the schema is not JSON: ${(error as Error).message}`);
		}
	if (errors.length > 0) return { errors };
	return { tool: { name, description, command, parameters } };
}

/** A tool as a server listed it when it was connected: what the model is offered, fixed until it is listed again. */
export type Listed = {
	description: string;
	schema: JsonObject;
	/** The server's own word that it only reads, shown, never trusted. */
	readOnlyHint?: boolean;
};

/** An account: one sign-in to a connection, as the store knows it. */
export type Account = {
	/** What the service calls the owner, as read once after sign-in ("bandarra"); numbered when it says nothing. */
	id: string;
	/** The name of an account its server did not name: from its host until the owner chooses another. */
	label?: string;
	/** Each completed sign-in is a distinct generation, even when the same ID returns at the same time. */
	generation?: string;
	/** When it was signed in, and last signed in again. */
	at: number;
};

/**
 * What the connections hold: for each, the tools its server listed and for which accepted file (its hash), and when;
 * the tools the owner switched off, by the name the model knows them by; the accounts signed in, by connection and by
 * key (the folder their credentials are in); and which accounts each agent may use, by agent and connection.
 */
type ConnectedValue = {
	/** Monotonic revocation generation: an in-flight read cannot survive revoke/regrant (ABA). */
	epoch: number;
	connections: {
		[name: string]: {
			sha: string;
			tools: { [tool: string]: Listed };
			/** The server's own notes about its tools, as it gave them when first listed for this file. */
			notes?: string;
			/** The tool whose description carries them, chosen then: they never move to another. */
			notesOn?: string;
			at: number;
		};
	};
	off: { [tool: string]: true };
	accounts: { [connection: string]: { [account: string]: Account } };
	on: { [agent: string]: { [connection: string]: string[] } };
	/** Owner-managed anonymous connections have explicit agent switches, not invented accounts. */
	public: { [connection: string]: string[] };
};

/** What is connected and who may use it. */
export const Connected = defineDoc<ConnectedValue>({
	kind: "banda.connections",
	// 2: owner-managed anonymous connections keep their agent switches in `public`; a version 1 doc had none
	version: 2,
	scope: "session",
	initial: () => ({ epoch: 0, connections: {}, off: {}, accounts: {}, on: {}, public: {} }),
	migrate: (value, from) => (from >= 2 ? value : { ...value, public: {} }) as unknown as ConnectedValue,
	checkpointWhen: () => true,
});

/** An account's key, the folder its credentials are in: its id, lowercase, or a hash of it when it is not a name. */
export function accountKey(id: string): string {
	const lower = id.normalize("NFC").toLowerCase().trim().replace(/\s+/g, "-");
	return /^[a-z0-9][a-z0-9._@+-]{0,99}$/.test(lower) && !lower.includes("..")
		? lower
		: `a-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

/** The id of a sign-in whose server did not say whom it is for: a handle for banda's keys, never a name. */
export const numberedAccount = (n: number) => `account ${n}`;

/** Whether a name reads as such a number, which says nothing about the account. */
export const readsNumbered = (name: string) => /^account \d+$/i.test(name);

type Named = Pick<Account, "id" | "label">;

/** An account as the owner and the model read it: its name when it has one, "@bandarra", or an address as it is. */
export const accountLabel = (account: Named) =>
	account.label ?? (/[@\s]/.test(account.id) ? account.id : `@${account.id}`);

/** A name as names are compared: "@Work", "work" and " WORK " are one name. */
export const nameForm = (name: string) => plainLine(name).replace(/^@/, "").toLowerCase();

/**
 * Which of `keys` goes by `asked`: what the model or the owner reads it as, or the id a watch's file keeps because a
 * rename does not change it. Never its key: that is banda's own, and an owner's name may spell one.
 */
export function accountNamed(
	known: { readonly [key: string]: Named },
	keys: readonly string[],
	asked: string,
): string | undefined {
	const wanted = nameForm(asked);
	return keys.find((key) => {
		const account = known[key];
		return account !== undefined && (nameForm(accountLabel(account)) === wanted || nameForm(account.id) === wanted);
	});
}

/**
 * The name a new account of the server at `url` goes by when its server does not say whose it is: the server's host,
 * then "host 2", "host 3", the first that none of `accounts` is called, so accounts can always be told apart.
 */
export function defaultAccountLabel(url: string, accounts: readonly Named[]): string {
	const host = new URL(url).hostname;
	const taken = new Set(accounts.map((account) => nameForm(accountLabel(account))));
	let label = host;
	for (let n = 2; taken.has(nameForm(label)); n++) label = `${host} ${n}`;
	return label;
}

/** Whether connection `connection` is signed in to: its tools act as one of its accounts. */
export const signsIn = (connection: Pick<Connection, "url" | "auth">) =>
	connection.url !== undefined && connection.auth !== "none";

/** Whether agent `agent`'s file lets it use connection `name`: it names it, or it is the lead, which may use any. */
export const mayUse = (agent: Pick<Agent, "id" | "connections">, name: string) =>
	agent.id === LEAD || (agent.connections ?? []).includes(name);

/** An optional owner-managed restriction on anonymous access, in addition to the agent's file. */
export async function publicOn(tx: Tx, agent: string, name: string): Promise<boolean> {
	const entries = (await tx.doc(Connected)).public;
	const allowed = Object.hasOwn(entries, name) ? entries[name] : undefined;
	return allowed === undefined || allowed.includes(agent);
}

/** The accounts of connection `name` agent `agent` may use now: switched on, and still signed in. Reads only. */
export async function accountsOn(tx: Tx, agent: string, name: string): Promise<string[]> {
	const doc = await tx.doc(Connected);
	const known = doc.accounts?.[name] ?? {};
	return [...new Set(doc.on?.[agent]?.[name] ?? [])].filter((key) => known[key] !== undefined).sort();
}

/**
 * The connections whose tools need an `account` argument to tell their accounts apart, with what a model calls them: a
 * connection some active agent has more than one account of. One tool set per connection serves every agent, so the
 * argument is offered to each once one of them needs it; an agent with one account may leave it out. Reads only.
 */
export async function multiAccount(tx: Tx): Promise<{ [connection: string]: string[] }> {
	const doc = await tx.doc(Connected);
	const found: { [connection: string]: string[] } = {};
	for (const [agent, connections] of Object.entries(doc.on ?? {})) {
		if (!(await activeAgent(tx, agent))) continue;
		for (const name of Object.keys(connections))
			if ((await accountsOn(tx, agent, name)).length > 1)
				found[name] = Object.values(doc.accounts?.[name] ?? {})
					.map(accountLabel)
					.sort();
	}
	return found;
}

/** Whether agent `id`'s accepted file says it is active. Reads only. */
async function activeAgent(tx: Tx, id: string): Promise<boolean> {
	const file = (await tx.doc(Accepted)).files[agentPath(id)];
	if (file === undefined) return false;
	const parsed = parseAgent(id, file.text);
	return "agent" in parsed && parsed.agent.state === "active";
}

/** The name the model knows a connection's tool by: stable, `<connection>__<tool>`, within a model's 64 characters. */
export function toolName(connection: string, tool: string): string {
	return `${connection}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
}

/** The accepted connection `name`, if its file parses. Reads only. */
export async function acceptedConnection(tx: Tx, name: string): Promise<(Connection & { sha: string }) | undefined> {
	const file = (await tx.doc(Accepted)).files[connectionPath(name)];
	if (file === undefined) return undefined;
	const parsed = parseConnection(name, file.text);
	return "connection" in parsed ? { ...parsed.connection, sha: file.sha } : undefined;
}

/** The accepted tool `name`, if its file parses. Reads only. */
export async function acceptedTool(tx: Tx, name: string): Promise<(OwnTool & { sha: string }) | undefined> {
	const file = (await tx.doc(Accepted)).files[toolPath(name)];
	if (file === undefined) return undefined;
	const parsed = parseTool(name, file.text);
	return "tool" in parsed ? { ...parsed.tool, sha: file.sha } : undefined;
}

/** A connection's tool in effect: whose, its server's name for it, and whether it is a read or on the floor. */
export type InEffect = {
	readonly name: string;
	readonly connection: Connection & { sha: string };
	readonly tool: string;
	readonly listed: Listed;
	readonly read: boolean;
	/** For a tool that only reads for some arguments: its rules (a call matching one runs as a read). */
	readonly readsWhen?: readonly ReadRule[];
	readonly floor?: Floor;
	/** The server's notes, carried by the one tool chosen when it was listed, so they reach the model once. */
	readonly notes?: string;
};

/**
 * Every connection tool in effect now: its connection's file accepted, listed for that very file, and not switched
 * off. Reads only.
 */
export async function connectionTools(tx: Tx): Promise<InEffect[]> {
	const { files } = await tx.doc(Accepted);
	const { connections, off } = await tx.doc(Connected);
	const found: InEffect[] = [];
	for (const path of Object.keys(files).sort()) {
		const name = /^connections\/(.+)\.md$/.exec(path)?.[1];
		if (name === undefined) continue;
		const connection = await acceptedConnection(tx, name);
		const listed = connections[name];
		if (connection === undefined || listed === undefined || listed.sha !== connection.sha) continue;
		for (const [tool, shape] of Object.entries(listed.tools).sort(([a], [b]) => a.localeCompare(b))) {
			const model = toolName(name, tool);
			if (off[model] === true || found.some((other) => other.name === model)) continue;
			const floor = Object.hasOwn(connection.floors, tool)
				? connection.floors[tool]
				: connection.ask === "always" && !connection.reads.includes(tool)
					? "private"
					: undefined;
			const carried = tool === listed.notesOn ? listed.notes : undefined;
			found.push({
				name: model,
				connection,
				tool,
				listed: JSON.parse(JSON.stringify(shape)) as Listed,
				// a server in the box runs there like any command: nothing it does leaves but through the proxy
				read: connection.command !== undefined || connection.reads.includes(tool),
				...(connection.command === undefined && connection.readsWhen?.[tool] !== undefined
					? { readsWhen: connection.readsWhen[tool] }
					: {}),
				...(floor === undefined ? {} : { floor }),
				...(carried === undefined ? {} : { notes: carried }),
			});
		}
	}
	return found;
}

/** Every tool the agent built that is in effect: accepted and not switched off. Reads only. */
export async function ownTools(tx: Tx): Promise<OwnTool[]> {
	const { files } = await tx.doc(Accepted);
	const { off } = await tx.doc(Connected);
	const found: OwnTool[] = [];
	for (const path of Object.keys(files).sort()) {
		const name = /^tools\/(.+)\.md$/.exec(path)?.[1];
		if (name === undefined || off[name] === true) continue;
		const tool = await acceptedTool(tx, name);
		if (tool !== undefined) found.push(tool);
	}
	return found;
}

/** Whether the tool the model knows as `name` is in effect now, checked in the commit that starts a call. */
export async function inEffect(tx: Tx, name: string): Promise<boolean> {
	if (name.includes("__")) return (await connectionTools(tx)).some((tool) => tool.name === name);
	return (await ownTools(tx)).some((tool) => tool.name === name);
}

/**
 * The tools an agent's file gives it beyond its own named ones: those of the connections it names (the lead: every
 * connection's), in effect now, and, for a connection signed in to, only while the owner switched at least one of its
 * accounts on for it. Reads only.
 */
export async function connectionToolsOf(tx: Tx, agent: Pick<Agent, "id" | "connections">): Promise<string[]> {
	const tools = await connectionTools(tx);
	const found: string[] = [];
	const has = new Map<string, boolean>();
	for (const tool of tools) {
		const name = tool.connection.name;
		if (!mayUse(agent, name)) continue;
		if (!signsIn(tool.connection) && !(await publicOn(tx, agent.id, name))) continue;
		if (signsIn(tool.connection)) {
			if (!has.has(name)) has.set(name, (await accountsOn(tx, agent.id, name)).length > 0);
			if (has.get(name) !== true) continue;
		}
		found.push(tool.name);
	}
	return [...found, ...(await harnessToolsOf(tx, agent.id))];
}

// Credentials, in `auth/connections/<connection>/<account>/`: the daemon's alone, owner-only files, written whole (a
// temp file, renamed).

/** An account's credentials, bound to the URL they were given for. */
export type Credentials = (
	| { readonly url: string; readonly key: string }
	| {
			readonly url: string;
			readonly oauth: { readonly server: OAuthServer; readonly client: OAuthClient; readonly tokens: Tokens };
	  }
) & { readonly revision?: string };

const credentialsDir = (home: string) => join(home, "auth", "connections");
const accountDir = (home: string, name: string, account: string) => join(credentialsDir(home), name, account);
const pendingDir = (home: string) => join(home, "auth", "oauth");

async function writePrivate(path: string, value: unknown): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomBytes(6).toString("hex")}`;
	await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
	await rename(temp, path);
}

async function readPrivate<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/**
 * What an account of `connection` may ask for: the scopes its file asks for by default and every scope its tools
 * `needs`. Undefined for a file that names no scopes: its sign-in asks for what the server offers, and takes no choice.
 */
export function ceilingOf(connection: Pick<Connection, "scopes" | "needs">): readonly string[] | undefined {
	if (connection.scopes === undefined) return undefined;
	return [...new Set([...connection.scopes, ...Object.values(connection.needs ?? {}).flat()])];
}

/** The scopes every account of `connection` asks for: a built-in API's required ones; none otherwise. */
export const requiredOf = (connection: Pick<Connection, "api">): readonly string[] =>
	connection.api === undefined ? [] : REST_APIS[connection.api].required;

/**
 * Whether `credentials` were given for `connection` as its accepted file says it now: the same URL, and for a sign-in,
 * the client it names, the scope every account asks for, and nothing beyond what the file lets an account ask for.
 * Each account asks for its own scopes: changing the file's default leaves them be, while narrowing what may be asked
 * or changing the client needs a new sign-in; the old token is never stretched to cover it.
 */
export function fits(credentials: Credentials | undefined, connection: Connection): credentials is Credentials {
	if (credentials === undefined || credentials.url !== connection.url) return false;
	if (!("oauth" in credentials)) return connection.auth === "key";
	if (connection.auth !== "oauth") return false;
	if (connection.client === "google") {
		if (credentials.oauth.client.id !== (process.env.BANDA_GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID)) return false;
	} else if (connection.client !== undefined && credentials.oauth.client.id !== connection.client) return false;
	// what was asked, not what was granted: a scope the owner left out at the consent screen is theirs to add again
	const asked = credentials.oauth.server.scopes ?? [];
	const ceiling = ceilingOf(connection);
	// a sign-in that asked for nothing was given the server's default, which a file naming scopes does not allow
	if (ceiling !== undefined && (asked.length === 0 || !asked.every((scope) => ceiling.includes(scope)))) return false;
	return requiredOf(connection).every((scope) => asked.includes(scope));
}

/** The scopes a sign-in was given: as the server said when it granted them, else as they were asked for. */
export const grantedScopes = (credentials: Credentials): readonly string[] =>
	"oauth" in credentials ? (credentials.oauth.tokens.scopes ?? credentials.oauth.server.scopes ?? []) : [];

/**
 * Whether `credentials` may call `tool` of `connection`, as far as the daemon can tell: the tool needs no scope, the
 * sign-in records none, or it was given one of those the tool needs. The service's token stays what enforces it.
 */
export function givenFor(credentials: Credentials, connection: Pick<Connection, "needs">, tool: string): boolean {
	const anyOf = connection.needs?.[tool];
	if (anyOf === undefined || !("oauth" in credentials)) return true;
	const { tokens, server } = credentials.oauth;
	if (tokens.scopes === undefined && server.scopes === undefined) return true;
	const given = grantedScopes(credentials);
	return anyOf.some((scope) => given.includes(scope));
}

/** Account `account` of connection `name`: its credentials, if any. */
export const credentialsOf = (home: string, name: string, account: string) =>
	readPrivate<Credentials>(join(accountDir(home, name, account), "credentials.json"));

// One FIFO per connection, shared by every capabilities instance and every credential writer/remover.
// As with BlobStore.exclusive, hold it across both filesystem effects and their store admission.
const credentialLocks = new Map<string, Promise<unknown>>();
export function withCredentials<T>(
	home: string,
	name: string,
	step: (locked: {
		readonly read: (account: string) => Promise<Credentials | undefined>;
		readonly keep: (account: string, credentials: Credentials) => Promise<Credentials>;
		readonly forget: (account?: string) => Promise<void>;
	}) => Promise<T>,
): Promise<T> {
	const key = JSON.stringify([resolve(home), name]);
	const run = (credentialLocks.get(key) ?? Promise.resolve()).then(() =>
		step({
			read: (account) => credentialsOf(home, name, account),
			keep: async (account, credentials) => {
				const kept = { ...credentials, revision: randomBytes(24).toString("hex") };
				await writePrivate(join(accountDir(home, name, account), "credentials.json"), kept);
				return kept;
			},
			forget: (account) =>
				rm(account === undefined ? join(credentialsDir(home), name) : accountDir(home, name, account), {
					recursive: true,
					force: true,
				}),
		}),
	);
	const settled = run.catch(() => undefined);
	credentialLocks.set(key, settled);
	void settled.then(() => {
		if (credentialLocks.get(key) === settled) credentialLocks.delete(key);
	});
	return run;
}

export const keepCredentials = (home: string, name: string, account: string, credentials: Credentials) =>
	withCredentials(home, name, (locked) => locked.keep(account, credentials));

/** Forget account `account`'s credentials; with none named, every account's of connection `name`. */
export const forgetCredentials = (home: string, name: string, account?: string) =>
	withCredentials(home, name, (locked) => locked.forget(account));

/** The accounts there are credentials for, by connection. */
export async function credentialed(home: string): Promise<{ readonly [name: string]: readonly string[] }> {
	const found: { [name: string]: string[] } = {};
	for (const name of await readdir(credentialsDir(home)).catch(() => [] as string[])) {
		const accounts = await readdir(join(credentialsDir(home), name)).catch(() => [] as string[]);
		found[name] = accounts.filter((account) => !account.startsWith("."));
	}
	return found;
}

/** Every secret the daemon keeps for connections: what must never appear anywhere else. */
export async function secrets(home: string): Promise<string[]> {
	const found: string[] = [];
	for (const [name, accounts] of Object.entries(await credentialed(home)))
		for (const account of accounts) {
			const credentials = await credentialsOf(home, name, account);
			if (credentials === undefined) continue;
			if ("key" in credentials) found.push(credentials.key);
			else {
				found.push(credentials.oauth.tokens.access);
				if (credentials.oauth.tokens.refresh !== undefined) found.push(credentials.oauth.tokens.refresh);
				if (credentials.oauth.client.secret !== undefined) found.push(credentials.oauth.client.secret);
			}
		}
	return found.filter((secret) => secret.length >= 8);
}

/** A sign-in in progress, by its state: written before the owner's browser leaves, taken (once) at the callback. */
export const keepPending = (home: string, pending: Pending) =>
	writePrivate(join(pendingDir(home), `${pending.state}.json`), pending);

/** Take the sign-in `state` names: it is gone after, so a callback that comes twice finishes it once. */
export async function takePending(home: string, state: string): Promise<Pending | undefined> {
	if (!/^[\w-]{20,100}$/.test(state)) return undefined;
	const path = join(pendingDir(home), `${state}.json`);
	const pending = await readPrivate<Pending>(path);
	if (pending === undefined) return undefined;
	await rm(path, { force: true });
	return pending;
}

/** Forget sign-ins older than an hour, which no browser comes back from. */
export async function prunePending(home: string, now: number): Promise<void> {
	for (const file of await readdir(pendingDir(home)).catch(() => [] as string[])) {
		const pending = await readPrivate<Pending>(join(pendingDir(home), file));
		if (pending === undefined || now - pending.at > 60 * 60_000)
			await rm(join(pendingDir(home), file), { force: true });
	}
}

/** `text` with every secret in it replaced, so what a server echoes of a credential reaches nobody. */
export function scrub(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) if (secret !== "") out = out.split(secret).join("[a credential, hidden]");
	return out;
}
