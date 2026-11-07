/**
 * Following an object (DESIGN.md "Watches"): how a reading of it is compared with the one before, and which of the
 * differences wake the agent, which only tell the chat, and which are nothing. A connection declares it in the object
 * kind's `follow`, beside the read that fetches it, the fields its card shows and the writes that act on it: data the
 * daemon interprets here, never code. Every function is pure: a reading is JSON, a change is the difference itself (so
 * a read repeated after a crash yields the same changes, with the same ids), and a rule says each change in words from
 * the reading's fields, never the model's.
 */
import { parseEvery } from "./schedule.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Item = { [key: string]: Json };

/** Where a value is: an object's key, or a list's item by its key (a check run's name may hold dots and slashes). */
export type Segment = string | { readonly item: string };
export type Path = readonly Segment[];

/** A pattern over paths: `checks.check_runs[*].conclusion`, where `[*]` is any item. */
type Pattern = readonly string[];
const pattern = (text: string): Pattern => [...text.matchAll(/\[\*\]|[^.[\]]+/g)].map((match) => match[0]);
const matches = (p: Pattern, path: Path, prefix = false) =>
	(prefix ? path.length >= p.length : path.length === p.length) &&
	p.every((token, i) => (token === "[*]" ? typeof path[i] === "object" : path[i] === token));

/** One difference between two readings. */
export type Change = {
	/** The change itself: the same after a crash, so a wake for it is keyed by it. */
	readonly id: string;
	readonly path: Path;
	readonly kind: "added" | "removed" | "changed";
	readonly from?: Json;
	readonly to?: Json;
	/** The list item the change is in or is, as it is now (or was, removed): whose it is, what it is. */
	readonly item?: Item;
};

/** A rule over changes: which it is about, what it does, and how it is said. First match wins. */
export type Rule = {
	/** The path it is about, as a pattern: `reviews[*]`, `pr.merged`, `derived.checks_green`. */
	readonly on: string;
	readonly kind?: Change["kind"];
	/** Only a change to this value. */
	readonly to?: Json;
	readonly does: "wake" | "tell" | "nothing";
	/**
	 * The change in words, from the item's fields and the values (`{user.login} {state}`, `{to}`); a value a `words`
	 * entry names is said as that entry says.
	 */
	readonly says: string;
	readonly words?: { readonly [value: string]: string };
};

/** How an object kind is followed, as its `follow` declares it. */
export type Follow = {
	/** The lists' key fields, by pattern: `id` unless said (check runs by `name`: every push gives them new ids). */
	readonly keys?: { readonly [list: string]: string };
	/** A list that may be one page of more: the field with its full count. Short, no item of it counts as gone. */
	readonly totals?: { readonly [list: string]: string };
	/** Paths (and all below them) that change without anything happening. */
	readonly ignore?: readonly string[];
	/** Who wrote an item of a list, by the list's pattern: the account's own are nothing, a bot's only tell. */
	readonly authors?: { readonly [list: string]: string };
	/** Named conditions over the reading: when one flips, that is a change of its own (`derived.<name>`). */
	readonly derived?: { readonly [name: string]: string };
	readonly rules: readonly Rule[];
	/** What a change no rule matches does: nothing unless said. */
	readonly otherwise?: Rule["does"];
	/** What ends a watch, by the word the watch says (`until: merged`); without one, any of them. */
	readonly ends: { readonly [name: string]: string };
	/** While it holds, the daemon looks every `busy_every` instead of `every`. */
	readonly busy?: string;
	/** How often the daemon looks, as a period (`30m`); and while busy (`2m`). */
	readonly every?: string;
	readonly busy_every?: string;
};

/** How often a followed object is looked at unless its kind says: quiet, and while it is busy. */
export const EVERY = 30 * 60_000;
export const BUSY_EVERY = 2 * 60_000;

export const canonical = (value: Json | undefined): string =>
	value === undefined
		? "∅"
		: Array.isArray(value)
			? `[${value.map(canonical).join(",")}]`
			: value !== null && typeof value === "object"
				? `{${Object.keys(value)
						.sort()
						.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
						.join(",")}}`
				: JSON.stringify(value);

