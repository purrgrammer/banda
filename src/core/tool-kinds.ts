/**
 * What a connection's tool does, as the owner sets it: its kind (a read, a write, on the floor, or nobody said), who said
 * so, and the owner's setting. Plain data and rules, no store, so the app shares them. Nothing here guesses: a tool
 * neither its definition nor its own annotations say anything about is `unknown`, and it asks.
 */
import type { Floor } from "./floor.ts";

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

export type Kind = "read" | "write" | "floor" | "unknown";

/** Who said what a tool does: its connection's definition, the owner, the server's annotations, or nobody. */
export type From = "definition" | "you" | "server" | "nobody";

export type Classed = { readonly kind: Kind; readonly floor?: Floor; readonly from: From };

/** The server's own words about a tool: shown, and only ever a proposal until the owner accepts it. */
export type Hints = { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };

/** What a connection's definition says of its tools. A server the owner added says nothing: every field is empty. */
export type Said = {
	readonly reads: readonly string[];
	readonly readsWhen?: { readonly [tool: string]: unknown };
	readonly floors: { readonly [tool: string]: Floor };
	/** The tools it names, so one that is no read is a write it says it is. */
	readonly named: ReadonlySet<string>;
	/** Every tool that is not a read asks every time. */
	readonly ask?: "always";
};

/**
 * What tool `tool` does: as the definition says (a floor, then a read, then any tool it names is a write), which a
 * read the owner allowed never beats, else as the owner said, else as the server's annotations say (a read there is only proposed until the owner
 * allows it), else unknown.
 */
export function classOf(said: Said, tool: string, allowed: readonly string[], hints: Hints | undefined): Classed {
	if (Object.hasOwn(said.floors, tool)) return { kind: "floor", floor: said.floors[tool] as Floor, from: "definition" };
	if (said.reads.includes(tool) || said.readsWhen?.[tool] !== undefined) return { kind: "read", from: "definition" };
	if (said.named.has(tool))
		return said.ask === "always"
			? { kind: "floor", floor: "private", from: "definition" }
			: { kind: "write", from: "definition" };
	if (allowed.includes(tool)) return { kind: "read", from: "you" };
	if (hints?.destructiveHint === true || hints?.readOnlyHint === false) return { kind: "write", from: "server" };
	if (hints?.readOnlyHint === true) return { kind: "read", from: "server" };
	return { kind: "unknown", from: "nobody" };
}

/** What a tool of `classed` is set to until the owner sets it: a read accepted as one runs, anything else asks. */
export function defaultOf(classed: Classed, ask: Said["ask"]): Setting {
	if (classed.kind === "floor") return "always";
	if (classed.kind === "read") return classed.from === "server" ? "ask" : "allow";
	return ask === "always" ? "always" : "ask";
}

/**
 * The settings the owner may pick for a tool. A connection only narrows: nothing set on it makes a known write a read.
 * Allow on a read a server only proposed, or on a tool nobody said anything about, is the owner saying it reads. On a
 * connection that asks every time, what is not a read has no plain Ask.
 */
export function optionsOf(classed: Classed, ask: Said["ask"]): readonly Setting[] {
	if (classed.kind === "floor") return ["always", "off"];
	if (classed.kind === "read") return ["allow", "ask", "off"];
	const asks: readonly Setting[] = ask === "always" ? ["always"] : ["ask", "always"];
	return classed.kind === "write" ? [...asks, "off"] : ["allow", ...asks, "off"];
}

/**
 * What setting a group to `setting` sets one of its tools to: the setting itself where the tool has it, else the
 * nearest that narrows as much (Ask on the floor is Always ask; Always ask on a read is Ask); undefined where it has
 * nothing near (Allow on a write or the floor): that tool keeps its own.
 */
export function inGroup(setting: Setting, options: readonly Setting[]): Setting | undefined {
	if (options.includes(setting)) return setting;
	if (setting === "ask" && options.includes("always")) return "always";
	if (setting === "always" && options.includes("ask")) return "ask";
	return undefined;
}

/**
 * What a group's control sets one of its tools to, as `inGroup` says, but Allow never where it would say the tool
 * reads when nobody has: that is the owner's word on the tool alone, in the tool's own control.
 */
export function groupValue(setting: Setting, classed: Classed, options: readonly Setting[]): Setting | undefined {
	if (setting === "allow" && (classed.kind === "unknown" || classed.from === "server")) return undefined;
	return inGroup(setting, options);
}

/** Words that say what an action does rather than what it acts on, left out of a group's name. */
const VERBS = new Set(
	"get list search find fetch read query describe show view create add new make update edit set patch modify put delete remove cancel close open run start stop trigger send post write merge move copy upload download sync submit approve assign unassign mark toggle enable disable invite rename archive restore resolve reopen lock unlock star unstar fork by for of to from the a an all my me".split(
		" ",
	),
);

/** A tool's group by its name alone, when no definition said one: what it acts on ("list_issues", "issue_write": "Issues"). */
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

/** How many tools of a connection, as their rows say: Allow runs freely, Ask asks first, Always ask, Off. */
export function tally(tools: readonly { readonly setting: Setting }[]) {
	const count = { free: 0, first: 0, every: 0, off: 0 };
	for (const { setting } of tools) {
		if (setting === "off") count.off++;
		else if (setting === "always") count.every++;
		else if (setting === "allow") count.free++;
		else count.first++;
	}
	return count;
}

/** The tally in a line: "34 run freely · 20 ask first · 2 always ask". */
export function tallyWords(count: ReturnType<typeof tally>): string {
	return [
		count.free === 0 ? undefined : `${count.free} run freely`,
		count.first === 0 ? undefined : `${count.first} ask first`,
		count.every === 0 ? undefined : `${count.every} always ask`,
		count.off === 0 ? undefined : `${count.off} off`,
	]
		.filter((part) => part !== undefined)
		.join(" · ");
}
