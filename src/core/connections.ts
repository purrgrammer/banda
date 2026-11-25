/**
 * Connections (DESIGN.md "Connections"): what an agent may use beyond its box. A connection is a definition banda ships
 * (`definitions.ts`, read from the release) or a server the owner added by address (a record in `Connected`), never a
 * file in the workspace. A remote server is called by the daemon outside the box, with the credentials it keeps in
 * `auth/`; its definition says which of its tools only read, every other tool is a write, a draft the owner approves,
 * and a tool it names under a floor class asks every time.
 *
 * The store holds what this home chose: the tools a server listed for a version of its definition, the accounts signed
 * in to each (an account is one sign-in, named by what the service calls the owner), and the owner's switches: per tool,
 * and per agent and account. Credentials never enter it: they live in `auth/connections/<connection>/<account>/`, bound
 * to the URL they were given for, so a changed URL never carries them along. The store is the truth of which accounts
 * exist: credentials it does not name are a sign-in that did not finish, or a sign-out that did, and are forgotten.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { defineDoc, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { checksummed } from "../wallet/address.ts";
import { NetworkId } from "../wallet/networks.ts";
import { Accepted, AGENT_NAME, type Agent, agentPath, LEAD, parseAgent } from "./agents.ts";
import { shippedDefinition, shippedDefinitions } from "./definitions.ts";
import { writeDurably } from "./durable-file.ts";
import { type DefinedFloor, FLOORS, type Floor } from "./floor.ts";
import { harnessToolsOf } from "./harness.ts";
import { CLIENTS, clientNamed, type OAuthClient, type OAuthServer, type Pending, type Tokens } from "./oauth.ts";
import { type ObjectKinds, parseObjects } from "./objects.ts";
import { plainLine } from "./plain-line.ts";
import { REST_APIS, type RestApiName, restApiNamed } from "./rest.ts";
import type { Said } from "./tool-kinds.ts";

/** What a definition banda ships may weigh. */
export const MAX_DEFINITION_BYTES = 64 * 1024;

/**
 * How the daemon signs in to a remote server: not at all, with a key the owner types, or with OAuth; or, for banda's
 * own wallet connection alone, as a wallet whose key the OS keychain holds (docs/wallets.md "Architecture").
 */
export type AuthKind = "none" | "key" | "oauth" | "wallet";

/** The connection each wallet is an account of. */
export const WALLET = "wallet";

/**
 * Where the wallet connection is, for the shape every connection has: a name under `.invalid` (RFC 6761), which no
 * resolver answers. A wallet reaches its network's RPC (src/wallet/networks.ts, config.json), never this, and its
 * definition names no url.
 */
export const WALLET_URL = "https://wallet.invalid";