const object = (value: Json | undefined): value is Item =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** The changes from `before` to `after`, as `follow` says lists are keyed and what is noise. */
export function observe(
	follow: Pick<Follow, "keys" | "ignore">,
	before: Json | undefined,
	after: Json | undefined,
	path: Path = [],
): Change[] {
	if ((follow.ignore ?? []).some((each) => matches(pattern(each), path, true))) return [];
	if (canonical(before) === canonical(after)) return [];
	if (object(before) && object(after))
		return [...new Set([...Object.keys(before), ...Object.keys(after)])]
			.sort()
			.flatMap((key) => observe(follow, before[key], after[key], [...path, key]));
	const list = Object.keys(follow.keys ?? {}).find((each) => matches(pattern(each), path));
	const field = list === undefined ? "id" : (follow.keys?.[list] ?? "id");
	const byKey = (value: Json | undefined) =>
		Array.isArray(value) && value.every((each) => object(each) && ["string", "number"].includes(typeof each[field]))
			? new Map((value as Item[]).map((each) => [String(each[field]), each]))
			: undefined;
	const was = byKey(before);
	const now = byKey(after);
	if (was !== undefined && now !== undefined) {
		const changes: Change[] = [];
		for (const [key, item] of now) {
			const at = [...path, { item: key }];
			const prior = was.get(key);
			if (prior === undefined)
				changes.push({ id: `${JSON.stringify(at)}+${canonical(item)}`, path: at, kind: "added", to: item, item });
			else changes.push(...observe(follow, prior, item, at).map((change) => ({ item, ...change })));
		}
		for (const [key, item] of was)
			if (!now.has(key)) {
				const at = [...path, { item: key }];
				changes.push({ id: `${JSON.stringify(at)}-`, path: at, kind: "removed", from: item, item });
			}
		return changes;
	}
	return [
		{
			id: `${JSON.stringify(path)}=${canonical(after)}`,
			path,
			kind: "changed",
			...(before === undefined ? {} : { from: before }),
			...(after === undefined ? {} : { to: after }),
		},
	];
}

/** Every value at a pattern: `[*]` stands for each item of a list. */
function valuesAt(value: Json | undefined, p: Pattern): Json[] {
	if (value === undefined) return [];
	const [head, ...rest] = p;
	if (head === undefined) return [value];
	if (head === "[*]") return Array.isArray(value) ? value.flatMap((each) => valuesAt(each, rest)) : [];
	return object(value) ? valuesAt(value[head], rest) : [];
}

/**
 * A condition: terms joined by ` or `, each `path = value` or `path != value` (a JSON value, else plain words), which
 * holds when any value at the path matches, or, written `all path …`, when every one does and there is one at least.
 */
type Term = { readonly all: boolean; readonly path: Pattern; readonly equal: boolean; readonly value: Json };
export function parseCondition(text: string): readonly Term[] | { readonly error: string } {
	const terms = text.split(/\s+or\s+/).map((term) => /^(all\s+)?([\w.[\]*-]+)\s*(!=|=)\s*(.+)$/.exec(term.trim()));
	if (terms.some((term) => term === null)) return { error: `"${text}" is not a condition: write it as state = closed` };
	return terms.map((term) => {
		const [, all, path = "", op, raw = ""] = term as RegExpExecArray;
		let value: Json;
		try {
			value = JSON.parse(raw) as Json;
		} catch {
			value = raw.trim();
		}
		return { all: all !== undefined, path: pattern(path), equal: op === "=", value };
	});
}

/** Whether a condition holds over a reading; a condition that does not parse never does. */
export function holds(text: string, reading: Json): boolean {
	const terms = parseCondition(text);
	if ("error" in terms) return false;
	return terms.some((term) => {
		const values = valuesAt(reading, term.path);
		const ok = (value: Json) => (canonical(value) === canonical(term.value)) === term.equal;
		return term.all ? values.length > 0 && values.every(ok) : values.some(ok);
	});
}

/** A reading: what each read answered under its name, and the derived conditions beside, so a flip of one is a change. */
export function reading(follow: Pick<Follow, "derived">, answers: Item): Item {
	const derived = Object.entries(follow.derived ?? {});
	if (derived.length === 0) return answers;
	return { ...answers, derived: Object.fromEntries(derived.map(([name, text]) => [name, holds(text, answers)])) };
}

/** Which of `follow`'s ends holds over `after`: the one `until` names, or any; its name, or undefined. */
export function endedBy(follow: Pick<Follow, "ends">, until: string | undefined, after: Json): string | undefined {
	for (const [name, condition] of Object.entries(follow.ends))
		if ((until === undefined || until === name) && holds(condition, after)) return name;
	return undefined;
}

