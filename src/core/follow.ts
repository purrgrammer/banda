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
	/** Only a change from this value: a label gone from a set is a change from it, to nothing. */
	readonly from?: Json;
	/** Only a change whose item this condition holds over: a check run that comes already failed (`conclusion = failure`). */
	readonly where?: string;
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
	/**
	 * A list that is the newest page of more, newest first, by the field that orders it (`{"releases": "published_at"}`,
	 * a number or an ISO time): an item that leaves it was pushed off the page, never gone, and one that comes is new
	 * only when that field is past every item's in the reading before; one that slid in as another left is nothing.
	 */
	readonly newest?: { readonly [list: string]: string };
	/**
	 * A list the reading keeps a window of (a read's `pages`, never written in `follow` itself), by the field that orders
	 * it: an item older than the window's oldest that leaves it was pushed off, and one that comes back was there
	 * before; within the window, an item gone was deleted.
	 */
	readonly windows?: { readonly [list: string]: string };
	/** Paths (and all below them) that change without anything happening. */
	readonly ignore?: readonly string[];
	/**
	 * Who wrote an item of a list, by the list's pattern, or every change in an object, by the object's path (a file:
	 * who changed it last): the account's own are nothing, a bot's only tell. A list's author speaks for its items and
	 * their own fields, not for a list inside an item (a message's reactions), which has its own entry or none.
	 */
	readonly authors?: { readonly [list: string]: string };
	/**
	 * Named conditions over the reading: when one flips, that is a change of its own (`derived.<name>`). One written
	 * `{"when", "steady"}` holds only when the value at `steady` is the same as in the reading before: a list it ranges
	 * over is incomplete just after that value changed (a push's checks appear one by one).
	 */
	readonly derived?: { readonly [name: string]: Derived };
	readonly rules: readonly Rule[];
	/** What a change no rule matches does: nothing unless said. */
	readonly otherwise?: Rule["does"];
	/**
	 * What ends a watch, by the word the watch says (`until: merged`); without one, any of them. None (`{}`): nothing
	 * ends it (a contact, a search, a repository), and it follows until the owner stops it.
	 */
	readonly ends: { readonly [name: string]: string };
	/** While it holds, the daemon looks every `busy_every` instead of `every`. */
	readonly busy?: string;
	/** How often the daemon looks, as a period (`30m`); and while busy (`2m`). */
	readonly every?: string;
	readonly busy_every?: string;
	/** How long after a change what changes next still joins its wake, as a period (`1m`); none, it wakes at once. */
	readonly settle?: string;
};

