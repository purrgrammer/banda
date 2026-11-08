/**
 * What a connection's tool does, as the owner sets it (DESIGN.md "What each tool does is said once, on adding", "A
 * connection only narrows"): its kind (a read, a write, or a write on the floor and its class), who said so, its group,
 * and the owner's setting. Plain data and rules, no store, so the app shares them.
 */
import type { FileFloor, Floor } from "./floor.ts";

/** The owner's setting of one tool: a read Allow, Ask or Off; a write Ask, Always ask or Off; the floor Always ask, Off. */
export type Setting = "allow" | "ask" | "always" | "off";
export const SETTINGS: readonly Setting[] = ["allow", "ask", "always", "off"];
export const isSetting = (value: unknown): value is Setting => SETTINGS.includes(value as Setting);

/** Each setting in the owner's words. */
export const SETTING_WORDS: { readonly [setting in Setting]: string } = {
	allow: "Allow",
	ask: "Ask",
	always: "Always ask",
	off: "Off",
};

export type Kind = "read" | "write" | "floor";

/**
 * Who said what a tool does: the connection's file banda ships, or the server's annotations ("service"); a file the
 * owner or an agent wrote and the owner accepted ("you"); banda's inference over the listing ("guess"); nobody, so it
 * is a write ("none").
 */
export type From = "service" | "you" | "guess" | "none";

export type Classed = { readonly kind: Kind; readonly floor?: Floor; readonly from: From };

/** banda's guess for a tool, from the inference: derived, rebuildable, never permission by itself. */
export type Guess = { readonly kind: "read" | "write"; readonly floor?: FileFloor; readonly group: string };

/** What the file says of a connection's tools, as `classOf` needs it. */
export type Said = {
	readonly reads: readonly string[];
	readonly readsWhen?: { readonly [tool: string]: unknown };
	readonly floors: { readonly [tool: string]: Floor };
};

/** The server's own words about a tool: shown, and only ever a proposal until the owner accepts it. */
export type Hints = { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };

/**
 * What tool `tool` does: as the accepted file says (its reads and floors; a file banda ships says every other tool is a
 * write), else as the server's annotations say (`destructiveHint` makes it at least a write), else as banda guessed,
 * else a write.
 */
export function classOf(
	file: Said,
	tool: string,
	hints: Hints | undefined,
	guess: Guess | undefined,
	shipped: boolean,
): Classed {
	const own: From = shipped ? "service" : "you";
	if (file.reads.includes(tool) || file.readsWhen?.[tool] !== undefined) return { kind: "read", from: own };
	const floor = Object.hasOwn(file.floors, tool) ? file.floors[tool] : undefined;
	if (floor !== undefined) return { kind: "floor", floor, from: own };
	if (shipped) return { kind: "write", from: "service" };
	const guessedFloor =
		guess?.floor === undefined ? undefined : ({ kind: "floor", floor: guess.floor, from: "guess" } as const);
	if (hints?.destructiveHint === true || hints?.readOnlyHint === false)
		return guessedFloor ?? { kind: "write", from: "service" };
	if (hints?.readOnlyHint === true) return { kind: "read", from: "service" };
	if (guess !== undefined) return guessedFloor ?? { kind: guess.kind, from: "guess" };
	return { kind: "write", from: "none" };
}

/** What a tool of `kind` is set to until the owner sets it: a read runs, a write asks, the floor asks every time. */
export const defaultOf = (kind: Kind): Setting => (kind === "read" ? "allow" : kind === "write" ? "ask" : "always");

/**
 * The settings the owner may pick for a tool. A connection only narrows: a file's floor stays on it, and a connection
 * banda ships says its reads, so its writes cannot be allowed. On any other, Allow on a tool that is not yet a read
 * confirms it as one (it joins the file's reads); a guess or a hint alone never does.
 */
export function optionsOf(classed: Classed, shipped: boolean): readonly Setting[] {
	if (classed.kind === "floor" && classed.from !== "guess") return ["always", "off"];
	if (classed.kind === "read") return ["allow", "ask", "off"];
	return shipped ? ["ask", "always", "off"] : ["allow", "ask", "always", "off"];
}