/** How long until the next look, as the kind says and whether the object is busy. */
export function lookEvery(follow: Pick<Follow, "busy" | "every" | "busy_every">, after: Json): number {
	const busy = follow.busy !== undefined && holds(follow.busy, after);
	const period = busy ? follow.busy_every : follow.every;
	const ms = period === undefined ? undefined : parseEvery(period);
	return ms ?? (busy ? BUSY_EVERY : EVERY);
}

/** A list's items gone from a short page are not gone: only a complete list can say one was removed. */
function complete(follow: Follow, after: Json, change: Change): boolean {
	if (change.kind !== "removed") return true;
	const list = change.path.slice(0, -1);
	const entry = Object.entries(follow.totals ?? {}).find(([each]) => matches(pattern(each), list));
	if (entry === undefined) return true;
	const [total] = valuesAt(after, pattern(entry[1]));
	const [items] = valuesAt(
		after,
		list.map((segment) => (typeof segment === "string" ? segment : "[*]")),
	);
	return !(typeof total === "number" && Array.isArray(items) && items.length < total);
}

/** A change, and what it does: as a rule said, or by whose it is. */
export type Sorted = { readonly change: Change; readonly does: Rule["does"]; readonly says: string };

/** How much of a value a change's words quote. */
const QUOTED = 200;
const quote = (value: Json | undefined) => {
	if (typeof value === "string") return value;
	const text = value === undefined ? "nothing" : JSON.stringify(value);
	return text.length > QUOTED ? `${text.slice(0, QUOTED)}…` : text;
};

const pathText = (path: Path) =>
	path
		.map((segment, i) => (typeof segment === "string" ? `${i === 0 ? "" : "."}${segment}` : `[${segment.item}]`))
		.join("");

/** A change in plain words when no rule says it: `new reviews[12]`, `pr.state: open → closed`. */
export function changeWords(change: Change): string {
	const at = pathText(change.path);
	if (change.kind === "added") return plainWords(`new ${at}`);
	if (change.kind === "removed") return plainWords(`gone ${at}`);
	return plainWords(`${at}: ${quote(change.from)} → ${quote(change.to)}`);
}

/** The value at a dotted path of `value`. */
const at = (value: Json | undefined, path: string): Json | undefined =>
	path.split(".").reduce<Json | undefined>((v, part) => (object(v) ? v[part] : undefined), value);

/** The most characters a change's words may have, whatever the service put in a value. */
export const SAID = 200;

/**
 * A change's words as one plain line: what the service put in a value is foreign, so no control or invisible
 * characters reach the chat's line or the model's input, one space for each run of spaces, bounded.
 */
export function plainWords(text: string, max = SAID): string {
	const visible = text
		.normalize("NFKC")
		.replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, "")
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = [...visible];
	return characters.length <= max ? visible : `${characters.slice(0, max - 1).join("")}…`;
}

/** A rule's words for a change: each `{path}` from the item (or `{to}`, `{from}`), said as `words` say, plain. */
export function saysOf(rule: Pick<Rule, "says" | "words">, change: Change): string {
	const scope: Item = { ...(change.item ?? {}), ...(change.to === undefined ? {} : { to: change.to }) };
	if (change.from !== undefined) scope.from = change.from;
	return plainWords(
		rule.says.replace(/\{([\w.]+)\}/g, (_, path: string) => {
			const value = at(scope, path);
			const text = value === undefined || value === null ? "" : quote(value);
			return rule.words?.[text] ?? text;
		}),
	);
}

/**
 * Each change from one reading to the next, sorted: whose it is first (the account's own are nothing, a bot's only
 * tell), then the rules, then `otherwise`; each said in words.
 */
export function sort(follow: Follow, me: string | undefined, before: Json, after: Json): Sorted[] {
	const sorted: Sorted[] = [];
	for (const change of observe(follow, before, after)) {
		if (!complete(follow, after, change)) continue;
		const list = Object.entries(follow.authors ?? {}).find(([each]) =>
			matches(pattern(each), change.path.slice(0, pattern(each).length)),
		);
		const author = list === undefined ? undefined : valuesAt(change.item, pattern(list[1]))[0];
		if (me !== undefined && author === me) {
			sorted.push({ change, does: "nothing", says: changeWords(change) });
			continue;
		}
		const rule = follow.rules.find(
			(each) =>
				matches(pattern(each.on), change.path) &&
				(each.kind === undefined || each.kind === change.kind) &&
				(each.to === undefined || canonical(each.to) === canonical(change.to)),
		);
		const says = rule === undefined ? changeWords(change) : saysOf(rule, change);
		const does = rule?.does ?? follow.otherwise ?? "nothing";
		const bot = typeof author === "string" && author.endsWith("[bot]");
		sorted.push({ change, does: bot && does === "wake" ? "tell" : does, says });
	}
	return sorted;
}

