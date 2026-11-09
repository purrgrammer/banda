/**
 * Permissions (DESIGN.md "Messages", "Trust" law 2): an approval the owner gave with a scope, stored, so an effect of the
 * same shape runs without asking while the permission is open. A permission is a bookkeeping doc written in the commit of the
 * approval that gave it, and it is bound to content: one tool, and the values of the arguments that tool names as what
 * a permission binds (every argument, unless the tool says fewer). A later call is covered when it calls the same tool with
 * exactly those values (equal as canonical JSON); its other arguments are free. Below every permission sits the floor:
 * money, credentials, account changes and private data to a recipient the owner has not approved. A draft on the floor
 * carries no permission shape, a permission for it is refused, and no permission ever covers it, whatever the store holds.
 *
 * Scopes: once (no permission at all); the task, which is the input the chat is answering, so a permission for the task
 * ends when the owner writes to the chat again or a routine wakes it; a time window, until a moment within a week; always, until revoked. Revoking deletes the permission in one commit, and an
 * effect checks its permission in the commit that records it starting, so a revoked permission covers nothing after it.
 *
 * Which scopes an ask offers is the daemon's to say (`offeredScopes`), each worded as its consequence, the task's
 * first: none on the floor, none for an interrupted run, none in a chat that read foreign content (its sends ask
 * whatever was allowed); an answer giving a scope that was not offered is refused. One exception, the owner's to take:
 * a held request offers its host (`host`), a permission for anything sent there, always, which holds even in a chat
 * that read foreign content. It binds a second shape the tool declares, never a wider value of the first.
 */
import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	defineDoc,
	type EntryId,
	type Harness,
	type JsonObject,
	type Tx,
} from "@earendil-works/pi-durable";
import { log } from "./activity.ts";
import { AgentChats, agentWords, ChatAgent, LEAD } from "./agents.ts";
import { Companion } from "./companion.ts";
import { connectionTool } from "./connections.ts";

import { FLOOR_WORDS, type Floor } from "./floor.ts";
import { allowedHost, hostCovers } from "./hosts.ts";
import { WAKE, type WakeData } from "./routines.ts";
import { context } from "./store.ts";

export { FLOOR_WORDS, FLOORS, type Floor } from "./floor.ts";

/** How long a permission may be given for, at most, short of always. */
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** What the owner gives with an approval: a permission for the task, until a time, or always; none means this once. */
export type PermissionScope =
	| { readonly scope: "task" }
	| { readonly scope: "until"; readonly until: number }
	| { readonly scope: "always" }
	| { readonly scope: "host" };

/** The task a chat works on: the chat and the input it is answering. */
export type Errand = { readonly chat: number; readonly input: number };

/** What a permission would cover, as the tool's code says: the arguments it binds, and those effects in words. */
export type PermissionShape = {
	readonly match: JsonObject;
	readonly what: string;
	/** The scopes it may be given for, when not every one but a host's: opening a signed-in site lasts a task at most. */
	readonly lasts?: readonly ScopeKind[];
};

/**
 * What a permission serves, for the owner's list: the task it was given in, titled by the owner's words; or the
 * routine whose run asked for it. (An artifact, once artifacts are stored, joins as its own kind.)
 */
export type Serves =
	| { readonly kind: "task"; readonly chat: number; readonly input: number; readonly title: string }
	| { readonly kind: "routine"; readonly routine: string; readonly title: string }
	| { readonly kind: "artifact"; readonly id: string; readonly title: string };

/**
 * A scope an ask offers: "hour" and "today" are windows, timed when the owner answers; "host" is always, over the ask's
 * host shape, for the chats of the agent that asked.
 */
export type ScopeKind = "task" | "hour" | "today" | "always" | "host";

/**
 * A scope an ask offers, and what it would let happen, in words: "Send messages to ana without asking until …"; a
 * host's names its host, for its button.
 */
export type OfferedScope = { readonly scope: ScopeKind; readonly words: string; readonly host?: string };

export type Permission = {
	readonly tool: string;
	readonly match: JsonObject;
	/** The effects it covers, in the daemon's words: "send an email to ana@example.com". */
	readonly what: string;
	/** "host": always, but only the chats of its agent. */
	readonly scope: PermissionScope["scope"];
	readonly until?: number;
	readonly task?: Errand;
	/** The task it was given in, whatever its scope: what it serves. */
	readonly from?: Errand;
	/** The agent of the chat it was given in; a host permission covers only that agent's chats. */
	readonly agent?: string;
	/** When it was given, and by which approval (its Wait). */
	readonly at: number;
	readonly wait: number;
};