/**
 * What setting a group to `setting` sets one of its tools to: the setting itself where the tool has it, else the
 * nearest that narrows as much (Ask on the floor is Always ask; Always ask on a read is Ask); undefined where it has
 * nothing near (Allow on a write of a connection banda ships): that tool keeps its own.
 */
export function inGroup(setting: Setting, options: readonly Setting[]): Setting | undefined {
	if (options.includes(setting)) return setting;
	if (setting === "ask" && options.includes("always")) return "always";
	if (setting === "always" && options.includes("ask")) return "ask";
	return undefined;
}

/** Whether a tool set to `setting` asks every time (on the floor): Always ask, or Ask on a read. */
export const asksEveryTime = (setting: Setting, kind: Kind) =>
	setting === "always" || (setting === "ask" && kind === "read");

/** Words that say what an action does rather than what it acts on, left out of a group's name. */
const VERBS = new Set(
	"get list search find fetch read query describe show view create add new make update edit set patch modify put delete remove cancel close open run start stop trigger send post write merge move copy upload download sync submit approve assign unassign mark toggle enable disable invite rename archive restore resolve reopen lock unlock star unstar fork by for of to from the a an all my me".split(
		" ",
	),
);

/** A tool's group by its name alone, when nobody said one: what it acts on ("list_issues", "issue_write": "Issues"). */
export function nameGroup(tool: string): string {
	const words = tool
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word !== "");
	const kept = words.filter((word) => !VERBS.has(word));
	const subject = (kept.length > 0 ? kept : words.slice(-1)).slice(0, 2);
	if (subject.length === 0) return "Other";
	const last = subject.length - 1;
	subject[last] = (subject[last] ?? "").replace(/(ies)$/, "y").replace(/([^s])s$/, "$1");
	subject[last] = /(s|x|ch|sh)$/.test(subject[last] ?? "")
		? `${subject[last]}es`
		: /[^aeiou]y$/.test(subject[last] ?? "")
			? `${(subject[last] ?? "").slice(0, -1)}ies`
			: `${subject[last]}s`;
	const said = subject.join(" ");
	return said.charAt(0).toUpperCase() + said.slice(1);
}

/** At most this many groups on one connection, so a long listing stays a glance. */
export const MAX_GROUPS = 8;

/**
 * Every tool's group by name, at most `MAX_GROUPS`: the biggest groups as named, the rest together as "Other". Tools
 * that share no word with another go to "Other" too.
 */
export function nameGroups(tools: readonly string[]): { readonly [tool: string]: string } {
	const named = new Map(tools.map((tool) => [tool, nameGroup(tool)]));
	const sizes = new Map<string, number>();
	for (const group of named.values()) sizes.set(group, (sizes.get(group) ?? 0) + 1);
	const big = [...sizes]
		.filter(([group, size]) => size > 1 && group !== "Other")
		.sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
		.map(([group]) => group);
	const lonely = tools.some((tool) => !big.slice(0, MAX_GROUPS).includes(named.get(tool) ?? ""));
	const kept = new Set(big.slice(0, lonely ? MAX_GROUPS - 1 : MAX_GROUPS));
	return Object.fromEntries(
		tools.map((tool) => {
			const group = named.get(tool) ?? "Other";
			return [tool, kept.has(group) ? group : "Other"];
		}),
	);
}

/** How many tools of a connection, as set, run freely, ask first, ask every time, or are off. */
export function tally(tools: readonly { readonly kind: Kind; readonly setting: Setting }[]) {
	const count = { free: 0, first: 0, every: 0, off: 0 };
	for (const { kind, setting } of tools) {
		if (setting === "off") count.off++;
		else if (asksEveryTime(setting, kind)) count.every++;
		else if (setting === "allow") count.free++;
		else count.first++;
	}
	return count;
}

/** The tally in a line: "34 read and run freely · 20 change something and ask first · 2 always ask". */
export function tallyWords(count: ReturnType<typeof tally>): string {
	return [
		count.free === 0 ? undefined : `${count.free} read and run freely`,
		count.first === 0 ? undefined : `${count.first} change something and ask first`,
		count.every === 0 ? undefined : `${count.every} always ask`,
		count.off === 0 ? undefined : `${count.off} off`,
	]
		.filter((part) => part !== undefined)
		.join(" · ");
}