/** A derived condition: its words, or its words and the path it must be steady over. */
export type Derived = string | { readonly when: string; readonly steady: string };
const whenOf = (derived: Derived) => (typeof derived === "string" ? derived : derived.when);

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
	// a list the service leaves out when empty (a comment's replies) is empty; a read's whole answer missing (one that
	// failed) is not, so its items never come back as new
	const inside = path.length > 1;
	const was = byKey(before === undefined && inside && Array.isArray(after) ? [] : before);
	const now = byKey(after === undefined && inside && Array.isArray(before) ? [] : after);
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
	// a list of plain values (an issue's labels, its assignees) is a set: each value added or gone is a change of its
	// own, and a list the service leaves out when empty is empty
	const values = (value: Json | undefined) =>
		value === undefined
			? []
			: Array.isArray(value) && value.every((each) => typeof each === "string" || typeof each === "number")
				? (value as (string | number)[])
				: undefined;
	const had = values(before);
	const has = values(after);
	if (had !== undefined && has !== undefined && (Array.isArray(before) || Array.isArray(after))) {
		const changes: Change[] = [];
		for (const value of new Set(has))
			if (!had.includes(value)) {
				const at = [...path, { item: String(value) }];
				changes.push({ id: `${JSON.stringify(at)}+`, path: at, kind: "added", to: value });
			}
		for (const value of new Set(had))
			if (!has.includes(value)) {
				const at = [...path, { item: String(value) }];
				changes.push({ id: `${JSON.stringify(at)}-`, path: at, kind: "removed", from: value });
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

/**
 * Every value at a pattern: `[*]` stands for each item of a list. An item of a list that lacks the field is a value
 * of its own, `undefined`, so `all` counts it: a check run still going has no conclusion (GitHub's server leaves the
 * field out), and "all checks green" must not hold until it has one.
 */
function valuesAt(value: Json | undefined, p: Pattern, item = false): (Json | undefined)[] {
	const [head, ...rest] = p;
	if (head === undefined) return value === undefined && !item ? [] : [value];
	if (head === "[*]") return Array.isArray(value) ? value.flatMap((each) => valuesAt(each, rest, true)) : [];
	return object(value) ? valuesAt(value[head], rest, item) : item ? [undefined] : [];
}

/**
 * A condition: terms joined by ` or `, each `path = value` or `path != value` (a JSON value, else plain words), which
 * holds when any value at the path matches, or, written `all path …`, when every one does and there is one at least.
 * `null` is no value: `path = null` holds where the path has none, left out or null (a comment whose author the service
 * does not name).
 */
/** One `path = value` of a condition; its values are alternatives, any of which is the value. */
type Term = {
	readonly all: boolean;
	readonly path: Pattern;
	readonly equal: boolean;
	readonly values: readonly Json[];
};
export function parseCondition(text: string): readonly Term[] | { readonly error: string } {
	const terms = text.split(/\s+or\s+/).map((term) => /^(all\s+)?([\w.[\]*-]+)\s*(!=|=)\s*(.+)$/.exec(term.trim()));
	if (terms.some((term) => term === null)) return { error: `"${text}" is not a condition: write it as state = closed` };
	return terms.map((term) => {
		const [, all, path = "", op, raw = ""] = term as RegExpExecArray;
		// `a|b|c` is any of them: GitHub counts a skipped or neutral check as passing
		const values = raw.split("|").map((each): Json => {
			try {
				return JSON.parse(each) as Json;
			} catch {
				return each.trim();
			}
		});
		return { all: all !== undefined, path: pattern(path), equal: op === "=", values };
	});
}

/** Whether a condition holds over a reading; a condition that does not parse never does. */
export function holds(text: string, reading: Json): boolean {
	const terms = parseCondition(text);
	if ("error" in terms) return false;
	return terms.some((term) => {
		const values = valuesAt(reading, term.path);
		// a value that is not there equals null alone: "= x" fails on it, "!= x" holds, "= null" holds
		const none = term.values.some((each) => each === null);
		const ok = (value: Json | undefined) =>
			(value === undefined ? none : term.values.some((each) => canonical(value) === canonical(each))) === term.equal;
		if (!term.all && values.length === 0) return term.equal && none;
		return term.all ? values.length > 0 && values.every(ok) : values.some(ok);
	});
}

/**
 * A reading: what each read answered under its name, and the derived conditions beside, so a flip of one is a change.
 * `before` is the reading it follows: a condition steady over a path that changed since does not hold yet, and is
 * kept so, so it flips once the path has stayed.
 */
export function reading(follow: Pick<Follow, "derived">, answers: Item, before?: Item): Item {
	const derived = Object.entries(follow.derived ?? {});
	if (derived.length === 0) return answers;
	return {
		...answers,
		derived: Object.fromEntries(
			derived.map(([name, each]) => [name, holds(whenOf(each), answers) && steady(each, answers, before)]),
		),
	};
}

/** Whether a derived condition's steady path is the same in `answers` as in `before` (none before: it is). */
function steady(derived: Derived, answers: Item, before: Item | undefined): boolean {
	if (typeof derived === "string" || before === undefined) return true;
	const path = pattern(derived.steady);
	const at = (item: Item) => canonical(valuesAt(item, path).map((value) => value ?? null));
	return at(answers) === at(before);
}

/**
 * `answers` with the last answer (`before`) of each read in `unanswered`: a read that may fail and did says nothing about
 * what it reads, so its last answer stands. Not for a condition whose steady path moved: that answer is about what the
 * path no longer names (a push's checks are not the last commit's), and left out it counts as nothing yet.
 */
export function withLastAnswers(
	follow: Pick<Follow, "derived">,
	answers: Item,
	before: Item,
	unanswered: readonly string[],
): Item {
	const outdated = new Set(
		Object.values(follow.derived ?? {}).flatMap((each) => {
			if (steady(each, answers, before)) return [];
			const terms = parseCondition(whenOf(each));
			return "error" in terms ? [] : terms.map((term) => term.path[0]);
		}),
	);
	const looked = { ...answers };
	for (const as of unanswered) {
		const last = before[as];
		if (last !== undefined && !outdated.has(as)) looked[as] = last;
	}
	return looked;
}

/** Whether a derived condition holds over `answers` but is held back because its steady path just changed. */
export function heldBack(follow: Pick<Follow, "derived">, answers: Item, before?: Item): boolean {
	return Object.values(follow.derived ?? {}).some(
		(each) => holds(whenOf(each), answers) && !steady(each, answers, before),
	);
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

/** How long a change waits for others to join its wake, as the kind says: none unless said. */
export function settleOf(follow: Pick<Follow, "settle">): number {
	return follow.settle === undefined ? 0 : (parseEvery(follow.settle) ?? 0);
}

/** The object at a path of plain keys, or undefined: a list's item, or anything not an object, is none. */
function objectAt(value: Json | undefined, path: Path): Item | undefined {
	let here = value;
	for (const segment of path) {
		if (typeof segment !== "string" || !object(here)) return undefined;
		here = here[segment];
	}
	return object(here) ? here : undefined;
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

/** The `newest` field of the list `path` is an item of, or undefined when it is not such a list. */
function newestField(follow: Pick<Follow, "newest">, path: Path): string | undefined {
	const list = path.slice(0, -1);
	return Object.entries(follow.newest ?? {}).find(([each]) => matches(pattern(each), list))?.[1];
}

/** The value at `path` of `value`, each item segment the item of that key (`id` unless `keys` says). */
function atPath(follow: Pick<Follow, "keys">, value: Json | undefined, path: Path): Json | undefined {
	let here = value;
	for (const [i, segment] of path.entries()) {
		if (typeof segment === "string") {
			here = object(here) ? here[segment] : undefined;
			continue;
		}
		const list = Object.keys(follow.keys ?? {}).find((each) => matches(pattern(each), path.slice(0, i)));
		const field = list === undefined ? "id" : (follow.keys?.[list] ?? "id");
		here = Array.isArray(here) ? here.find((each) => object(each) && String(each[field]) === segment.item) : undefined;
	}
	return here;
}

/** A kind's name in the owner's words: `pull_request` is "Pull request". */
export const kindLabel = (kind: string) => {
	const words = kind.replaceAll("_", " ");
	return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** Words that say nothing alone once their data is gone ("now at Google", "no longer at Google", "in #general"). */
const DANGLING = new Set(["now", "no longer", "in"]);

/**
 * A rule's words as they read without their data: placeholders gone, with the possessive, punctuation or preposition
 * that only made sense with them ("{user.login}'s review was dismissed" is "review was dismissed", "moved to {to}" is
 * "moved"). Empty when nothing reads alone: such a rule is not said.
 */
function saysWords(says: string): string {
	const words = says
		.replace(/\{[^}]*\}(?:['’]s\b)?/g, "\0")
		.replace(/\b(?:from|to|with|at|by|for|of|on)\s+\0/gi, "\0")
		.replace(/[:#]*\0:?/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^[\s:#,.]+|[\s:#,.]+$/g, "");
	return DANGLING.has(words.toLowerCase()) ? "" : words;
}

/**
 * What following a kind wakes for and what it only tells, in the rules' own words, each once: a rule whose words are a
 * lookup (`{to}` with `words`) says each value. What no rule matches is said too, when something happens for it.
 */
export function followWords(follow: Pick<Follow, "rules" | "otherwise">): {
	readonly wakes: readonly string[];
	readonly tells: readonly string[];
} {
	const said = (does: Rule["does"]) => {
		const phrases = follow.rules.flatMap((rule) => {
			if (rule.does !== does) return [];
			if (rule.says === "{to}" && rule.words !== undefined) return Object.values(rule.words);
			const words = saysWords(rule.says);
			return words === "" ? [] : [words];
		});
		if (follow.otherwise === does) phrases.push("anything else that changes");
		return [...new Set(phrases)];
	};
	return { wakes: said("wake"), tells: said("tell") };
}

/** Whether `a` comes after `b`: numbers by size, ISO times and other strings by their order. */
const past = (a: Json | undefined, b: Json | undefined) =>
	(typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string") ? a > b : false;

/**
 * Whether an item that came into a `newest` list is new: its field past every item's the reading before had. One that
 * slid in as another left (a release deleted, a page's last item pushed off and back) is not.
 */
function isNew(follow: Follow, before: Json, change: Change, field: string): boolean {
	const was = atPath(follow, before, change.path.slice(0, -1));
	const at = (item: Json | undefined) => valuesAt(item, pattern(field))[0];
	const mine = at(change.item);
	if (mine === undefined || mine === null) return false;
	return (Array.isArray(was) ? was : []).every((item) => {
		const theirs = at(item);
		return theirs === undefined || theirs === null || past(mine, theirs);
	});
}

/**
 * Whether a list item added or gone is inside its window: an item gone that is older than the oldest the window keeps
 * now was pushed off, and one come that is older than the oldest it kept before is one that was there already.
 */
function inWindow(follow: Follow, before: Json, after: Json, change: Change): boolean {
	if (change.kind === "changed") return true;
	const list = change.path.slice(0, -1);
	const by = Object.entries(follow.windows ?? {}).find(([each]) => matches(pattern(each), list))?.[1];
	if (by === undefined) return true;
	const items = atPath(follow, change.kind === "removed" ? after : before, list);
	const oldest = (Array.isArray(items) ? items : [])
		.map((item) => (object(item) ? item[by] : undefined))
		.reduce<Json | undefined>(
			(low, v) => (v === undefined || (low !== undefined && !later(low, v)) ? low : v),
			undefined,
		);
	return oldest === undefined || !later(oldest, change.item?.[by]);
}

/**
 * Whose a change is, by the most specific `authors` entry it is at or under. A pattern may name one object rather than
 * a list (a file, whose last change says whose it was): every change in it is that author's, and a change no list item
 * holds is said from the object's fields (`whole`). An entry over a list speaks for an item's coming and going and its
 * own fields; a change inside a list the item holds (a reaction on a message) is not the item author's, and is judged
 * by that list's own entry if it has one, else by the rules alone.
 */
function authorOf(follow: Follow, after: Json, change: Change): { whole?: Item; author?: Json | undefined } {
	const entry = Object.entries(follow.authors ?? {})
		.filter(([each]) => matches(pattern(each), change.path.slice(0, pattern(each).length)))
		.sort(([a], [b]) => pattern(b).length - pattern(a).length)[0];
	if (entry === undefined) return {};
	const depth = pattern(entry[0]).length;
	const whole = objectAt(after, change.path.slice(0, depth));
	if (whole !== undefined) return { whole, author: valuesAt(whole, pattern(entry[1]))[0] };
	if (change.path.slice(depth + 1).some((segment) => typeof segment === "object")) return {};
	return { author: valuesAt(change.item, pattern(entry[1]))[0] };
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

/**
 * A rule's words for a change: each `{path}` from the item (or `{to}`, `{from}`: the value it changed to or from), said
 * as `words` say, plain. An item's own `to` and `from` (an email's, a Slack message's author) stay: a change inside it
 * says who it is from, and the value it changed to or from is said only where the item has no field of that name.
 */
export function saysOf(rule: Pick<Rule, "says" | "words">, change: Change): string {
	const scope: Item = { ...(change.item ?? {}) };
	if (change.to !== undefined && change.to !== change.item && !("to" in scope)) scope.to = change.to;
	if (change.from !== undefined && change.from !== change.item && !("from" in scope)) scope.from = change.from;
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
		// a page of the newest: what leaves it was pushed off, and what came into it is new only when it is newer
		const newest = newestField(follow, change.path);
		if (newest !== undefined && change.kind === "removed") continue;
		if (!inWindow(follow, before, after, change)) {
			sorted.push({ change, does: "nothing", says: changeWords(change) });
			continue;
		}
		if (newest !== undefined && change.kind === "added" && !isNew(follow, before, change, newest)) {
			sorted.push({ change, does: "nothing", says: changeWords(change) });
			continue;
		}
		const { whole, author } = authorOf(follow, after, change);
		if (me !== undefined && author === me) {
			sorted.push({ change, does: "nothing", says: changeWords(change) });
			continue;
		}
		const rule = follow.rules.find(
			(each) =>
				matches(pattern(each.on), change.path) &&
				(each.kind === undefined || each.kind === change.kind) &&
				(each.to === undefined || canonical(each.to) === canonical(change.to)) &&
				(each.from === undefined || canonical(each.from) === canonical(change.from)) &&
				(each.where === undefined || (change.item !== undefined && holds(each.where, change.item))),
		);
		const says =
			rule === undefined
				? changeWords(change)
				: saysOf(rule, change.item === undefined && whole !== undefined ? { ...change, item: whole } : change);
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
	"newest",
	"ignore",
	"authors",
	"derived",
	"rules",
	"otherwise",
	"ends",
	"busy",
	"every",
	"busy_every",
	"settle",
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
	for (const key of ["keys", "totals", "newest", "authors", "ends"] as const)
		if (follow[key] !== undefined && !stringMap(follow[key])) problem(`"${key}" is {"pattern": "path"}`);
	if (
		follow.ignore !== undefined &&
		!(Array.isArray(follow.ignore) && follow.ignore.every((each) => typeof each === "string"))
	)
		problem(`"ignore" is a list of paths`);
	const derivedOk =
		follow.derived === undefined ||
		(object(follow.derived as Json) &&
			Object.values(follow.derived as object).every(
				(each) =>
					typeof each === "string" ||
					(object(each as Json) &&
						typeof (each as { when?: unknown }).when === "string" &&
						typeof (each as { steady?: unknown }).steady === "string" &&
						Object.keys(each as object).every((key) => key === "when" || key === "steady")),
			));
	if (!derivedOk) problem(`"derived" is {"name": "condition"} or {"name": {"when": "condition", "steady": "path"}}`);
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
				(r.where !== undefined && (typeof r.where !== "string" || "error" in parseCondition(r.where))) ||
				(r.words !== undefined && !stringMap(r.words))
			)
				problem(
					`a rule is {"on": "path", "kind"?, "to"?, "from"?, "where"?, "does": "wake" | "tell" | "nothing", "says", "words"?}`,
				);
		}
	if (follow.otherwise !== undefined && !DOES.has(follow.otherwise as string))
		problem(`"otherwise" is wake, tell or nothing`);
	const ends = stringMap(follow.ends) ? (follow.ends as { [name: string]: string }) : {};
	if (!stringMap(follow.ends))
		problem(`"ends" names what ends a watch: {"merged": "pr.merged = true"}, or {} when nothing does`);
	for (const name of Object.keys(ends)) if (!NAME.test(name)) problem(`"${name}" is not a word for an end`);
	const conditions = [
		...Object.values(ends ?? {}),
		...(derivedOk ? Object.values((follow.derived ?? {}) as { [name: string]: Derived }).map(whenOf) : []),
	];
	if (typeof follow.busy === "string") conditions.push(follow.busy);
	for (const text of conditions) {
		const parsed = parseCondition(text);
		if ("error" in parsed) problem(parsed.error);
	}
	for (const key of ["every", "busy_every", "settle"] as const)
		if (follow[key] !== undefined && (typeof follow[key] !== "string" || parseEvery(follow[key]) === undefined))
			problem(`"${key}" is a period, such as 30m`);
	if (errors.length > 0) return { errors };
	const f = follow as Follow;
	return {
		follow: {
			...(f.keys === undefined ? {} : { keys: f.keys }),
			...(f.totals === undefined ? {} : { totals: f.totals }),
			...(f.newest === undefined ? {} : { newest: f.newest }),
			...(f.ignore === undefined ? {} : { ignore: f.ignore }),
			...(f.authors === undefined ? {} : { authors: f.authors }),
			...(f.derived === undefined ? {} : { derived: f.derived }),
			rules: f.rules,
			...(f.otherwise === undefined ? {} : { otherwise: f.otherwise }),
			ends: ends ?? {},
			...(f.busy === undefined ? {} : { busy: f.busy }),
			...(f.every === undefined ? {} : { every: f.every }),
			...(f.busy_every === undefined ? {} : { busy_every: f.busy_every }),
			...(f.settle === undefined ? {} : { settle: f.settle }),
		},
	};
}

/**
 * When a look may leave a read unmade and carry its kept answer forward (DESIGN.md "Watches"), so a quiet object costs
 * one request: the values at `same`, paths into reads made at every look, are the kept reading's; `while`, a condition
 * over the kept reading, holds; and the kept answer is younger than `every`. A pull request's reviews and comments
 * move its `updated_at`; its checks move nothing on it, so they are read while they run, when the head or `updated_at`
 * moved (a label, a reopen or ready for review starts workflows on the same head), and at least every `every` besides
 * (a re-run, or a check that starts late, on the same head).
 */
export type Unless = { readonly same: readonly string[]; readonly while?: string; readonly every?: string };

/**
 * When a look last made a read an `Unless` guards (by the look's clock), and the values at its `same` then, when the
 * reading kept before that look already had them, its condition held over it, and its reads had ended a minute or
 * more before: the answer holds every change up to those values. A service's times have a grain (GitHub's, a second),
 * so an answer made at the look that first saw a value may miss a change in the same second after it, which leaves the
 * value as it was; and a condition just come true may not stay so (a check that starts as the others finish): the next
 * look makes it again.
 */
export type Made = { readonly at: number; readonly sure?: string };

/** How long before a look the reads of the reading it compares with must have ended for its answers to be sure. */
export const SURE_AFTER = 60_000;

/** The value at `path` in `reading`, in canonical words; undefined when the reading has none there. */
export function valueAt(reading: Json | undefined, path: string): string | undefined {
	const values = valuesAt(reading, pattern(path)).filter((value) => value !== undefined && value !== null);
	return values.length === 0 ? undefined : canonical(values as Json[]);
}

/** The values at every path of `same` in `reading`, in canonical words; undefined when any is missing. */
function valuesOf(reading: Json | undefined, same: readonly string[]): string | undefined {
	const values = same.map((path) => valueAt(reading, path));
	return values.some((value) => value === undefined) ? undefined : JSON.stringify(values);
}

/**
 * Whether a look may carry the kept answer of a read `unless` guards: `answers` is what the look has read so far,
 * `kept` the reading kept (its derived conditions with it), `made` when its answer was made.
 */
export function mayCarry(unless: Unless, answers: Item, kept: Item, made: Made | undefined, now: number): boolean {
	const value = valuesOf(answers, unless.same);
	if (value === undefined || made?.sure !== value || valuesOf(kept, unless.same) !== value) return false;
	if (unless.while !== undefined && !holds(unless.while, kept)) return false;
	const every = unless.every === undefined ? undefined : parseEvery(unless.every);
	// a clock that went back carries nothing: the answer's age is not known
	return now >= made.at && (every === undefined || now - made.at < every);
}

/**
 * What a look that made a read `unless` guards keeps of it: when, and the values at `same` if it is sure. `kept` is the
 * reading kept as the look began, and `through` when the reads that took it had ended (the look's start, else).
 */
export function madeNow(
	unless: Unless,
	answers: Item,
	kept: { answers: Item; at: number; through?: number } | undefined,
	now: number,
): Made {
	const value = valuesOf(answers, unless.same);
	const sure =
		value !== undefined &&
		kept !== undefined &&
		now - (kept.through ?? kept.at) >= SURE_AFTER &&
		valuesOf(kept.answers, unless.same) === value &&
		(unless.while === undefined || holds(unless.while, kept.answers));
	return sure ? { at: now, sure: value } : { at: now };
}

/** A read's `unless`, or undefined when it is not one. */
export function parseUnless(value: unknown): Unless | undefined {
	if (!object(value as Json)) return undefined;
	const { same, while: during, every, ...rest } = value as { same?: unknown; while?: unknown; every?: unknown };
	if (Object.keys(rest).length > 0) return undefined;
	const path = /^[A-Za-z0-9_+-]{1,64}(?:\.[A-Za-z0-9_+-]{1,64}){1,7}$/;
	if (
		!Array.isArray(same) ||
		same.length === 0 ||
		same.length > 4 ||
		!same.every((each) => typeof each === "string" && path.test(each))
	)
		return undefined;
	if (during !== undefined && (typeof during !== "string" || during.length > 200 || "error" in parseCondition(during)))
		return undefined;
	if (every !== undefined && (typeof every !== "string" || parseEvery(every) === undefined)) return undefined;
	return {
		same: same as string[],
		...(during === undefined ? {} : { while: during as string }),
		...(every === undefined ? {} : { every: every as string }),
	};
}

/**
 * A list a read answers one page of (DESIGN.md "Watches"): the path of the list in the reading, the field that orders
 * it, and how many of its newest items the reading keeps, its window.
 */
export type Pages = { readonly list: string; readonly by: string; readonly keep: number };

/** The most items a window may keep. */
export const MAX_KEEP = 500;

/** Whether `a` orders after `b`: a decimal (Slack's `1700000000.000100`) by its value, else as `past` says. */
export function later(a: Json | undefined, b: Json | undefined): boolean {
	const decimal = /^(\d{1,20})(?:\.(\d{1,20}))?$/;
	const x = typeof a === "string" ? decimal.exec(a) : null;
	const y = typeof b === "string" ? decimal.exec(b) : null;
	if (x === null || y === null) return past(a, b);
	const [whole, part] = [x[1] ?? "", x[2] ?? ""];
	const [otherWhole, otherPart] = [y[1] ?? "", y[2] ?? ""];
	const width = Math.max(part.length, otherPart.length);
	const left = `${whole.padStart(20, "0")}.${part.padEnd(width, "0")}`;
	const right = `${otherWhole.padStart(20, "0")}.${otherPart.padEnd(width, "0")}`;
	return left > right;
}

const orderable = (value: Json | undefined) => typeof value === "string" || typeof value === "number";

/** The newest value of `by` among `items`, or undefined when none has one. */
export function newestOf(items: readonly Item[], by: string): Json | undefined {
	let newest: Json | undefined;
	for (const item of items)
		if (orderable(item[by]) && (newest === undefined || later(item[by], newest))) newest = item[by];
	return newest;
}

/**
 * Whether a page runs newest first: its first item orders after its last (Slack's history); undefined when it cannot
 * tell (fewer than two items, or all alike). A thread's replies run oldest first, its first message before them.
 */
export function descends(items: readonly Item[], by: string): boolean | undefined {
	const values = items.map((item) => item[by]).filter(orderable);
	const [first, last] = [values[0], values[values.length - 1]];
	if (first === undefined || last === undefined) return undefined;
	return later(first, last) ? true : later(last, first) ? false : undefined;
}

/**
 * The part of a list a walk of pages read whole: past `from` (and at it, when `inclusive`), up to `to` (or the newest,
 * unset). An item of the window in it that the pages did not bring was deleted; one outside it was not read again.
 */
export type Span = { readonly from?: Json; readonly inclusive?: boolean; readonly to?: Json };

const inSpan = (value: Json | undefined, span: Span) =>
	(span.from === undefined ||
		later(value, span.from) ||
		(span.inclusive === true && !later(span.from, value) && !later(value, span.from))) &&
	(span.to === undefined || !later(value, span.to));

/**
 * `held` and `fetched` as one window: each item once by `key` (what was fetched wins, as it is now), an item `held` in
 * the `span` the pages read whole left out unless they brought it again (it was deleted), ordered by `by` newest first
 * or last as `descending` says, and only the newest `keep`. An item without a value of `by` cannot be placed in the
 * window and is left out. Merging the same pages again changes nothing, and nothing newer than the `keep`-th newest
 * that the pages did not find deleted is ever dropped. With `maxBytes`, the window keeps only the newest items whose
 * JSON fits in it, the oldest pushed off first, so a window of long messages stays as bounded as one answer.
 */
export function merge(
	held: readonly Item[],
	fetched: readonly Item[],
	pages: Pick<Pages, "by" | "keep">,
	key: string,
	descending: boolean,
	span?: Span,
	maxBytes?: number,
): Item[] {
	const byKey = new Map<string, Item>();
	const kept = span === undefined ? held : held.filter((item) => !inSpan(item[pages.by], span));
	for (const item of [...kept, ...fetched])
		if (orderable(item[key]) && orderable(item[pages.by])) byKey.set(String(item[key]), item);
	const ascending = [...byKey.values()].sort((a, b) =>
		later(a[pages.by], b[pages.by]) ? 1 : later(b[pages.by], a[pages.by]) ? -1 : 0,
	);
	const newest = ascending.slice(Math.max(0, ascending.length - pages.keep));
	if (maxBytes !== undefined) {
		let size = bytesOf(newest);
		while (newest.length > 0 && size > maxBytes) size -= JSON.stringify(newest.shift()).length + 1;
	}
	return descending ? newest.reverse() : newest;
}

/** The bytes of a list of items as JSON. */
const bytesOf = (items: readonly Item[]) => items.reduce((sum, item) => sum + JSON.stringify(item).length + 1, 1);

/**
 * A walk of a paged list's pages that has not reached the window yet: when it began, what it asked from (`oldest`),
 * the service's cursor for the next page (none once it was given up on, an hour on: the next page is a look's own), the
 * newest `keep` items it brought, the span of what it read, and which way the service hands the pages.
 */
export type Walk = {
	since: number;
	oldest?: string;
	cursor?: string;
	items: Item[];
	low?: Json;
	high?: Json;
	descending?: boolean;
};

/**
 * What the next page of a paged list asks: the walk's own next page; else, newest first (or unknown), the newest page;
 * oldest first, from the window's item one page (`size`, as a full page held) from its newest end, so the newest page
 * is read again and an edit or a deletion in it is seen; the whole list from its start while no page was ever full.
 */
export function pageArgs(
	walk: Walk | undefined,
	window: readonly Item[] | undefined,
	by: string,
	size: number | undefined,
): { readonly oldest?: string; readonly cursor?: string } {
	if (walk?.cursor !== undefined)
		return { ...(walk.oldest === undefined ? {} : { oldest: walk.oldest }), cursor: walk.cursor };
	if (window === undefined || size === undefined || descends(window, by) !== false) return {};
	const ascending = merge([], window, { by, keep: MAX_KEEP }, by, false);
	// a window shorter than a page (its bytes pushed the rest off) is read again from its oldest, never the whole list
	const from = ascending[Math.max(0, ascending.length - 1 - size)]?.[by];
	return from === undefined || from === null ? {} : { oldest: String(from) };
}

const lowest = (values: readonly (Json | undefined)[]) =>
	values
		.filter(orderable)
		.reduce<Json | undefined>((low, v) => (low === undefined || later(low, v) ? v : low), undefined);
const highest = (values: readonly (Json | undefined)[]) =>
	values
		.filter(orderable)
		.reduce<Json | undefined>((high, v) => (high === undefined || later(v, high) ? v : high), undefined);

/**
 * One page more of a walk: still walking (the pages have not reached the window, and the service has more), or the
 * window merged with what the walk read, each item of the window in the span the pages read whole and not brought
 * again taken as deleted. Newest first, the walk reaches the window when a page brings an item at or before the
 * window's newest; oldest first, when the service has no more. With no window yet (the first look), a newest page is
 * the window by itself. A walk older than `expire` merges what it read, never deleting what it did not reach, and says
 * so (`gap`): changes between may be missing, and so does a walk whose items outgrow `maxBytes`, the most the window
 * may hold. `size` is how many items a full page held, when this one was full.
 */
export function walkOn(look: {
	readonly walk: Walk | undefined;
	readonly asked: { readonly oldest?: string; readonly cursor?: string };
	readonly page: readonly Item[];
	readonly next: string | undefined;
	readonly window: readonly Item[] | undefined;
	readonly pages: Pages;
	readonly key: string;
	readonly now: number;
	readonly expire: number;
	readonly maxBytes?: number;
}): ({ readonly walk: Walk } | { readonly list: Item[]; readonly gap: boolean }) & { readonly size?: number } {
	const { walk, asked, page, next, window, pages, key, maxBytes } = look;
	const by = pages.by;
	const descending =
		descends(page, by) ?? walk?.descending ?? (window === undefined ? undefined : descends(window, by));
	const desc = descending !== false;
	const items = merge(walk?.items ?? [], page, pages, key, desc);
	const values = page.map((item) => item[by]);
	const low = lowest([walk?.low, ...values]);
	const high = highest([walk?.high, ...values]);
	const size =
		next === undefined
			? undefined
			: page.filter((item) => asked.oldest === undefined || later(item[by], asked.oldest)).length;
	const sized = size === undefined || size === 0 ? {} : { size };
	const newest = window === undefined ? undefined : newestOf(window, by);
	const reaches = desc && newest !== undefined && page.some((item) => orderable(item[by]) && !later(item[by], newest));
	if (next === undefined || reaches || (desc && window === undefined)) {
		const span: Span | undefined =
			window === undefined
				? undefined
				: asked.oldest !== undefined
					? { from: asked.oldest }
					: next === undefined
						? {}
						: low === undefined
							? undefined
							: { from: low, inclusive: true };
		return { list: merge(window ?? [], items, pages, key, desc, span, maxBytes), gap: false, ...sized };
	}
	const full = maxBytes !== undefined && bytesOf(items) > maxBytes;
	if (full || (walk !== undefined && look.now - walk.since >= look.expire)) {
		const span: Span | undefined =
			low === undefined
				? undefined
				: { from: low, inclusive: true, ...(desc || high === undefined ? {} : { to: high }) };
		return { list: merge(window ?? [], items, pages, key, desc, span, maxBytes), gap: true, ...sized };
	}
	return {
		walk: {
			since: walk?.since ?? look.now,
			...(asked.oldest === undefined ? {} : { oldest: asked.oldest }),
			cursor: next,
			items,
			...(low === undefined ? {} : { low }),
			...(high === undefined ? {} : { high }),
			...(descending === undefined ? {} : { descending }),
		},
		...sized,
	};
}