/** A connection, as its definition or record says. */
export type Connection = {
	readonly name: string;
	/** The service, as the owner calls it: "your calendar", "Linear". */
	readonly service: string;
	/** The server's URL, called by the daemon. */
	readonly url: string;
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
	/** What it lets the band do, in a line for the owner: a definition banda ships says it. */
	readonly about?: string;
	/** Its tools in groups, in order, as a definition says: a tool in none goes by its name. */
	readonly groups?: { readonly [group: string]: readonly string[] };
	/** What its tools do, in the owner's words, as a definition says: a tool with none goes by its name. */
	readonly words?: { readonly [tool: string]: string };
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

const nameError = (name: string) =>
	`"${name}" is not a connection name: use lowercase letters, digits and dashes, such as "calendar"`;

/**
 * What a connection says, before the checks across its fields: from a definition banda ships (`definitions.ts`), whose
 * schema has checked each field's shape already, or from a server's record.
 */
export type ConnectionFields = {
	readonly words?: { readonly [tool: string]: string };
	readonly service: string | undefined;
	readonly url: string | undefined;
	readonly api?: string | undefined;
	readonly auth?: string | undefined;
	readonly ask?: string | undefined;
	readonly client?: string | undefined;
	readonly scopes?: readonly string[];
	/** The read and the field of its answer that name the account: `get_me.login`. */
	readonly account?: string | undefined;
	readonly reads: readonly string[];
	readonly floors: { readonly [floor in DefinedFloor]?: readonly string[] };
	readonly needs?: { readonly [tool: string]: readonly string[] };
	readonly objects?: unknown;
	readonly about?: string;
	readonly groups?: { readonly [group: string]: readonly string[] };
	readonly access?: Access;
};

/**
 * The connection `fields` say, or every problem with them, each saying what to write instead: the checks a schema
 * cannot say (a built-in's client and scopes within its registry's ceiling, a read that is not also on a floor, the
 * kinds' templates and paths, an access choice within what an account may ask for).
 */
export function connectionOf(name: string, fields: ConnectionFields): ParsedConnection {
	const errors: string[] = [];
	if (!AGENT_NAME.test(name)) errors.push(nameError(name));
	const service = fields.service ?? "";
	if (service === "") errors.push(`add "service:", the service as the owner calls it, such as "your calendar"`);
	const { client, scopes } = fields;
	const wallet = fields.auth === "wallet";
	if (wallet && fields.url !== undefined)
		errors.push(`"auth: wallet" names no "url": a wallet reaches its network's RPC, which config.json sets`);
	const url = wallet ? WALLET_URL : fields.url;
	const apiName = fields.api;
	const api = apiName === undefined ? undefined : restApiNamed(apiName);
	const builtIn = api === undefined ? undefined : REST_APIS[api];
	if (url === undefined) errors.push('add "url:", the server\'s address');
	else if (!remoteUrl(url)) errors.push(`"url: ${url}" is not an https address`);
	if (apiName !== undefined && (builtIn === undefined || url !== builtIn.url))
		errors.push(
			`a built-in API is one of ${Object.entries(REST_APIS)
				.map(([name, { url }]) => `"${name}" at ${url}`)
				.join(", ")}`,
		);
	const auth = fields.auth ?? "none";
	if (auth !== "none" && auth !== "key" && auth !== "oauth" && auth !== "wallet")
		errors.push(
			`"auth: ${auth}": use none, key (the owner types one in), oauth (the owner signs in) or wallet (banda's own)`,
		);
	if (auth === "wallet" && (name !== WALLET || apiName !== undefined || fields.account !== undefined))
		errors.push(`"auth: wallet" is banda's own connection named ${WALLET}, with no "api" and no "account"`);
	if (auth === "wallet" && fields.access !== undefined)
		errors.push(`"access" is for a server the owner signs in to: a wallet asks for none`);
	// a wallet's tools are banda's own reads; what it pays is asked in its own words, never under a floor
	if (
		auth === "wallet" &&
		(Object.values(fields.floors).some((tools) => (tools ?? []).length > 0) ||
			fields.objects !== undefined ||
			fields.groups !== undefined ||
			fields.needs !== undefined ||
			fields.ask !== undefined)
	)
		errors.push(`"auth: wallet" names only its reads: no floors, "objects", "groups", "needs" or "ask"`);
	const ask = fields.ask;
	if (ask !== undefined && ask !== "always")
		errors.push('"ask: always" is for a remote connection whose non-read tools must ask every time');
	if (
		builtIn !== undefined &&
		(auth !== "oauth" ||
			client !== builtIn.client ||
			scopes === undefined ||
			!builtIn.required.every((scope) => scopes.includes(scope)) ||
			!scopes.every((scope) => (builtIn.scopes as readonly string[]).includes(scope)) ||
			new Set(scopes).size !== scopes.length)
	)
		errors.push(
			`${builtIn.service} uses OAuth client "${builtIn.client}", asks for ${builtIn.required.join(" and ")}, and may add ${builtIn.scopes
				.filter((scope) => !(builtIn.required as readonly string[]).includes(scope))
				.join(" or ")}`,
		);
	if (auth !== "oauth" && (client !== undefined || scopes !== undefined))
		errors.push(`"client" and "scopes" are for a server the owner signs in to: add "auth: oauth" or drop them`);
	if (client !== undefined && clientNamed(client) === undefined && !/^[\w.-]{1,200}$/.test(client))
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
	if (accountRead !== undefined && auth === "none")
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
	const grouped = Object.values(fields.groups ?? {}).flat();
	for (const tool of new Set(grouped.filter((tool, index) => grouped.indexOf(tool) !== index)))
		errors.push(`"${tool}" is in two groups: keep it in one`);
	const needs = fields.needs;
	let objects: ObjectKinds | undefined;
	if (fields.objects !== undefined) {
		const isRead = (tool: string, args: { readonly [arg: string]: unknown }) =>
			reads.includes(tool) || readsFor(readsWhen[tool], args);
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
	if (errors.length > 0 || url === undefined) return { errors };
	return {
		connection: {
			name,
			service,
			url,
			...(api === undefined ? {} : { api }),
			auth: auth as AuthKind,
			...(ask === "always" ? { ask: "always" as const } : {}),
			...(client === undefined ? {} : { client }),
			...(scopes === undefined ? {} : { scopes }),
			...(needs === undefined ? {} : { needs }),
			...(fields.groups === undefined ? {} : { groups: fields.groups }),
			...(fields.words === undefined ? {} : { words: fields.words }),
			...(objects === undefined ? {} : { objects }),
			...(Object.keys(readsWhen).length === 0 ? {} : { readsWhen }),
			reads,
			floors,
			...(accountParts === null || accountParts === undefined
				? {}
				: { account: { tool: accountParts[1] ?? "", field: accountParts[2] ?? "" } }),
			...(fields.about === undefined ? {} : { about: fields.about }),
			...(access === undefined ? {} : { access }),
		},
	};
}

/** A connection's `reads` as written: its tools' names, then its rules. */
export const readItems = (connection: Connection): string[] => [
	...connection.reads,
	...Object.entries(connection.readsWhen ?? {}).flatMap(([tool, rules]) =>
		rules.map((rule) => `${tool}(${rule.arg}=${rule.value})`),
	),
];

/** A tool as a server listed it when it was connected: what the model is offered, fixed until it is listed again. */
export type Listed = {
	/**
	 * Which listing of the tool this is, from `versions`: what a draft and a permission are bound to. A listing kept
	 * from before listings were numbered has none, and stays so while the same definition lists it again: read it
	 * through `listingOf`.
	 */
	generation?: number;
	description: string;
	schema: JsonObject;
	/** The server's own word that it only reads, shown, never trusted. */
	readOnlyHint?: boolean;
	/** The server's own word that it can destroy something: it is at least a write. */
	destructiveHint?: boolean;
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
 * A server the owner added by address: what the daemon stores in the commit that takes the owner's choice, and all of
 * what connects to it. Its reads are an overlay (`OwnerReads`), as on any connection; its credentials stay with its
 * accounts. `version` moves with each change to it.
 */
export type Server = {
	service: string;
	url: string;
	auth: AuthKind;
	client?: string;
	scopes?: string[];
	version: number;
	at: number;
};

/** The tools the owner said only read, on top of what the connection's definition says; its version is its own. */
export type OwnerReads = { tools: string[]; version: number };

/**
 * What the connections hold: for each, the tools its server listed and for which version of its definition, and when;
 * the tools the owner switched off, by the name the model knows them by; the accounts signed in, by connection and by
 * key (the folder their credentials are in); and which accounts each agent may use, by agent and connection.
 */
type ConnectedValue = {
	/** Monotonic revocation generation: an in-flight read cannot survive revoke/regrant (ABA). */
	epoch: number;
	connections: {
		[name: string]: {
			version: string;
			tools: { [tool: string]: Listed };
			/** The server's own notes about its tools, as it gave them when first listed for this file. */
			notes?: string;
			/** The tool whose description carries them, chosen then: they never move to another. */
			notesOn?: string;
			/**
			 * Carried over from an earlier build's definition. Its next listing accepts the current shapes and notes;
			 * a newly listed tool waits for the owner.
			 */
			due?: true;
			at: number;
		};
	};
	/**
	 * Tools off, by the model's name for them, and why: `owner`, the owner switched it off, kept by name across versions;
	 * `waiting`, a tool the server listed alone, waiting for the owner. A definition that comes to name a waiting tool
	 * switches it on; the owner switching it, on or off, settles it.
	 */
	off: { [tool: string]: "owner" | "waiting" };
	accounts: { [connection: string]: { [account: string]: Account } };
	on: { [agent: string]: { [connection: string]: string[] } };
	/** Owner-managed anonymous connections have explicit agent switches, not invented accounts. */
	public: { [connection: string]: string[] };
	/** The connections banda ships that the owner added in this home, and when: its definition is banda's. */
	added: { [connection: string]: { at: number } };
	/** The servers the owner added by address, one record each; never a file, never written by anything in the box. */
	servers: { [connection: string]: Server };
	/** The owner's reads over a connection's definition; they outlive its versions and go when the connection does. */
	reads: { [connection: string]: OwnerReads };
	/** The last version given to a record, overlay or listed tool: never reused after removal. */
	versions: number;
};

/** What is connected and who may use it. */
export const Connected = defineDoc<ConnectedValue>({
	kind: "banda.connections",
	// 2: owner-managed anonymous connections keep their agent switches in `public`; a version 1 doc had none
	version: 2,
	scope: "session",
	initial: () => ({
		epoch: 0,
		connections: {},
		off: {},
		accounts: {},
		on: {},
		public: {},
		added: {},
		servers: {},
		reads: {},
		versions: 0,
	}),
	migrate: (value, from) => (from >= 2 ? value : { ...value, public: {} }) as unknown as ConnectedValue,
	checkpointWhen: () => true,
});

/**
 * What the owner set each connection's tool to, by the model's name for it, beside its switch (`off` in `Connected`).
 * Only what narrows: Ask, or Always ask. A tool with none is as its kind says; Allow is the absence of one, so nothing
 * here can ever widen what a definition says. Kept by name across versions, like a switch, and gone with the connection.
 */
export type ToolSettingsValue = { set: { [tool: string]: "ask" | "always" } };

export const ToolSettings = defineDoc<ToolSettingsValue>({
	kind: "banda.tool-settings",
	version: 1,
	scope: "session",
	initial: () => ({ set: {} }),
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
export const signsIn = (connection: Pick<Connection, "auth">) => connection.auth !== "none";

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

/** The version a definition or record has before the owner's overlay: what an allowed read does not move. */
export function definitionVersion(version: string): string;
export function definitionVersion(version: string | undefined): string | undefined;
export function definitionVersion(version: string | undefined): string | undefined {
	return version?.replace(/\.r\d+$/, "");
}

/**
 * The name the model knows a connection's tool by: stable, `<connection>__<tool>`, within a model's 64 characters. A name
 * that had to be cut or cleaned ends in a short hash of the whole, so two tools never come to share one.
 */
export function toolName(connection: string, tool: string): string {
	const cleaned = tool.replace(/[^A-Za-z0-9_-]/g, "_");
	const whole = `${connection}__${cleaned}`;
	if (cleaned === tool && whole.length <= 64) return whole;
	const hash = `_${createHash("sha256").update(`${connection}__${tool}`).digest("hex").slice(0, 8)}`;
	return `${whole.slice(0, 64 - hash.length)}${hash}`;
}

/** The connection a server's record is: every tool asks until the owner says it reads; its version is the record's. */
export function serverConnection(name: string, server: Server): Connection & { version: string } {
	return {
		name,
		service: server.service,
		url: server.url,
		auth: server.auth,
		ask: "always",
		...(server.client === undefined ? {} : { client: server.client }),
		...(server.scopes === undefined ? {} : { scopes: [...server.scopes] }),
		reads: [],
		floors: {},
		version: `s${server.version}`,
	};
}

/**
 * `connection` with the owner's reads laid over it, in no way the definition's: a floor it names still asks, and a tool
 * a later definition names and does not read is a write it says it is, whatever the owner allowed before. Kept in the
 * store by name, so it returns if the definition stops naming it.
 */
function withOwnerReads(
	connection: Connection & { version: string },
	overlay: OwnerReads | undefined,
): Connection & { version: string } {
	if (overlay === undefined) return connection;
	const named = namedTools(connection);
	const reads = overlay.tools.filter(
		(tool) => connection.floors[tool] === undefined && (!named.has(tool) || connection.reads.includes(tool)),
	);
	const readsWhen = Object.fromEntries(
		Object.entries(connection.readsWhen ?? {}).filter(([tool]) => !reads.includes(tool)),
	);
	return {
		...connection,
		reads: [...new Set([...connection.reads, ...reads])],
		...(Object.keys(readsWhen).length === 0 ? {} : { readsWhen }),
		version: `${connection.version}.r${overlay.version}`,
	};
}

/**
 * What connection `name`'s definition says of its tools, as `classOf` needs it: a server the owner added says nothing
 * and asks every time; else as banda ships it.
 */
export function saidOf(name: string, connection: Connection, server: boolean): Said {
	if (server) return { reads: [], floors: {}, named: new Set(), ask: "always" };
	const base = shippedDefinition(name) ?? connection;
	return {
		reads: base.reads,
		...(base.readsWhen === undefined ? {} : { readsWhen: base.readsWhen }),
		floors: base.floors,
		named: namedTools(base),
		...(base.ask === undefined ? {} : { ask: base.ask }),
	};
}

/**
 * The connection `name` in effect: one banda ships, as this banda ships it, while the owner has it added; or a server
 * the owner added, from its record. Its `version` is a definition's hash or a record's counter, with the
 * owner's reads' own counter when they laid any over it. Reads only.
 */
export async function acceptedConnection(
	tx: Tx,
	name: string,
): Promise<(Connection & { version: string }) | undefined> {
	const doc = await tx.doc(Connected);
	const shipped = shippedDefinition(name);
	if (shipped !== undefined)
		return doc.added[name] === undefined ? undefined : withOwnerReads(shipped, doc.reads[name]);
	const server = doc.servers[name];
	return server === undefined ? undefined : withOwnerReads(serverConnection(name, server), doc.reads[name]);
}

/** The names of the connections in effect, sorted: the shipped ones added in this home and the servers the owner added. Reads only. */
export async function acceptedNames(tx: Tx): Promise<string[]> {
	const shipped = shippedDefinitions();
	const doc = await tx.doc(Connected);
	const added = Object.keys(doc.added).filter((name) => shipped.has(name));
	return [...added, ...Object.keys(doc.servers)].sort();
}

/**
 * The tools connection `connection` names, so they come with its version, switched on: its reads and their rules, the
 * scopes' tools, the floors, the account's read, its kinds' reads and writes, and a built-in API's own tools. A tool a
 * server lists that its definition does not name waits for the owner.
 */
export function namedTools(connection: Connection): Set<string> {
	const named = new Set<string>([
		...connection.reads,
		...Object.keys(connection.readsWhen ?? {}),
		...Object.keys(connection.needs ?? {}),
		...Object.keys(connection.floors),
		...(connection.account === undefined ? [] : [connection.account.tool]),
		...(connection.api === undefined ? [] : REST_APIS[connection.api].tools.map((tool) => tool.name)),
	]);
	for (const kind of Object.values(connection.objects ?? {})) {
		for (const read of Object.values(kind.reads)) named.add(read.tool);
		for (const write of kind.writes ?? []) named.add(write.tool);
		for (const create of kind.creates ?? []) named.add(create.tool);
	}
	return named;
}

/** A connection's tool in effect: whose, its server's name for it, and whether it is a read or on the floor. */
export type InEffect = {
	readonly name: string;
	readonly connection: Connection & { version: string };
	readonly tool: string;
	readonly listed: Listed;
	readonly read: boolean;
	/** For a tool that only reads for some arguments: its rules (a call matching one runs as a read). */
	readonly readsWhen?: readonly ReadRule[];
	readonly floor?: Floor;
	/** The server's notes, carried by the one tool chosen when it was listed, so they reach the model once. */
	readonly notes?: string;
};

export const accountArg = (schema: JsonObject) =>
	(schema.properties as { [key: string]: unknown } | undefined)?.account === undefined ? "account" : "as_account";

export type ToolAuthority = {
	readonly connection: string;
	readonly tool: string;
	readonly version: string;
	readonly listing: number;
	readonly accountArg?: "account" | "as_account";
};

/** A listed tool's number. One never numbered is 0, which `versions` gives to none: listed anew, it takes a number. */
export const listingOf = (listed: Listed): number => listed.generation ?? 0;

export const toolAuthority = (tool: InEffect): ToolAuthority => ({
	connection: tool.connection.name,
	tool: tool.tool,
	version: definitionVersion(tool.connection.version),
	listing: listingOf(tool.listed),
	...(signsIn(tool.connection) ? { accountArg: accountArg(tool.listed.schema) } : {}),
});

export function sameToolAuthority(left: ToolAuthority | undefined, right: ToolAuthority | undefined): boolean {
	return left === undefined || right === undefined
		? left === right
		: left.connection === right.connection &&
				left.tool === right.tool &&
				left.version === right.version &&
				left.listing === right.listing &&
				left.accountArg === right.accountArg;
}

export async function validToolAuthority(tx: Tx, name: string, authority: ToolAuthority | undefined): Promise<boolean> {
	if (authority === undefined) return true;
	if (toolName(authority.connection, authority.tool) !== name) return false;
	const connection = await acceptedConnection(tx, authority.connection);
	const listed = (await tx.doc(Connected)).connections[authority.connection]?.tools[authority.tool];
	return (
		connection !== undefined &&
		listed !== undefined &&
		definitionVersion(connection.version) === authority.version &&
		listingOf(listed) === authority.listing &&
		(signsIn(connection) ? accountArg(listed.schema) : undefined) === authority.accountArg
	);
}

/**
 * Every connection tool in effect now: its connection on, listed for that very version, and not switched
 * off. Reads only.
 */
export async function connectionTools(tx: Tx): Promise<InEffect[]> {
	const { connections, off } = await tx.doc(Connected);
	const { set } = await tx.doc(ToolSettings);
	const found: InEffect[] = [];
	for (const name of await acceptedNames(tx)) {
		const connection = await acceptedConnection(tx, name);
		const listed = connections[name];
		if (connection === undefined || listed === undefined || listed.version !== connection.version) continue;
		for (const [tool, shape] of Object.entries(listed.tools).sort(([a], [b]) => a.localeCompare(b))) {
			const model = toolName(name, tool);
			if (off[model] !== undefined || found.some((other) => other.name === model)) continue;
			const reads = connection.reads.includes(tool) || connection.readsWhen?.[tool] !== undefined;
			// the owner's Ask on a read, or Always ask on anything, puts it on the floor; a definition's own floor stays
			const narrowed = set[model] === "always" || (set[model] === "ask" && reads);
			const floor = Object.hasOwn(connection.floors, tool)
				? connection.floors[tool]
				: narrowed
					? "owner"
					: connection.ask === "always" && !connection.reads.includes(tool)
						? "private"
						: undefined;
			const carried = tool === listed.notesOn ? listed.notes : undefined;
			found.push({
				name: model,
				connection,
				tool,
				listed: JSON.parse(JSON.stringify(shape)) as Listed,
				read: connection.reads.includes(tool) && !narrowed,
				...(connection.readsWhen?.[tool] !== undefined && !narrowed ? { readsWhen: connection.readsWhen[tool] } : {}),
				...(floor === undefined ? {} : { floor }),
				...(carried === undefined ? {} : { notes: carried }),
			});
		}
	}
	return found;
}

/** Tool `name` of the connection tools in effect now, if it is one. Reads only. */
export async function connectionTool(tx: Tx, name: string): Promise<InEffect | undefined> {
	if (!name.includes("__")) return undefined;
	return (await connectionTools(tx)).find((tool) => tool.name === name);
}

/** Whether the tool the model knows as `name` is in effect now, checked in the commit that starts a call. */
export async function inEffect(tx: Tx, name: string): Promise<boolean> {
	return (await connectionTools(tx)).some((tool) => tool.name === name);
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

/**
 * A wallet account's credentials: where its key is, never the key. `account` is the keychain item's account, and the
 * address and network the key must prove when it is read (C20). Bound to no URL: changing the network's RPC leaves
 * the wallet as it was.
 */
export type WalletCredentials = {
	readonly wallet: { readonly account: string; readonly address: string; readonly network: NetworkId };
};

const WalletFile = Type.Object(
	{
		wallet: Type.Object(
			{
				account: Type.String({ minLength: 1 }),
				address: Type.String({ pattern: "^0x[0-9a-fA-F]{40}$" }),
				network: NetworkId,
			},
			{ additionalProperties: false },
		),
		revision: Type.Optional(Type.String()),
		generation: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/**
 * A wallet's credentials, when the file holds exactly what one is, its address in the EIP-55 form a wallet is kept in;
 * a file that marks a wallet and fails is none.
 */
export const walletOf = (credentials: Credentials | undefined): WalletCredentials["wallet"] | undefined =>
	Value.Check(WalletFile, credentials) && canonical(credentials.wallet.address) ? credentials.wallet : undefined;

function canonical(address: string): boolean {
	try {
		return checksummed(address) === address;
	} catch {
		return false;
	}
}

/** An account's credentials, bound to the URL they were given for; a wallet's, to none. */
export type Credentials = (
	| { readonly url: string; readonly key: string }
	| {
			readonly url: string;
			readonly oauth: { readonly server: OAuthServer; readonly client: OAuthClient; readonly tokens: Tokens };
	  }
	| WalletCredentials
) & { readonly revision?: string; readonly generation?: string };

const credentialsDir = (home: string) => join(home, "auth", "connections");
const accountDir = (home: string, name: string, account: string) => join(credentialsDir(home), name, account);
const pendingDir = (home: string) => join(home, "auth", "oauth");

/**
 * Owner-only, whole and on disk before it is answered: the store's commit naming the account follows it, and a power
 * cut between must never leave an account whose file is gone (a wallet is never signed in again to write it back).
 * The folders made for it are flushed into their parents too.
 */
async function writePrivate(path: string, value: unknown): Promise<void> {
	const folder = dirname(path);
	const made = await mkdir(folder, { recursive: true, mode: 0o700 });
	await writeDurably(path, JSON.stringify(value), { mode: 0o600 });
	if (made === undefined || process.platform === "win32") return;
	for (let at = folder; at !== dirname(made); at = dirname(at)) {
		const directory = await open(dirname(at), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
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
 * Whether `credentials` were given for `connection` as its definition says it now: the same URL, and for a sign-in,
 * the client it names, the scope every account asks for, and nothing beyond what the file lets an account ask for.
 * Each account asks for its own scopes: changing the definition's default leaves them be, while narrowing what may be asked
 * or changing the client needs a new sign-in; the old token is never stretched to cover it.
 */
export function fits(credentials: Credentials | undefined, connection: Connection): credentials is Credentials {
	if (credentials === undefined) return false;
	// a file that marks a wallet is one only when it holds exactly what a wallet's do
	if ("wallet" in credentials) return connection.auth === "wallet" && walletOf(credentials) !== undefined;
	if (connection.auth === "wallet" || credentials.url !== connection.url) return false;
	if (!("oauth" in credentials)) return connection.auth === "key";
	if (connection.auth !== "oauth") return false;
	const shipped = clientNamed(connection.client);
	if (shipped !== undefined) {
		if (credentials.oauth.client.id !== CLIENTS[shipped].client().id) return false;
	} else if (connection.client !== undefined && credentials.oauth.client.id !== connection.client) return false;
	// what was asked, not what was granted: a scope the owner left out at the consent screen is theirs to add again
	const asked = credentials.oauth.server.scopes ?? [];
	const ceiling = ceilingOf(connection);
	// a sign-in that asked for nothing was given the server's default, which a file naming scopes does not allow
	if (ceiling !== undefined && (asked.length === 0 || !asked.every((scope) => ceiling.includes(scope)))) return false;
	return requiredOf(connection).every((scope) => asked.includes(scope));
}

/**
 * Whether a sign-in has run out at `at` with nothing to renew it: its access token's time, as the server said, is past
 * and the server gave no refresh token. Only the owner signing in again brings it back; the daemon never does it alone.
 */
export function expiredAt(credentials: Credentials | undefined, at: number): boolean {
	if (credentials === undefined || !("oauth" in credentials)) return false;
	const { refresh, expires } = credentials.oauth.tokens;
	return refresh === undefined && expires !== undefined && expires <= at;
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
			// read as the file is, whatever else it holds: a wallet's members name where its key is and are no secret, but
			// a file that also carries a key or a token still has that hidden
			const held = (await credentialsOf(home, name, account)) as
				| {
						key?: unknown;
						oauth?: { tokens?: { access?: unknown; refresh?: unknown }; client?: { secret?: unknown } };
				  }
				| undefined;
			if (typeof held !== "object" || held === null) continue;
			const oauth = typeof held.oauth === "object" && held.oauth !== null ? held.oauth : undefined;
			for (const secret of [held.key, oauth?.tokens?.access, oauth?.tokens?.refresh, oauth?.client?.secret])
				if (typeof secret === "string") found.push(secret);
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