type PermissionsValue = { permissions: { [id: string]: Permission }; next: number };

/** The permissions given and not revoked, by id (a number, as text), and the next id. */
export const Permissions = defineDoc<PermissionsValue>({
	kind: "banda.permissions",
	// 2: a permission names its agent; one given before (version 1) was the lead's, whose chats it covered
	version: 2,
	scope: "session",
	initial: () => ({ permissions: {}, next: 1 }),
	migrate: (value, from) => {
		const doc = value as unknown as PermissionsValue;
		if (from >= 2) return doc;
		const permissions: { [id: string]: Permission } = {};
		for (const [id, permission] of Object.entries(doc.permissions ?? {}))
			permissions[id] =
				permission.scope === "host" && permission.agent === undefined
					? { ...permission, agent: LEAD, what: `your lead may ${permission.what}` }
					: permission;
		return { ...doc, permissions };
	},
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

/**
 * The agent `chat` runs, as the store records it for every chat it starts (`AgentChats`); undefined for a chat it
 * records none for, which no host permission covers. The daemon tells the proxy the same mapping. Reads only.
 */
export async function agentOfChat(tx: Tx, chat: number): Promise<string | undefined> {
	return (await tx.doc(AgentChats)).chats[chat];
}

/** The agent `chat` runs, as the owner calls it: the lead by the companion's name. Reads only. */
export async function agentName(tx: Tx, chat: number): Promise<string | undefined> {
	const agent = await agentOfChat(tx, chat);
	if (agent === undefined) return undefined;
	if (agent === LEAD) return (await tx.doc(Companion)).name ?? "your lead";
	return (await tx.doc(ChatAgent, chat as ConversationId)).agent?.name ?? agent;
}

/** JSON with its keys sorted, so equal values have one spelling. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value ?? null);
}

/** The task `chat` works on now. Reads only. */
export async function errandOf(tx: Tx, chat: number): Promise<Errand> {
	let cursor: Parameters<Tx["scanEntries"]>[2];
	do {
		const page = await tx.scanEntries({ conversationId: chat as ConversationId }, 50, cursor);
		// what the chat answers: the owner's newest message, or a routine's wake
		const input = page.items.find(
			(item) => item.model?.[0]?.role === "user" && (item.kind === "banda.inbound" || item.kind === WAKE),
		);
		if (input !== undefined) return { chat, input: Number(input.id) };
		cursor = page.next;
	} while (cursor !== undefined);
	return { chat, input: 0 };
}

/** Whether `permission` is open at `now` for an effect working on `errand`. */
export function isOpen(permission: Permission, now: number, errand?: Errand): boolean {
	if (permission.scope === "always" || permission.scope === "host") return true;
	if (permission.scope === "until") return permission.until !== undefined && now < permission.until;
	return (
		errand !== undefined &&
		permission.task !== undefined &&
		permission.task.chat === errand.chat &&
		permission.task.input === errand.input
	);
}

/**
 * Whether `permission` covers a call of `tool` with `args`: the same tool, and every bound argument exactly as permitted;
 * a host permission's host may be a pattern (`*.example.com`, `*`), which covers what the proxy lets through.
 */
export function matches(permission: Permission, tool: string, args: { readonly [key: string]: unknown }): boolean {
	return (
		permission.tool === tool &&
		Object.entries(permission.match).every(
			([key, value]) =>
				key in args &&
				(canonical(args[key]) === canonical(value) ||
					(permission.scope === "host" &&
						key === HOST_ARG &&
						typeof value === "string" &&
						typeof args[key] === "string" &&
						hostCovers(value, args[key] as string))),
		)
	);
}

/** The effect a host permission is over: sending what the proxy held. */
export const HOST_TOOL = "propose_send";
/** The argument of `propose_send` a host permission binds: the host as the proxy spells it. */
export const HOST_ARG = "_host";

/**
 * Allow agent `agent` to send anything to `typed` (a host, `*.example.com` or `*`), in a commit already open: a host
 * permission of `propose_send` like the one an approval gives, so the proxy lets that agent's writes there through,
 * WebSockets included. `wait` is the approval that gave it (0: the owner directly). Logged as the owner's. The id of the
 * permission (an equal one already given, if so), or why not.
 */
export async function allowHostIn(
	tx: Tx,
	agent: string,
	typed: string,
	now: number,
	wait: number,
): Promise<{ readonly id: string; readonly host: string } | { readonly refused: string }> {
	const host = allowedHost(typed);
	if (host === undefined)
		return {
			refused: `${JSON.stringify(typed)} is not a host: give a name like relay.example.com, *.example.com, or *`,
		};
	const doc = await tx.doc(Permissions);
	const match = { [HOST_ARG]: host };
	const same = Object.entries(doc.permissions).find(
		([, permission]) =>
			permission.scope === "host" &&
			permission.agent === agent &&
			permission.tool === HOST_TOOL &&
			canonical(permission.match) === canonical(match),
	);
	if (same !== undefined) return { id: same[0], host };
	const name = await agentWords(tx, agent);
	const what = `${name} may send anything to ${host === "*" ? "any host" : host}`;
	const id = String(doc.next);
	doc.next += 1;
	doc.permissions[id] = { tool: HOST_TOOL, match, what, scope: "host", agent, at: now, wait };
	await log(tx, { at: now, what: `You allowed: ${what}` });
	return { id, host };
}

/**
 * The floor a draft is on: as drafted, or else as its tool stands in this commit (its definition's floor, or the owner's
 * Always ask on a write and Ask on a read), so a draft made before the owner changed a setting never runs under one.
 * Reads only.
 */
export async function floorNow(
	tx: Tx,
	draft: { readonly tool: string; readonly floor?: Floor | undefined },
): Promise<Floor | undefined> {
	return draft.floor ?? (await connectionTool(tx, draft.tool))?.floor;
}

/**
 * The open permission covering a call of `tool` with `args` from `chat`, if any: never one for a draft on the floor,
 * and a host permission only from the chats of the agent it was allowed for. Reads only.
 */
export async function covering(
	tx: Tx,
	draft: { readonly tool: string; readonly args: JsonObject; readonly floor?: Floor },
	chat: number,
	now: number,
): Promise<{ readonly id: string; readonly permission: Permission } | undefined> {
	if ((await floorNow(tx, draft)) !== undefined) return undefined;
	// a host is allowed for one agent: it covers only that agent's chats, as the proxy is told
	const agent = await agentOfChat(tx, chat);
	const { permissions } = await tx.doc(Permissions);
	const candidates = Object.entries(permissions).filter(
		([, permission]) =>
			(permission.scope !== "host" || (agent !== undefined && permission.agent === agent)) &&
			matches(permission, draft.tool, draft.args),
	);
	if (candidates.length === 0) return undefined;
	const errand = candidates.some(([, permission]) => permission.scope === "task")
		? await errandOf(tx, chat)
		: undefined;
	const found = candidates.find(([, permission]) => isOpen(permission, now, errand));
	return found === undefined ? undefined : { id: found[0], permission: found[1] };
}

/**
 * The scopes an ask may offer, in order: the task's first, the primary choice; a host's last, only with a host shape.
 * "This once" is no scope, always offered.
 */
export const SCOPE_KINDS: readonly ScopeKind[] = ["task", "hour", "today", "always", "host"];

/** How long each scope lasts, as the end of a sentence. */
const LASTS: { readonly [kind in ScopeKind]: string } = {
	task: "until this task is done",
	hour: "for the next hour",
	today: "until midnight",
	always: "until you take it back in Permissions",
	// said plainly: the agent is bound by its chats' proxy logins, which another agent in the same box can read
	host:
		"from any of its chats, until you take it back in Permissions; " +
		"while your agents share one computer, any of them could use it",
};

/** What a permission of `kind` for effects `what` lets happen: "Send messages to ana without asking until …". */
export function scopeWords(what: string, kind: ScopeKind): string {
	return `${what.charAt(0).toUpperCase()}${what.slice(1)} without asking ${LASTS[kind]}`;
}

/**
 * What decides the scopes an approval offers: its floor, its shape (and its host shape), and a restart.
 */
export type Offering = {
	readonly floor?: Floor | undefined;
	readonly permission?: PermissionShape | undefined;
	/** What a permission for anything sent to the draft's host would cover: a held request's alone. */
	readonly host?: (PermissionShape & { readonly host: string }) | undefined;
	readonly interrupted?: boolean | undefined;
};

/**
 * The scopes an approval offers, in order, each in words: none on the floor, none without a shape, none for a run a
 * restart interrupted (it runs again once, as it was); the host's only with a host shape.
 */
export function offeredScopes(ask: Offering): OfferedScope[] {
	if (ask.floor !== undefined || ask.permission === undefined || ask.interrupted === true) return [];
	const { what } = ask.permission;
	const host =
		ask.host === undefined
			? []
			: [{ scope: "host" as const, words: scopeWords(ask.host.what, "host"), host: ask.host.host }];
	const lasts = ask.permission.lasts;
	return [
		...SCOPE_KINDS.filter((scope) => scope !== "host" && (lasts === undefined || lasts.includes(scope))).map(
			(scope) => ({ scope, words: scopeWords(what, scope) }),
		),
		...host,
	];
}

/** The shape a permission of `scope` binds for an ask: its host shape for a host's, else its own. */
export const shapeFor = (scope: PermissionScope, ask: Offering): PermissionShape | undefined =>
	scope.scope === "host"
		? ask.host === undefined
			? undefined
			: { match: ask.host.match, what: ask.host.what }
		: ask.permission;

/** The offered scopes that `scope`, as an answer gives it, may be: a window is an hour's or today's. */
export const kindsOf = (scope: PermissionScope): readonly ScopeKind[] =>
	scope.scope === "until" ? ["hour", "today"] : [scope.scope];

/**
 * Why `scope` cannot be given now for a draft with `shape` (none on the floor), or undefined when it can; with
 * `offered`, a scope the ask did not offer is refused.
 */
export function refusal(
	scope: PermissionScope,
	shape: PermissionShape | undefined,
	floor: Floor | undefined,
	now: number,
	offered?: readonly OfferedScope[],
) {
	if (floor !== undefined) return `this is never allowed ahead: it asks every time, as ${FLOOR_WORDS[floor]}`;
	if (shape === undefined) return "this cannot be allowed ahead";
	if (offered !== undefined && !offered.some((one) => kindsOf(scope).includes(one.scope)))
		return offered.length > 0 ? "that was not offered" : "this cannot be allowed ahead";
	if (scope.scope === "until") {
		if (!Number.isSafeInteger(scope.until) || scope.until <= now) return "a permission's time is in the future";
		if (scope.until - now > MAX_WINDOW_MS) return "a permission's time is within a week; for longer, allow it always";
	}
	return undefined;
}

/**
 * Store a permission for `tool` with `shape`, given by approval `wait` from `chat` working on `errand` (read before
 * the commit's first write), in the commit of the approval; and prune permissions whose window closed. Its id.
 */
export async function give(
	tx: Tx,
	{
		tool,
		shape,
		scope,
		wait,
		errand,
		agent,
		now,
	}: {
		tool: string;
		shape: PermissionShape;
		scope: PermissionScope;
		wait: number;
		errand: Errand;
		/** The agent of the chat it is given in (`agentOfChat`, read before the commit's first write). */
		agent: string | undefined;
		now: number;
	},
): Promise<string> {
	const doc = await tx.doc(Permissions);
	for (const [id, permission] of Object.entries(doc.permissions))
		if (permission.scope === "until" && !isOpen(permission, now)) delete doc.permissions[id];
	const id = String(doc.next);
	doc.next += 1;
	doc.permissions[id] = {
		tool,
		match: JSON.parse(JSON.stringify(shape.match)) as JsonObject,
		what: shape.what,
		scope: scope.scope,
		...(scope.scope === "until" ? { until: scope.until } : {}),
		...(scope.scope === "task" ? { task: { ...errand } } : {}),
		...(errand.input === 0 ? {} : { from: { ...errand } }),
		...(agent === undefined ? {} : { agent }),
		at: now,
		wait,
	};
	// a host's words name the agent it is for: "Ledger may send anything to github.com"
	const said =
		scope.scope === "host"
			? `You said ${shape.what}, ${permissionWhen(scope)}`
			: `You allowed ${shape.what}, ${permissionWhen(scope)}`;
	await log(tx, { at: now, what: said });
	return id;
}

/** For how long, in the daemon's words: the time in its own zone, which is the owner's machine's. */
const permissionWhen = (scope: PermissionScope) =>
	scope.scope === "always" || scope.scope === "host"
		? "always"
		: scope.scope === "task"
			? "for this task"
			: `until ${new Date(scope.until).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;

/** Call `listener` whenever the permissions, or the agent a chat runs, change (and at the start); the stop. */
export async function onPermissions(
	harness: Harness,
	listener: () => Promise<void>,
	ctx: Context = context,
): Promise<() => Promise<void>> {
	// what a host permission covers changes with either: the permissions, and which agent each chat runs
	await harness.commit(async (tx) => {
		await tx.doc(Permissions);
		await tx.doc(AgentChats);
	}, ctx);
	const watches = [await harness.watchDoc(Permissions, ctx), await harness.watchDoc(AgentChats, ctx)];
	for (const watch of watches) watch?.start(listener);
	return async () => {
		for (const watch of watches) await watch?.stop();
	};
}

/** Revoke permission `id` as the owner: it covers nothing from this commit on. False when there is no such permission. */
export async function revoke(harness: Harness, id: string, now: number, ctx: Context = context): Promise<boolean> {
	return harness.commit(async (tx) => {
		const doc = await tx.doc(Permissions);
		const permission = doc.permissions[id];
		if (permission === undefined) return false;
		delete doc.permissions[id];
		await log(tx, { at: now, what: `You took back: ${permission.what}` });
		return true;
	}, ctx);
}

/**
 * An approval as its Wait asks it, in `chat`: the task it is for (so related asks of one task show together), and the
 * scopes it offers, in words. Reads only.
 */
export async function offering<A extends Offering & { readonly floor?: Floor }>(
	tx: Tx,
	chat: number,
	ask: A,
): Promise<A & { readonly errand: Errand; readonly scopes: OfferedScope[] }> {
	const errand = await errandOf(tx, chat);
	// a host is allowed for the agent asking, by name: "Ledger may send anything to github.com"; a chat with no
	// agent recorded is offered no host, which would cover nothing
	let host = ask.host;
	if (host !== undefined) {
		const name = await agentName(tx, chat);
		host = name === undefined ? undefined : { ...host, what: `${name} may ${host.what}` };
	}
	const { host: _asked, ...rest } = ask;
	const shown = { ...rest, ...(host === undefined ? {} : { host }) } as A;
	return { ...shown, errand, scopes: offeredScopes(shown) };
}

/** What the task `errand` is, from the input it answers: a routine's wake names the routine. Reads only. */
export async function servesOf(tx: Tx, errand: Errand): Promise<Serves | undefined> {
	if (errand.input === 0) return undefined;
	const entry = await tx.entry(errand.input as EntryId);
	if (entry === undefined) return undefined;
	if (entry.kind === WAKE) {
		const wake = entry.data as unknown as WakeData;
		return { kind: "routine", routine: wake.routine, title: wake.description || wake.routine };
	}
	const content = entry.model?.[0]?.content;
	const said =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.map((part) => (part.type === "text" ? part.text : "")).join(" ")
				: "";
	const line = said.replace(/\s+/g, " ").trim();
	return {
		kind: "task",
		chat: errand.chat,
		input: errand.input,
		title: line === "" ? "A task" : line.length > 60 ? `${line.slice(0, 59)}…` : line,
	};
}

/** The open permissions, oldest first, with what each serves; those for a task only while their task goes on. */
export async function openPermissions(
	harness: Harness,
	now: number,
	ctx: Context = context,
): Promise<{ readonly id: string; readonly permission: Permission; readonly serves?: Serves }[]> {
	return harness.commit(async (tx) => {
		const { permissions } = await tx.doc(Permissions);
		const open = [];
		const errands = new Map<number, Errand>();
		for (const [id, permission] of Object.entries(permissions)) {
			let errand: Errand | undefined;
			if (permission.task !== undefined) {
				errand = errands.get(permission.task.chat) ?? (await errandOf(tx, permission.task.chat));
				errands.set(permission.task.chat, errand);
			}
			if (!isOpen(permission, now, errand)) continue;
			const from = permission.task ?? permission.from;
			const serves = from === undefined ? undefined : await servesOf(tx, from);
			open.push({
				id,
				permission: JSON.parse(JSON.stringify(permission)) as Permission,
				...(serves === undefined ? {} : { serves }),
			});
		}
		return open.sort((a, b) => Number(a.id) - Number(b.id));
	}, ctx);
}
