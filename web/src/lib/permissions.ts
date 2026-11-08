/**
 * Permissions in words (DESIGN.md "Messages"): for how long the owner allowed something, as the app says it; the
 * scopes an approval offers as buttons (the daemon chose them, the app only draws them); which open asks show as one
 * card; and the standing permissions grouped by what they serve. Pure: no DOM, so it is unit-tested.
 */
import type { Ask, OfferedScope, PermissionScope, PermissionView, ScopeKind, Serves } from "../../../src/server/api.ts";

/** A time a permission lasts until: "18:00" today, "tomorrow 09:00", "Fri 18:00", else the date. */
export function untilWords(at: number, now = Date.now()): string {
	const then = new Date(at);
	const time = then.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const days = Math.round((day(then) - day(new Date(now))) / 86_400_000);
	if (days === 0) return time;
	if (days === 1) return `tomorrow ${time}`;
	if (days < 7) return `${then.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
	return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** For how long, as a clause: "for this task", "until 18:00", "always". */
export function permissionWhen(
	permission: { readonly scope: PermissionScope["scope"]; readonly until?: number },
	now = Date.now(),
) {
	if (permission.scope === "always" || permission.scope === "host" || permission.scope === "place") return "always";
	if (permission.scope === "task") return "for this task";
	return `until ${untilWords(permission.until ?? now, now)}`;
}

/** How long a standing permission lasts, as the end of a sentence: "until this task is done", "until 18:00". */
export function lastsWords(
	permission: { readonly scope: PermissionScope["scope"]; readonly until?: number },
	now = Date.now(),
) {
	if (permission.scope === "always" || permission.scope === "place") return "until you take it back";
	if (permission.scope === "host")
		return "from any of its chats, until you take it back; while your agents share one computer, any of them could use it";
	if (permission.scope === "task") return "until this task is done";
	return `until ${untilWords(permission.until ?? now, now)}`;
}

/** The end of the owner's day, local time: when "today" ends. */
export function endOfToday(now = Date.now()): number {
	const date = new Date(now);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime();
}

/** Each scope's button. "This once" is no scope: every approval offers it. */
export const SCOPE_BUTTONS: { readonly [kind in ScopeKind]: string } = {
	place: "Always allow here",
	task: "Allow for this task",
	hour: "Allow for an hour",
	today: "Allow for today",
	always: "Always allow",
	host: "Always allow this host",
};

/** An offered scope's button: a host's names its host, "Always allow github.com". */
export const scopeButton = (one: OfferedScope): string =>
	one.scope === "host" && one.host !== undefined ? `Always allow ${one.host}` : SCOPE_BUTTONS[one.scope];

/** The permission an offered scope gives when the owner picks it at `now`: a window is timed from the answer. */
export function scopeOf(kind: ScopeKind, now = Date.now()): PermissionScope {
	switch (kind) {
		case "hour":
			return { scope: "until", until: now + 60 * 60_000 };
		case "today":
			return { scope: "until", until: endOfToday(now) };
		default:
			return { scope: kind };
	}
}

type Approval = Extract<Ask, { type: "approval" }>;

/** The scopes an approval offers, as the daemon gave them; none for a run again. */
export const scopesOf = (ask: Approval): readonly OfferedScope[] =>
	ask.interrupted === true ? [] : (ask.scopes ?? []);

/**
 * Open approvals, in their order, with those that ask the same tool for the same task (the lead and its helpers)
 * together, one group per card: never one on the floor or a run again, which each stand alone, as each asks every
 * time and its own words matter.
 */
export function groupApprovals<W extends { readonly ask: Ask }>(waits: readonly W[]): W[][] {
	const groups: W[][] = [];
	const byKey = new Map<string, W[]>();
	for (const wait of waits) {
		const { ask } = wait;
		const alone =
			ask.type !== "approval" ||
			ask.errand === undefined ||
			ask.floor !== undefined ||
			ask.interrupted === true ||
			scopesOf(ask).length === 0;
		if (alone) {
			groups.push([wait]);
			continue;
		}
		const key = `${ask.errand?.chat}:${ask.errand?.input}:${ask.tool}`;
		const found = byKey.get(key);
		if (found !== undefined) found.push(wait);
		else {
			const group = [wait];
			byKey.set(key, group);
			groups.push(group);
		}
	}
	return groups;
}

/** The scopes every ask of a group offers, in the first's order: what "allow all" may give; never a host, one each. */
export function sharedScopes(asks: readonly Approval[]): OfferedScope[] {
	const [first, ...rest] = asks;
	if (first === undefined) return [];
	return scopesOf(first).filter(
		(one) => one.scope !== "host" && rest.every((ask) => scopesOf(ask).some((other) => other.scope === one.scope)),
	);
}

/** A heading of Permissions: what the permissions under it serve. */
export type ServesGroup = {
	readonly key: string;
	/** "For “Book the train to Lisbon”", or "Other". */
	readonly title: string;
	/** "task", "routine", "artifact": what the title names, beside it. */
	readonly kind?: Serves["kind"];
	readonly permissions: readonly PermissionView[];
};

const servesKey = (serves: Serves | undefined) =>
	serves === undefined
		? "other"
		: serves.kind === "task"
			? `task:${serves.chat}:${serves.input}`
			: serves.kind === "routine"
				? `routine:${serves.routine}`
				: `artifact:${serves.id}`;

/** Standing permissions grouped by what they serve, tasks first, then routines, artifacts, and the rest as "Other". */
export function servesGroups(permissions: readonly PermissionView[]): ServesGroup[] {
	const groups = new Map<string, { title: string; kind?: Serves["kind"]; permissions: PermissionView[] }>();
	for (const permission of permissions) {
		const key = servesKey(permission.serves);
		const group = groups.get(key);
		if (group !== undefined) group.permissions.push(permission);
		else
			groups.set(key, {
				title: permission.serves === undefined ? "Other" : `For “${permission.serves.title}”`,
				...(permission.serves === undefined ? {} : { kind: permission.serves.kind }),
				permissions: [permission],
			});
	}
	const order = (key: string) =>
		key.startsWith("task:") ? 0 : key.startsWith("routine:") ? 1 : key.startsWith("artifact:") ? 2 : 3;
	return [...groups.entries()].sort(([a], [b]) => order(a) - order(b)).map(([key, group]) => ({ key, ...group }));
}

/** How long a permission may go unused, since it was given or last let something run, before it says so. */
export const LATELY_MS = 30 * 86_400_000;

/** When a permission last let something run: "Tue 14:02" within the week, else the date. */
function lastWords(at: number, now: number): string {
	const then = new Date(at);
	return now - at < 6 * 86_400_000
		? then.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
		: then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** What a permission let run: "Used 4 times · last Tue 14:02", "Not used yet", or, a month unused, "Not used lately". */
export function usedWords(permission: Pick<PermissionView, "at" | "ran">, now = Date.now()): string {
	const { ran } = permission;
	if (now - (ran?.last ?? permission.at) >= LATELY_MS) return "Not used lately";
	if (ran === undefined || ran.count === 0) return "Not used yet";
	return `Used ${ran.count === 1 ? "once" : `${ran.count} times`} · last ${lastWords(ran.last, now)}`;
}

const PLACEHOLDER = /\{([a-z_]{1,32})\}/g;
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * A place as the owner types it, read by its template: "purrgrammer/banda" for "{owner}/{repo}" is each placeholder's
 * value, or undefined when it does not read as one: each value as the daemon takes it, no separator or space.
 */
export function placeValues(template: string, typed: string): { [placeholder: string]: string } | undefined {
	const names: string[] = [];
	let source = "";
	let last = 0;
	for (const match of template.matchAll(PLACEHOLDER)) {
		source += `${literal(template.slice(last, match.index))}([A-Za-z0-9_][A-Za-z0-9_.-]{0,399})`;
		names.push(match[1] as string);
		last = (match.index ?? 0) + match[0].length;
	}
	source += literal(template.slice(last));
	const found = new RegExp(`^${source}$`).exec(typed.trim());
	if (found === null) return undefined;
	return Object.fromEntries(names.map((name, i) => [name, found[i + 1] as string]));
}

/** The sentence the daemon stores for a grain's permission: its words, the place filled, and the account. */
export const grainSentence = (words: string, values: { readonly [placeholder: string]: string }, account: string) =>
	`${words.replace(PLACEHOLDER, (_, name: string) => values[name] ?? "")} as ${account}`;
