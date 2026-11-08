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
import { type ObjectKinds, parseObjects } from "./objects.ts";
import { REST_APIS, type RestApiName, restApiNamed } from "./rest.ts";
import { type Classed, classOf, defaultOf, type Guess, nameGroups, type Setting } from "./tool-kinds.ts";

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
	/**
	 * Its tools by group, as the file says (in the ```json block, `{"groups": {"Issues": [tool, …]}}`): what the owner
	 * scans them in. A tool it leaves out is grouped as banda guessed, or by its name.
	 */
	readonly groups?: { readonly [group: string]: readonly string[] };
	/** Why the agent wants it, in its words. */
	readonly why: string;
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
	const errors: string[] = [];
	if (!AGENT_NAME.test(name))
		errors.push(`"${name}" is not a connection name: use lowercase letters, digits and dashes, such as "calendar"`);
	const read = frontmatter(text, CONNECTION_FIELDS);
	if (read === undefined)
		return { errors: [...errors, "a connection file starts with its frontmatter between two --- lines"] };
	errors.push(...read.errors);
	const service = read.one("service") ?? "";
	if (service === "") errors.push(`add "service:", the service as the owner calls it, such as "your calendar"`);
	const url = read.one("url");
	const command = read.one("command");
	const apiName = read.one("api");
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
	const auth = read.one("auth") ?? "none";
	if (auth !== "none" && auth !== "key" && auth !== "oauth")
		errors.push(`"auth: ${auth}": use none, key (the owner types one in) or oauth (the owner signs in)`);
	if (command !== undefined && auth !== "none")
		errors.push(`a server in your computer gets no credentials: drop "auth"`);
	const ask = read.one("ask");
	if (ask !== undefined && (ask !== "always" || command !== undefined))
		errors.push('"ask: always" is for a remote connection whose non-read tools must ask every time');
	const client = read.one("client");
	const scopes = read.values.has("scopes") ? read.list("scopes") : undefined;
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
	const accountRead = read.one("account");
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
	for (const item of read.list("reads")) {
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
		for (const tool of read.list(floor)) {
			if (floors[tool] !== undefined) errors.push(`"${tool}" is under two floors`);
			floors[tool] = floor;
			if (reads.includes(tool)) errors.push(`"${tool}" is a read and on the floor: a read sends nothing, so drop one`);
			if (readsWhen[tool] !== undefined)
				errors.push(`"${tool}" reads for some arguments and is on the floor: it asks every time, so drop its rules`);
		}
	let why = read.body;
	let needs: { [tool: string]: string[] } | undefined;
	let objects: ObjectKinds | undefined;
	let groups: { [group: string]: string[] } | undefined;
	const block = /```json\s*\n([\s\S]*?)\n```/.exec(read.body);
	if (block !== null) {
		why = (read.body.slice(0, block.index) + read.body.slice(block.index + block[0].length)).trim();
		const problem = `the json block is {"needs": {"tool": ["scope", …]}, "objects": {…}, "groups": {"group": ["tool", …]}}: the scopes each tool needs, any one will do, the things it names, and its tools by group`;
		let parsed: unknown;
		try {
			parsed = JSON.parse(block[1] ?? "") as unknown;
		} catch {
			errors.push(problem);
		}
		if (parsed !== undefined) {
			const given = (parsed as { needs?: unknown } | null)?.needs;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Object.keys(parsed).some((key) => key !== "needs" && key !== "objects" && key !== "groups") ||
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
				errors.push(problem);
			else if (given !== undefined) needs = given as { [tool: string]: string[] };
			const grouped = (parsed as { groups?: unknown } | null)?.groups;
			if (grouped !== undefined) {
				const found = parseGroups(grouped);
				if (typeof found === "string") errors.push(found);
				else groups = found;
			}
			const declared = (parsed as { objects?: unknown } | null)?.objects;
			if (declared !== undefined) {
				const isRead = (tool: string, args: { readonly [arg: string]: unknown }) =>
					command === undefined && (reads.includes(tool) || readsFor(readsWhen[tool], args));
				const found = parseObjects(declared, isRead);
				if ("errors" in found) errors.push(...found.errors);
				else objects = found.objects;
				if (url === undefined) errors.push(`"objects" are for a server elsewhere, read with its "url"`);
			}
		}
		if (needs !== undefined && auth !== "oauth") errors.push(`"needs" is for a server the owner signs in to`);
		if (needs !== undefined && builtIn !== undefined) {
			const allowed: readonly string[] = builtIn.scopes;
			const beyond = [...new Set(Object.values(needs).flat())].filter((scope) => !allowed.includes(scope));
			if (beyond.length > 0)
				errors.push(`${builtIn.service}'s tools may need only ${allowed.join(", ")}: drop ${beyond.join(", ")}`);
		}
	}
	if (why.length > 2000) errors.push("say why in a few lines");
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
			...(groups === undefined ? {} : { groups }),
			...(Object.keys(readsWhen).length === 0 ? {} : { readsWhen }),
			reads,
			floors,
			...(accountParts === null || accountParts === undefined
				? {}
				: { account: { tool: accountParts[1] ?? "", field: accountParts[2] ?? "" } }),
			why,
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

/** Whether `name` can name a group in a file: a few plain words on one line. */
export const isGroupName = (name: string) => /^[\p{L}\p{N}][\p{L}\p{N} &'’,./-]{0,39}$/u.test(name);

/** What a group's name may be, in words a model is told. */
export const GROUP_NAME_RULE =
	"at most 40 characters: letters, digits and spaces, with & ' , . / - between them; no brackets, colons or underscores";

/** At most this many groups in a file: a few more than banda makes, for an owner who splits one. */
const MAX_FILE_GROUPS = 12;

/** A file's `groups`, read: each a name and its tools, no tool in two; or what is wrong with it. */
function parseGroups(value: unknown): { [group: string]: string[] } | string {
	const problem = `"groups" is {"Issues": ["tool", …], …}: at most ${MAX_FILE_GROUPS} short names, each tool in one`;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return problem;
	const entries = Object.entries(value);
	if (entries.length > MAX_FILE_GROUPS) return problem;
	const seen = new Set<string>();
	const groups: { [group: string]: string[] } = {};
	for (const [group, tools] of entries) {
		if (!isGroupName(group) || !Array.isArray(tools)) return problem;
		for (const tool of tools) {
			if (typeof tool !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(tool) || seen.has(tool)) return problem;
			seen.add(tool);
		}
		groups[group] = tools as string[];
	}
	return groups;
}

/**
 * `text` (a connection file) with its tools in `groups`, in its ```json block (added at the end of its body when it
 * has none); undefined when it would not read back as exactly those groups.
 */
export function withGroups(
	name: string,
	text: string,
	groups: { readonly [group: string]: readonly string[] },
): string | undefined {
	const fence = "`".repeat(3);
	const block = /```json\s*\n([\s\S]*?)\n```/.exec(text);
	let rewritten: string;
	if (block === null)
		rewritten = `${text.replace(/\s*$/, "")}\n\n${fence}json\n${JSON.stringify({ groups }, null, "\t")}\n${fence}\n`;
	else {
		let parsed: { [key: string]: unknown };
		try {
			parsed = JSON.parse(block[1] ?? "") as { [key: string]: unknown };
		} catch {
			return undefined;
		}
		const json = JSON.stringify({ ...parsed, groups }, null, "\t");
		rewritten = `${text.slice(0, block.index)}${fence}json\n${json}\n${fence}${text.slice(block.index + block[0].length)}`;
	}
	const again = parseConnection(name, rewritten);
	return "connection" in again && JSON.stringify(again.connection.groups) === JSON.stringify(groups)
		? rewritten
		: undefined;
}

/** `text` (a connection file) without `ask: always`, every other byte as it was. */
export function withoutAlways(text: string): string {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (match === null) return text;
	const kept = (match[1] ?? "").split("\n").filter((line) => !/^ask\s*:\s*always\s*$/.test(line));
	return `---\n${kept.join("\n")}\n---${text.slice(match[0].length)}`;
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
	/** The server's own word that it may destroy something: it makes the tool at least a write. */
	destructiveHint?: boolean;
};

/** An account: one sign-in to a connection, as the store knows it. */
export type Account = {
	/** What the service calls the owner, as read once after sign-in ("bandarra"); numbered when it says nothing. */
	id: string;
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

/**
 * The owner's setting of each connection's tool, by the name the model knows it by, beside its switch (`off` in
 * `Connected`, which is Off and switches the agent's own tools too): Allow, Ask or Always ask, as set; a tool with none
 * is as its kind says (`defaultOf`). And the tools listed after their connection was, not yet set: new, and off.
 */
type ToolSettingsValue = {
	set: { [tool: string]: Exclude<Setting, "off"> };
	fresh: { [tool: string]: true };
};

export const ToolSettings = defineDoc<ToolSettingsValue>({
	kind: "banda.tool-settings",
	version: 1,
	scope: "session",
	initial: () => ({ set: {}, fresh: {} }),
	checkpointWhen: () => true,
});

/**
 * banda's guesses for each connection's tools, from one inference over its listing (`listing`, a hash of the tools it
 * was made for): its groups, and each tool's kind and group. Derived and rebuildable, never permission by itself: a
 * guessed read only runs once the owner confirms it, and the owner's settings outlast any guess. `failed` says why
 * some of a listing's tools have none; those are asked again at the next start or listing.
 */
type ClassifiedValue = {
	connections: {
		[name: string]: {
			listing: string;
			groups: string[];
			tools: { [tool: string]: Guess };
			failed?: string;
		};
	};
};

export const Classified = defineDoc<ClassifiedValue>({
	kind: "banda.classified",
	version: 1,
	scope: "session",
	initial: () => ({ connections: {} }),
	checkpointWhen: () => true,
});

/** The hash of a listing a guess is made for: its tools' names and words, in order. */
export const listingSha = (tools: { readonly [tool: string]: Pick<Listed, "description"> }) =>
	createHash("sha256")
		.update(
			JSON.stringify(
				Object.keys(tools)
					.sort()
					.map((tool) => [tool, tools[tool]?.description ?? ""]),
			),
		)
		.digest("hex");

/** Whether connection file `path` is one banda ships, written by banda and changed since by nobody else. */
const shippedOf = (accepted: { readonly shipped?: { readonly [path: string]: boolean } }, name: string) =>
	accepted.shipped?.[connectionPath(name)] === true;

/** The group of the tools no other holds. */
const OTHER = "Other";

/**
 * What each listed tool of connection `name` does and which group it is in: as its file says, else its server's
 * annotations, else banda's guess, else a write; its group as the file says, else the guess, else by its name, in
 * groups a file can hold (`fitted`). Reads only.
 */
export async function classesOf(
	tx: Tx,
	connection: Connection,
): Promise<{ readonly [tool: string]: Classed & { readonly group: string } }> {
	const listed = (await tx.doc(Connected)).connections[connection.name]?.tools ?? {};
	const shipped = shippedOf(await tx.doc(Accepted), connection.name);
	const guesses = (await tx.doc(Classified)).connections[connection.name];
	const byName = nameGroups(Object.keys(listed).sort());
	const fileGroup = new Map(
		Object.entries(connection.groups ?? {}).flatMap(([group, tools]) => tools.map((tool) => [tool, group] as const)),
	);
	const groups = fitted(
		Object.fromEntries(
			Object.keys(listed).map((tool) => [
				tool,
				fileGroup.get(tool) ?? guesses?.tools[tool]?.group ?? byName[tool] ?? OTHER,
			]),
		),
		[...Object.keys(connection.groups ?? {}), ...(guesses?.groups ?? [])],
		Object.keys(connection.groups ?? {}).length,
	);
	return Object.fromEntries(
		Object.entries(listed).map(([tool, hints]) => [
			tool,
			{ ...classOf(connection, tool, hints, guesses?.tools[tool], shipped), group: groups[tool] ?? OTHER },
		]),
	);
}

/**
 * Each tool's group (`wanted`, by tool) in names a file can hold: a name it cannot hold is "Other", and past
 * `MAX_FILE_GROUPS` the groups `first` names stay, then the biggest, the rest together as "Other". The first `own`
 * of `first` (the file's) always stay.
 */
function fitted(
	wanted: { readonly [tool: string]: string },
	first: readonly string[],
	own: number,
): { readonly [tool: string]: string } {
	const named = Object.fromEntries(
		Object.entries(wanted).map(([tool, group]) => [tool, isGroupName(group) ? group : OTHER]),
	);
	const sizes = new Map<string, number>();
	for (const group of Object.values(named)) sizes.set(group, (sizes.get(group) ?? 0) + 1);
	const ranked = [
		...new Set([...first, ...[...sizes].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([group]) => group)]),
	].filter((group) => sizes.has(group));
	if (ranked.length <= MAX_FILE_GROUPS) return named;
	const kept = new Set(ranked.filter((group) => group !== OTHER).slice(0, Math.max(MAX_FILE_GROUPS - 1, own)));
	return Object.fromEntries(Object.entries(named).map(([tool, group]) => [tool, kept.has(group) ? group : OTHER]));
}

/** An account's key, the folder its credentials are in: its id, lowercase, or a hash of it when it is not a name. */
export function accountKey(id: string): string {
	const lower = id.normalize("NFC").toLowerCase().trim().replace(/\s+/g, "-");
	return /^[a-z0-9][a-z0-9._@+-]{0,99}$/.test(lower) && !lower.includes("..")
		? lower
		: `a-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

/** The argument a connection's tool takes its account in: `account`, unless the server's own tool has one so named. */
export const accountArg = (schema: JsonObject) =>
	(schema.properties as { [key: string]: unknown } | undefined)?.account === undefined ? "account" : "as_account";

/** An account as the owner reads it: "@bandarra", or an address as it is. */
export const accountLabel = (id: string) => (/[@\s]/.test(id) ? id : `@${id}`);

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
 * The connections whose tools need an `account` argument to tell their accounts apart, with those accounts' ids: a
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
					.map((account) => account.id)
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
	const { set } = await tx.doc(ToolSettings);
	const found: InEffect[] = [];
	for (const path of Object.keys(files).sort()) {
		const name = /^connections\/(.+)\.md$/.exec(path)?.[1];
		if (name === undefined) continue;
		const connection = await acceptedConnection(tx, name);
		const listed = connections[name];
		if (connection === undefined || listed === undefined || listed.sha !== connection.sha) continue;
		const classes = connection.command === undefined ? await classesOf(tx, connection) : {};
		for (const [tool, shape] of Object.entries(listed.tools).sort(([a], [b]) => a.localeCompare(b))) {
			const model = toolName(name, tool);
			if (off[model] === true || found.some((other) => other.name === model)) continue;
			const classed = classes[tool];
			const level = set[model] ?? (classed === undefined ? undefined : defaultOf(classed.kind));
			// the owner's Ask on a read, or Always ask on a write, puts it on the floor for every agent
			const asked = classed !== undefined && (level === "always" || (level === "ask" && classed.kind === "read"));
			const floor = Object.hasOwn(connection.floors, tool)
				? connection.floors[tool]
				: asked
					? classed.kind === "floor" && classed.floor !== undefined
						? classed.floor
						: "owner"
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
				read: connection.command !== undefined || (connection.reads.includes(tool) && !asked),
				...(connection.command === undefined && connection.readsWhen?.[tool] !== undefined && !asked
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

/**
 * The connection tool the model knows as `name` as it is in effect now: a read or a write, and its floor, as its file and
 * the owner's settings say them in this commit, whatever the tool the model was offered said. Reads only.
 */
export async function connectionTool(tx: Tx, name: string): Promise<InEffect | undefined> {
	if (!name.includes("__")) return undefined;
	return (await connectionTools(tx)).find((tool) => tool.name === name);
}

/** Whether the tool the model knows as `name` is in effect now, checked in the commit that starts a call. */
export async function inEffect(tx: Tx, name: string): Promise<boolean> {
	if (name.includes("__")) return (await connectionTool(tx, name)) !== undefined;
	return (await ownTools(tx)).some((tool) => tool.name === name);
}

/**
 * Whether a call of the tool the model knows as `name` with `args` runs as a read now, checked in the commit that starts
 * it: a read the owner set to Ask since it was offered does not. Reads only.
 */
export async function readsNow(tx: Tx, name: string, args: unknown): Promise<boolean> {
	const tool = await connectionTool(tx, name);
	return tool !== undefined && (tool.read || readsFor(tool.readsWhen, args));
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