const DOES = new Set(["wake", "tell", "nothing"]);
const KINDS = new Set(["added", "removed", "changed"]);
const FIELDS = [
	"keys",
	"totals",
	"ignore",
	"authors",
	"derived",
	"rules",
	"otherwise",
	"ends",
	"busy",
	"every",
	"busy_every",
];
const stringMap = (value: unknown) =>
	object(value as Json) && Object.values(value as object).every((each) => typeof each === "string");
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** An object kind's `follow`, or why it is not one. `where` names the kind in each problem. */
export function parseFollow(value: unknown, where: string): { follow: Follow } | { errors: string[] } {
	const errors: string[] = [];
	const problem = (what: string) => errors.push(`${where}.follow: ${what}`);
	if (!object(value as Json)) return { errors: [`${where}.follow is {"rules", "ends", …}`] };
	const follow = value as { [key: string]: unknown };
	for (const key of Object.keys(follow)) if (!FIELDS.includes(key)) problem(`"${key}" is not a field`);
	for (const key of ["keys", "totals", "authors", "derived", "ends"] as const)
		if (follow[key] !== undefined && !stringMap(follow[key])) problem(`"${key}" is {"pattern": "path"}`);
	if (
		follow.ignore !== undefined &&
		!(Array.isArray(follow.ignore) && follow.ignore.every((each) => typeof each === "string"))
	)
		problem(`"ignore" is a list of paths`);
	if (!Array.isArray(follow.rules)) problem(`"rules" is a list`);
	else
		for (const rule of follow.rules as unknown[]) {
			const r = rule as Partial<Rule> | null;
			if (
				!object(r as Json) ||
				typeof r?.on !== "string" ||
				!DOES.has(r.does as string) ||
				typeof r.says !== "string" ||
				r.says.length > 200 ||
				(r.kind !== undefined && !KINDS.has(r.kind)) ||
				(r.words !== undefined && !stringMap(r.words))
			)
				problem(`a rule is {"on": "path", "kind"?, "to"?, "does": "wake" | "tell" | "nothing", "says", "words"?}`);
		}
	if (follow.otherwise !== undefined && !DOES.has(follow.otherwise as string))
		problem(`"otherwise" is wake, tell or nothing`);
	const ends = stringMap(follow.ends) ? (follow.ends as { [name: string]: string }) : {};
	if (Object.keys(ends).length === 0) problem(`"ends" names what ends a watch: {"merged": "pr.merged = true"}`);
	for (const name of Object.keys(ends)) if (!NAME.test(name)) problem(`"${name}" is not a word for an end`);
	const conditions = [
		...Object.values(ends),
		...Object.values(stringMap(follow.derived) ? (follow.derived as { [name: string]: string }) : {}),
	];
	if (typeof follow.busy === "string") conditions.push(follow.busy);
	for (const text of conditions) {
		const parsed = parseCondition(text);
		if ("error" in parsed) problem(parsed.error);
	}
	for (const key of ["every", "busy_every"] as const)
		if (follow[key] !== undefined && (typeof follow[key] !== "string" || parseEvery(follow[key]) === undefined))
			problem(`"${key}" is a period, such as 30m`);
	if (errors.length > 0) return { errors };
	const f = follow as Follow;
	return {
		follow: {
			...(f.keys === undefined ? {} : { keys: f.keys }),
			...(f.totals === undefined ? {} : { totals: f.totals }),
			...(f.ignore === undefined ? {} : { ignore: f.ignore }),
			...(f.authors === undefined ? {} : { authors: f.authors }),
			...(f.derived === undefined ? {} : { derived: f.derived }),
			rules: f.rules,
			...(f.otherwise === undefined ? {} : { otherwise: f.otherwise }),
			ends,
			...(f.busy === undefined ? {} : { busy: f.busy }),
			...(f.every === undefined ? {} : { every: f.every }),
			...(f.busy_every === undefined ? {} : { busy_every: f.busy_every }),
		},
	};
}
