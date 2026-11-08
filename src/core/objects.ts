/**
 * Objects (DESIGN.md "Connections"): things in a connection the owner recognises (a pull request, an issue, a check
 * run), drawn as cards wherever they are named. A connection declares its objects as data, in its file's ```json block
 * (`"objects"`), never code: for each kind, the URL and id shapes that name it, the reads that fetch it (a tool its file
 * says only reads, and how its arguments come from the match), the fields the card shows (where each is in what the
 * reads answered), the writes that act on it (a tool, how its arguments name the object, the verb the draft says) and
 * the writes that make one (a tool, the arguments that say where, the verb and the words the draft says).
 *
 * The card itself is the daemon's: each kind names one of the cards it draws (`pull-request`, `issue`, `check-run`,
 * `notification`, `repository`, …), and what a reading holds is turned into that card here, every string a plain line, bounded. A
 * reading is kept in the store by (connection, account, object), with its time, bounded: what the owner saw last, and
 * what keeps a chatty chat from making the daemon read a service again and again.
 */
import { defineDoc, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import { type Follow, parseFollow } from "./follow.ts";
import { slackTs } from "./slack-text.ts";

type JsonValue = JsonObject[string];

/** The cards the daemon draws. */
export const CARDS = [
	"pull-request",
	"issue",
	"check-run",
	"notification",
	"discussion",
	"repository",
	"email",
	"messages",
	"event",
	"contact",
	"file",
] as const;
export type CardKind = (typeof CARDS)[number];

/**
 * A read that fetches an object: a tool, and its arguments, each a value, a `{placeholder}` the match fills, or a list
 * of words (the fields a list read asks for).
 */
export type ObjectRead = {
	readonly tool: string;
	readonly args: { readonly [arg: string]: JsonValue | readonly string[] };
	readonly optional?: boolean;
	/** Made only when the object is followed (its comments): the card does without it. */
	readonly follow?: boolean;
};

/** A write that acts on an object: how its arguments name it, and the words its draft says. */
export type ObjectWrite = {
	readonly tool: string;
	/** Each placeholder of the kind's ids, by the argument that gives it. */
	readonly id: { readonly [placeholder: string]: string };
	/** The draft's button: "Comment". */
	readonly verb: string;
	/** What it does, before the object's name: "Comment on". Default the verb. */
	readonly what?: string;
	/** The argument the owner may edit before approving: the comment's body. */
	readonly text?: string;
	/** Other words for some arguments: `{"when": {"state": "closed"}, "verb": "Close"}`, the first that matches. */
	readonly verbs?: readonly {
		readonly when: { readonly [arg: string]: string };
		readonly verb: string;
		readonly what?: string;
	}[];
};

/**
 * A write that makes one, so it names none yet: the arguments that say where, and the words its draft says. `{"tool":
 * "issue_write", "when": {"method": "create"}, "in": {"owner": "owner", "repo": "repo"}, "verb": "Create", "what":
 * "Create an issue on {owner}/{repo}"}`.
 */
export type ObjectCreate = {
	readonly tool: string;
	/** The arguments' values that make it this write: a tool that also changes one says which. */
	readonly when?: { readonly [arg: string]: string };
	/** Each placeholder its words name, by the argument that gives it. */
	readonly in: { readonly [placeholder: string]: string };
	/** The draft's button: "Create". */
	readonly verb: string;
	/** What it does, with the placeholders `in` gives: "Create an issue on {owner}/{repo}". */
	readonly what: string;
	/** The argument the owner may edit before approving. */
	readonly text?: string;
};

export type ObjectKind = {
	readonly card: CardKind;
	/** How the owner reads its name: "{owner}/{repo} #{number}". */
	readonly name: string;
	/**
	 * Web addresses that name it, as templates: a tab (one more part of the path), a query or a fragment after the
	 * template's end still names it, a deeper path does not (it opens something inside: a commit of a pull request, a
	 * file of a repository); and a `*` stands for one part of the path that does not matter.
	 */
	readonly urls: readonly string[];
	/** Shorter ids that name it, as templates, matched whole. */
	readonly ids: readonly string[];
	/**
	 * Provider identity rules, by placeholder; omitted placeholders keep their spelling. `text` is words, not an
	 * identity (a search's query, `from:boss is:unread`): percent-encoded in a URL or id, where it is the last token,
	 * and said decoded, its spaces collapsed, in the object's name and its reads' arguments.
	 */
	readonly normalize?: { readonly [placeholder: string]: Normalize };
	/** The reads that fetch it, by the name its fields use. */
	readonly reads: { readonly [as: string]: ObjectRead };
	/** The card's fields, each a dotted path into what the reads answered (`pr.user.login`). */
	readonly fields: { readonly [field: string]: string };
	readonly writes?: readonly ObjectWrite[];
	readonly creates?: readonly ObjectCreate[];
	/** How a watch follows it (DESIGN.md "Watches"); a kind without it cannot be followed. */
	readonly follow?: Follow;
};

export type ObjectKinds = { readonly [kind: string]: ObjectKind };
/**
 * `slack-ts`: a Slack message's timestamp, from a link's `p1700000000000100` or as Slack writes it, `1700000000.000100`;
 * in a URL, a `thread_ts` in its query names the thread the message is in, so a reply's link names its thread.
 */
export const NORMALIZE = ["lowercase", "integer", "text", "slack-ts"] as const;
type Normalize = (typeof NORMALIZE)[number];

/** One thing named: of which connection and kind, and the values its template matched. */
export type ObjectRef = {
	readonly connection: string;
	readonly kind: string;
	readonly values: { readonly [placeholder: string]: string };
};

const PLACEHOLDER = /\{([a-z_]{1,32})\}/g;
/** A bounded identity segment, never separators, spaces or `..`. */
const VALUE = "([A-Za-z0-9_][A-Za-z0-9_.-]{0,399})";
/**
 * Words percent-encoded (a space as `+` or `%20`), never `/`, `?` or `#`: what a `text` placeholder captures; in an id,
 * matched whole, a space may stand as itself (`gmail/search/from:boss is:unread`).
 */
const TEXT = (url: boolean) => `([A-Za-z0-9_.~!*'()%+:@$,;=${url ? "" : " "}-]{1,1500})`;
/** Words a `text` placeholder holds, decoded: plain, one line, bounded. */
const TEXT_VALUE = /^[^\p{Cc}\p{Cf}]{1,500}$/u;
const textOf = (raw: string): string | undefined => {
	try {
		return decodeURIComponent(raw.replaceAll("+", " "));
	} catch {
		return undefined;
	}
};
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL = /^[A-Za-z0-9_.-]{1,64}$/;
const PATH = /^[A-Za-z0-9_+-]{1,64}(?:\.[A-Za-z0-9_+-]{1,64}){0,7}$/;
const WORDS = /^[A-Za-z][A-Za-z ]{0,39}$/;
/** What a write that makes an object says, each placeholder read as one letter: "Create an issue on x/x". */
const CREATED = /^[A-Za-z][A-Za-z0-9 /#.:-]{0,79}$/;
const plain = (value: unknown): value is { [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const reserved = (key: string) => ["__proto__", "prototype", "constructor"].includes(key);

const placeholders = (template: string) => [...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * What may follow a URL template and still name its object: a tab (one more part of the path), then a query or a
 * fragment. A deeper path opens something inside the object, so `https://github.com/{owner}/{repo}` never takes a
 * pull request's URL, whatever order the kinds are declared in.
 */
export const TAB = "(?:/[^/?#\\s]+)?/?(?:[?#][^\\s]*)?";

/** A template as a pattern: its placeholders captured, in order; a `text` one as words percent-encoded. */
function patternOf(template: string, url: boolean, normalize?: ObjectKind["normalize"]): RegExp {
	let source = "";
	let last = 0;
	const literal = (text: string) => escapePattern(text).replaceAll("\\*", "[A-Za-z0-9_.%=-]{1,500}");
	for (const match of template.matchAll(PLACEHOLDER)) {
		source += literal(template.slice(last, match.index)) + (normalize?.[match[1] ?? ""] === "text" ? TEXT(url) : VALUE);
		last = (match.index ?? 0) + match[0].length;
	}
	source += literal(template.slice(last));
	return new RegExp(url ? `^${source}${TAB}$` : `^${source}$`);
}

/** Whether the read `read` only reads, as the file says: a tool in its `reads`, or matching one of its rules. */
type IsRead = (tool: string, args: { readonly [arg: string]: JsonValue }) => boolean;

/**
 * Parse a file's `"objects"`; every problem is reported. Each read must be one the file says only reads: a card is
 * drawn for the owner's eyes, and nothing that draws it ever writes.
 */
export function parseObjects(value: unknown, isRead: IsRead): { objects: ObjectKinds } | { errors: string[] } {
	const errors: string[] = [];
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { errors: [`"objects" is {"kind": {"card", "name", "urls", "ids", "reads", "fields"}}`] };
	const objects: { [kind: string]: ObjectKind } = {};
	if (Object.keys(value).length > 12) return { errors: ["objects has at most 12 kinds"] };
	for (const [kind, raw] of Object.entries(value)) {
		const where = `objects.${kind}`;
		if (!NAME.test(kind) || reserved(kind))
			errors.push(`"${kind}" is not a kind's name: lowercase letters, digits and underscores`);
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			errors.push(`${where} is an object`);
			continue;
		}
		const given = raw as { [key: string]: unknown };
		for (const key of Object.keys(given))
			if (!["card", "name", "urls", "ids", "normalize", "reads", "fields", "writes", "creates", "follow"].includes(key))
				errors.push(
					`${where}.${key} is not a field: use card, name, urls, ids, normalize, reads, fields, writes, creates, follow`,
				);
		const card = given.card;
		if (typeof card !== "string" || !(CARDS as readonly string[]).includes(card))
			errors.push(`${where}.card is one of ${CARDS.join(", ")}`);
		const strings = (key: string) => {
			const list = given[key] ?? [];
			if (
				!Array.isArray(list) ||
				list.length > 8 ||
				list.some((each) => typeof each !== "string" || each.length > 300)
			) {
				errors.push(`${where}.${key} is a list of templates`);
				return [];
			}
			return list as string[];
		};
		const urls = strings("urls");
		const ids = strings("ids");
		if (urls.length + ids.length === 0) errors.push(`${where} names no URL or id that names it`);
		const shapes = [...urls, ...ids];
		const named = new Set(placeholders(shapes[0] ?? ""));
		for (const url of urls)
			if (!/^https:\/\/(?:\*\.)?[a-z0-9.-]+\//.test(url))
				errors.push(`${where}: "${url}" is not an https address's template`);
		for (const shape of shapes) {
			const own = placeholders(shape);
			// Repetitions may never overlap: every pair of variable tokens has a delimiter
			// neither token consumes. This rules out exponential regex backtracking by construction.
			const tokens = [...shape.matchAll(/\{[a-z_]{1,32}\}|\*/g)];
			if (tokens.length > 16 || /[{}]/.test(shape.replace(/\{[a-z_]{1,32}\}/g, "")))
				errors.push(`${where}: invalid template grammar`);
			for (let i = 1; i < tokens.length; i++) {
				const before = tokens[i - 1];
				const next = tokens[i];
				if (
					before !== undefined &&
					next !== undefined &&
					!/[^A-Za-z0-9_.-]/.test(shape.slice((before.index ?? 0) + before[0].length, next.index))
				)
					errors.push(`${where}: variable tokens need a non-overlapping separator such as / or #`);
			}
			if (own.some(reserved)) errors.push(`${where}: reserved placeholder`);
			if (own.length === 0) errors.push(`${where}: "${shape}" has no {placeholder}`);
			if (new Set(own).size !== own.length) errors.push(`${where}: "${shape}" names a placeholder twice`);
			if (own.length !== named.size || own.some((each) => !named.has(each)))
				errors.push(`${where}: "${shape}" names other placeholders than "${shapes[0]}"`);
			if (/\}\{/.test(shape)) errors.push(`${where}: "${shape}" puts two placeholders together`);
		}
		const normalize: { [placeholder: string]: Normalize } = {};
		if (given.normalize !== undefined) {
			if (typeof given.normalize !== "object" || given.normalize === null || Array.isArray(given.normalize))
				errors.push(`${where}.normalize maps placeholders to lowercase, integer, text or slack-ts`);
			else
				for (const [placeholder, rule] of Object.entries(given.normalize)) {
					if (!named.has(placeholder) || reserved(placeholder) || !NORMALIZE.includes(rule as Normalize))
						errors.push(
							`${where}.normalize.${placeholder} must name a placeholder and use lowercase, integer, text or slack-ts`,
						);
					else normalize[placeholder] = rule as Normalize;
				}
		}
		// words take any character but a separator: only a template's end tells where they stop
		for (const shape of shapes)
			for (const [placeholder, rule] of Object.entries(normalize))
				if (rule === "text" && !shape.endsWith(`{${placeholder}}`))
					errors.push(`${where}: "${shape}" must end with {${placeholder}}, which is words`);
		const name = given.name;
		if (typeof name !== "string" || name.length > 100 || placeholders(name).some((each) => !named.has(each)))
			errors.push(`${where}.name is how the owner reads its name, from its placeholders`);
		const reads: { [as: string]: ObjectRead } = {};
		const rawReads = given.reads;
		if (
			typeof rawReads !== "object" ||
			rawReads === null ||
			Array.isArray(rawReads) ||
			Object.keys(rawReads).length === 0 ||
			Object.keys(rawReads).length > 4
		)
			errors.push(`${where}.reads is {"name": {"tool", "args"}}`);
		else
			for (const [as, read] of Object.entries(rawReads)) {
				const tool = (read as { tool?: unknown } | null)?.tool;
				const args = (read as { args?: unknown } | null)?.args ?? {};
				const optional = (read as { optional?: unknown } | null)?.optional;
				const follow = (read as { follow?: unknown } | null)?.follow;
				if (optional !== undefined && typeof optional !== "boolean")
					errors.push(`${where}.reads.${as}.optional is a boolean`);
				if (follow !== undefined && typeof follow !== "boolean")
					errors.push(`${where}.reads.${as}.follow is a boolean`);
				if (
					!NAME.test(as) ||
					reserved(as) ||
					typeof tool !== "string" ||
					!TOOL.test(tool) ||
					typeof args !== "object" ||
					args === null ||
					Array.isArray(args)
				) {
					errors.push(`${where}.reads.${as} is {"tool", "args"}`);
					continue;
				}
				if (Object.keys(args).length > 20) errors.push(`${where}.reads.${as}: at most 20 arguments`);
				for (const [arg, each] of Object.entries(args)) {
					// a list of words, such as the fields a list read asks for, so a page of it stays small
					const words =
						Array.isArray(each) &&
						each.length <= 32 &&
						each.every((word) => typeof word === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(word));
					if (
						reserved(arg) ||
						!/^[A-Za-z0-9_]{1,64}$/.test(arg) ||
						(each !== null && !words && !["string", "number", "boolean"].includes(typeof each)) ||
						(typeof each === "string" && each.length > 500)
					)
						errors.push(`${where}.reads.${as}: arguments are bounded scalar values or lists of words`);
					if (typeof each === "string")
						for (const used of placeholders(each))
							if (!named.has(used))
								errors.push(`${where}.reads.${as}.${arg} names {${used}}, which no URL or id gives`);
				}
				if (!isRead(tool, args as { [arg: string]: JsonValue }))
					errors.push(`${where}.reads.${as}: ${tool} is not among the file's reads, and a card never writes`);
				reads[as] = {
					tool,
					args: args as { [arg: string]: JsonValue },
					...(optional === true ? { optional: true } : {}),
					...(follow === true ? { follow: true } : {}),
				};
			}
		const fields: { [field: string]: string } = {};
		const rawFields = given.fields;
		if (typeof rawFields !== "object" || rawFields === null || Array.isArray(rawFields))
			errors.push(`${where}.fields is {"field": "read.path"}`);
		else
			for (const [field, path] of Object.entries(rawFields)) {
				if (
					!NAME.test(field) ||
					reserved(field) ||
					typeof path !== "string" ||
					!PATH.test(path) ||
					path.split(".").some(reserved) ||
					reads[path.split(".")[0] ?? ""] === undefined
				)
					errors.push(`${where}.fields.${field} is a dotted path that starts with one of its reads' names`);
				else fields[field] = path;
			}
		const writes: ObjectWrite[] = [];
		const rawWrites = given.writes ?? [];
		if (!Array.isArray(rawWrites) || rawWrites.length > 12) errors.push(`${where}.writes is a list`);
		else
			for (const [n, write] of rawWrites.entries()) {
				const w = write as { [key: string]: unknown } | null;
				const at = `${where}.writes[${n}]`;
				const id = w?.id;
				if (
					typeof w !== "object" ||
					w === null ||
					Array.isArray(w) ||
					typeof w.tool !== "string" ||
					!TOOL.test(w.tool) ||
					typeof w.verb !== "string" ||
					!WORDS.test(w.verb) ||
					(w.what !== undefined && (typeof w.what !== "string" || !WORDS.test(w.what))) ||
					(w.text !== undefined && (typeof w.text !== "string" || !NAME.test(w.text))) ||
					typeof id !== "object" ||
					id === null ||
					Array.isArray(id)
				) {
					errors.push(`${at} is {"tool", "id": {"placeholder": "arg"}, "verb", "what"?, "text"?}`);
					continue;
				}
				const idArgs = id as { [placeholder: string]: unknown };
				if (
					Object.keys(idArgs).length !== named.size ||
					Object.entries(idArgs).some(
						([p, arg]) => !named.has(p) || typeof arg !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(arg),
					)
				)
					errors.push(`${at}.id gives each of ${[...named].join(", ")} from an argument`);
				const verbs: { when: { [arg: string]: string }; verb: string; what?: string }[] = [];
				for (const other of Array.isArray(w.verbs) ? w.verbs : []) {
					const o = other as { when?: unknown; verb?: unknown; what?: unknown } | null;
					if (
						typeof o !== "object" ||
						o === null ||
						Array.isArray(o) ||
						typeof o.when !== "object" ||
						o.when === null ||
						Object.values(o.when).some((v) => typeof v !== "string") ||
						typeof o.verb !== "string" ||
						!WORDS.test(o.verb) ||
						(o.what !== undefined && (typeof o.what !== "string" || !WORDS.test(o.what)))
					)
						errors.push(`${at}.verbs is [{"when": {"arg": "value"}, "verb", "what"?}]`);
					else
						verbs.push({
							when: o.when as { [arg: string]: string },
							verb: o.verb,
							...(o.what === undefined ? {} : { what: o.what as string }),
						});
				}
				if (w.verbs !== undefined && !Array.isArray(w.verbs)) errors.push(`${at}.verbs is a list`);
				writes.push({
					tool: w.tool,
					id: idArgs as { [placeholder: string]: string },
					verb: w.verb,
					...(w.what === undefined ? {} : { what: w.what as string }),
					...(w.text === undefined ? {} : { text: w.text as string }),
					...(verbs.length === 0 ? {} : { verbs }),
				});
			}
		const creates: ObjectCreate[] = [];
		const rawCreates = given.creates ?? [];
		if (!Array.isArray(rawCreates) || rawCreates.length > 12) errors.push(`${where}.creates is a list`);
		else
			for (const [n, create] of rawCreates.entries()) {
				const at = `${where}.creates[${n}]`;
				const c = plain(create) ? create : undefined;
				const into = c?.in;
				const when = c?.when;
				if (
					c === undefined ||
					typeof c.tool !== "string" ||
					!TOOL.test(c.tool) ||
					typeof c.verb !== "string" ||
					!WORDS.test(c.verb) ||
					typeof c.what !== "string" ||
					!CREATED.test(c.what.replace(PLACEHOLDER, "x")) ||
					(c.text !== undefined && (typeof c.text !== "string" || !NAME.test(c.text))) ||
					!plain(into) ||
					(when !== undefined && (!plain(when) || Object.values(when).some((v) => typeof v !== "string")))
				) {
					errors.push(
						`${at} is {"tool", "when"?: {"arg": "value"}, "in": {"placeholder": "arg"}, "verb", "what", "text"?}`,
					);
					continue;
				}
				if (
					Object.entries(into).some(
						([p, arg]) => !named.has(p) || typeof arg !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(arg),
					) ||
					placeholders(c.what).some((p) => !Object.hasOwn(into, p))
				) {
					errors.push(`${at}.in gives each placeholder its words name, of ${[...named].join(", ")}, from an argument`);
					continue;
				}
				creates.push({
					tool: c.tool,
					...(when === undefined ? {} : { when: when as { [arg: string]: string } }),
					in: into as { [placeholder: string]: string },
					verb: c.verb,
					what: c.what,
					...(c.text === undefined ? {} : { text: c.text as string }),
				});
			}
		let follow: Follow | undefined;
		if (given.follow !== undefined) {
			const parsed = parseFollow(given.follow, where);
			if ("errors" in parsed) errors.push(...parsed.errors);
			else follow = parsed.follow;
		}
		if (follow === undefined && Object.values(reads).some((read) => read.follow === true))
			errors.push(`${where}: a read made only when followed needs a "follow"`);
		objects[kind] = {
			card: card as CardKind,
			name: typeof name === "string" ? name : kind,
			urls,
			ids,
			...(Object.keys(normalize).length === 0 ? {} : { normalize }),
			reads,
			fields,
			...(writes.length === 0 ? {} : { writes }),
			...(creates.length === 0 ? {} : { creates }),
			...(follow === undefined ? {} : { follow }),
		};
	}
	return errors.length > 0 ? { errors } : { objects };
}

/** A ref's canonical words: `<connection>:<kind>:<its first id, filled>`, what the store and the app name it by. */
export function refKey(ref: ObjectRef, kinds: ObjectKinds): string {
	const kind = kinds[ref.kind];
	const shape = kind?.ids[0] ?? kind?.urls[0] ?? "";
	const values = normalizeValues(ref.values, kind?.normalize);
	if (values === undefined) throw new Error("Invalid object identity");
	return `${ref.connection}:${ref.kind}:${fill(shape, values, kind?.normalize)}`;
}

/** A template filled; in a URL or id (`normalize` given), words are percent-encoded. */
const fill = (
	template: string,
	values: { readonly [placeholder: string]: string },
	normalize?: ObjectKind["normalize"],
) =>
	template.replace(PLACEHOLDER, (_, name: string) =>
		normalize?.[name] === "text" ? encodeURIComponent(values[name] ?? "") : (values[name] ?? ""),
	);

/** How the owner reads an object's name: "purrgrammer/banda #34". */
export const nameOf = (ref: ObjectRef, kinds: ObjectKinds) => fill(kinds[ref.kind]?.name ?? ref.kind, ref.values);

/**
 * What `text` names, a URL, an id or a ref's canonical words, among `connections`' objects: each kind it can be, in the
 * order the files declare them (`owner/repo#34` may be a pull request or an issue: the first that reads is it).
 */
export function recognise(
	text: string,
	connections: readonly { readonly name: string; readonly objects?: ObjectKinds | undefined }[],
): ObjectRef[] {
	const found: ObjectRef[] = [];
	const trimmed = text.trim();
	if (trimmed.length > 500) return found;
	const canonical = /^([a-z][a-z0-9-]{0,63}):([a-z][a-z0-9_]{0,63}):(.+)$/.exec(trimmed);
	for (const connection of connections)
		for (const [kind, shape] of Object.entries(connection.objects ?? {})) {
			if (canonical !== null) {
				if (canonical[1] !== connection.name || canonical[2] !== kind) continue;
				const values = matchOne(shape.ids[0] ?? shape.urls[0] ?? "", canonical[3] ?? "", shape.ids.length === 0, shape);
				if (values !== undefined) found.push({ connection: connection.name, kind, values });
				continue;
			}
			for (const [template, url] of [
				...shape.urls.map((each) => [each, true] as const),
				...shape.ids.map((each) => [each, false] as const),
			]) {
				const values = matchOne(template, trimmed, url, shape);
				if (values === undefined) continue;
				found.push({ connection: connection.name, kind, values });
				break;
			}
		}
	return found;
}

function matchOne(
	template: string,
	text: string,
	url: boolean,
	kind: ObjectKind,
): { [placeholder: string]: string } | undefined {
	// WHATWG parsing matches navigation semantics, including encoded dot segments and backslashes.
	const input = url ? webUrl(text) : text;
	if (input === undefined) return undefined;
	const match = patternOf(template, url, kind.normalize).exec(input);
	if (match === null) return undefined;
	const names = placeholders(template);
	const values: { [placeholder: string]: string } = {};
	for (const [i, name] of names.entries()) {
		const value = match[i + 1] ?? "";
		const decoded = kind.normalize?.[name] === "text" ? textOf(value) : value;
		if (decoded === undefined) return undefined;
		values[name] = decoded;
	}
	// a reply's link carries its thread's first message: the reply and its thread are one object
	if (url)
		for (const name of names)
			if (kind.normalize?.[name] === "slack-ts") {
				const thread = new URL(input).searchParams.get("thread_ts");
				if (thread !== null) values[name] = thread;
			}
	return normalizeValues(values, kind.normalize);
}

function normalizeValues(
	values: ObjectRef["values"],
	rules: ObjectKind["normalize"],
): { [placeholder: string]: string } | undefined {
	const normalized: { [placeholder: string]: string } = {};
	for (const [name, value] of Object.entries(values)) {
		if (reserved(name)) return undefined;
		if (rules?.[name] === "text") {
			const words = value.replace(/\s+/g, " ").trim();
			if (!TEXT_VALUE.test(words)) return undefined;
			normalized[name] = words;
			continue;
		}
		if (!new RegExp(`^${VALUE}$`).test(value) || value.includes("..")) return undefined;
		switch (rules?.[name]) {
			case "integer":
				if (!/^\d+$/.test(value) || /^0+$/.test(value)) return undefined;
				normalized[name] = value.replace(/^0+/, "");
				break;
			case "lowercase":
				normalized[name] = value.toLowerCase();
				break;
			case "slack-ts": {
				const stamp = slackTs(value);
				if (stamp === undefined) return undefined;
				normalized[name] = stamp;
				break;
			}
			default:
				normalized[name] = value;
		}
	}
	return normalized;
}

/**
 * A read's arguments for `ref`: each `{placeholder}` filled; a value that is one placeholder alone becomes a number
 * where the tool's schema, as its server listed it, says the argument is one.
 */
export function readArgs(read: ObjectRead, ref: ObjectRef, schema: JsonObject | undefined): JsonObject {
	const properties = (schema?.properties ?? {}) as { [arg: string]: { type?: unknown } | undefined };
	const args: JsonObject = {};
	for (const [arg, value] of Object.entries(read.args)) {
		if (typeof value !== "string") {
			args[arg] = Array.isArray(value) ? [...value] : (value as JsonValue);
			continue;
		}
		const filled = fill(value, ref.values);
		const type = properties[arg]?.type;
		const numeric = type === "number" || type === "integer";
		args[arg] = numeric && /^\{[a-z_]+\}$/.test(value) && /^\d{1,15}$/.test(filled) ? Number(filled) : filled;
	}
	return args;
}

/** The object a write's draft acts on, from its arguments: each kind it may be, and its words; none when it names none. */
/**
 * The object a call of the read `tool` is about, when a kind reads it with those arguments, and the arguments that name
 * it: an approval for a read the owner set to Ask draws the thing, not its ids.
 */
export function readOn(
	connection: string,
	tool: string,
	args: JsonObject,
	kinds: ObjectKinds,
): { readonly ref: ObjectRef; readonly args: readonly string[] } | undefined {
	for (const [kind, shape] of Object.entries(kinds))
		for (const read of Object.values(shape.reads)) {
			if (read.tool !== tool) continue;
			const values: { [placeholder: string]: string } = {};
			const used: string[] = [];
			for (const [arg, template] of Object.entries(read.args ?? {})) {
				const placeholder = typeof template === "string" ? /^\{(\w+)\}$/.exec(template)?.[1] : undefined;
				if (placeholder === undefined) continue;
				const value = args[arg];
				if ((typeof value === "string" || typeof value === "number") && new RegExp(`^${VALUE}$`).test(String(value))) {
					values[placeholder] = String(value);
					used.push(arg);
				}
			}
			const placeholders = Object.values(read.args ?? {}).filter(
				(each) => typeof each === "string" && /^\{\w+\}$/.test(each),
			);
			if (used.length === 0 || used.length !== placeholders.length) continue;
			const normalized = normalizeValues(values, shape.normalize);
			if (normalized !== undefined) return { ref: { connection, kind, values: normalized }, args: used };
		}
	return undefined;
}

export function draftedOn(
	connection: string,
	tool: string,
	args: JsonObject,
	kinds: ObjectKinds,
): { readonly refs: ObjectRef[]; readonly verb: string; readonly what: string; readonly text?: string } | undefined {
	const refs: ObjectRef[] = [];
	let words: { verb: string; what: string; text?: string } | undefined;
	for (const [kind, shape] of Object.entries(kinds))
		for (const write of shape.writes ?? []) {
			if (write.tool !== tool) continue;
			const values: { [placeholder: string]: string } = {};
			for (const [placeholder, arg] of Object.entries(write.id)) {
				const value = args[arg];
				if ((typeof value === "string" || typeof value === "number") && new RegExp(`^${VALUE}$`).test(String(value)))
					values[placeholder] = String(value);
			}
			if (Object.keys(values).length !== Object.keys(write.id).length) continue;
			const normalized = normalizeValues(values, shape.normalize);
			if (normalized === undefined) continue;
			refs.push({ connection, kind, values: normalized });
			if (words === undefined) {
				const other = write.verbs?.find((each) =>
					Object.entries(each.when).every(([arg, value]) => args[arg] === value),
				);
				const verb = other?.verb ?? write.verb;
				words = {
					verb,
					what: other?.what ?? (other === undefined ? write.what : undefined) ?? verb,
					...(write.text === undefined ? {} : { text: write.text }),
				};
			}
		}
	return words === undefined ? undefined : { refs, ...words };
}

/**
 * The words of a write's draft that makes an object, from its arguments: the first of the connection's creates that
 * matches, with every argument its words name; none otherwise.
 */
export function draftedCreate(
	tool: string,
	args: JsonObject,
	kinds: ObjectKinds,
): { readonly verb: string; readonly what: string; readonly text?: string } | undefined {
	for (const shape of Object.values(kinds))
		for (const create of shape.creates ?? []) {
			if (create.tool !== tool) continue;
			if (!Object.entries(create.when ?? {}).every(([arg, value]) => args[arg] === value)) continue;
			const values: { [placeholder: string]: string } = {};
			for (const [placeholder, arg] of Object.entries(create.in)) {
				const value = args[arg];
				if ((typeof value === "string" || typeof value === "number") && new RegExp(`^${VALUE}$`).test(String(value)))
					values[placeholder] = String(value);
			}
			if (Object.keys(values).length !== Object.keys(create.in).length) continue;
			return {
				verb: create.verb,
				what: fill(create.what, values),
				...(create.text === undefined ? {} : { text: create.text }),
			};
		}
	return undefined;
}

/** The text arguments a connection's write lets the owner edit, as its objects declare them. */
export function editableOf(tool: string, kinds: ObjectKinds | undefined): string[] {
	const found = new Set<string>();
	for (const shape of Object.values(kinds ?? {}))
		for (const write of [...(shape.writes ?? []), ...(shape.creates ?? [])])
			if (write.tool === tool && write.text !== undefined) found.add(write.text);
	return [...found];
}

// ---- the cards

export type PullRequestCard = {
	readonly card: "pull-request";
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly state: "open" | "draft" | "merged" | "closed" | "unknown";
	readonly author: string;
	readonly branch: string;
	readonly checks: { readonly passed: number; readonly failed: number; readonly running: number } | null;
	readonly reviews: string;
	readonly added: number | null;
	readonly removed: number | null;
	readonly url?: string;
};

export type IssueCard = {
	readonly card: "issue";
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly state: "open" | "completed" | "not-planned" | "unknown";
	readonly author: string;
	readonly labels: string[];
	readonly comments: number | null;
	readonly assignee?: string;
	readonly url?: string;
};

export type CheckRunCard = {
	readonly card: "check-run";
	readonly repo: string;
	readonly name: string;
	readonly state: "queued" | "running" | "passed" | "failed" | "cancelled" | "skipped" | "neutral" | "unknown";
	/** Where it ran: a branch, a workflow. */
	readonly where?: string;
	/** The step that failed, or runs now. */
	readonly step?: string;
	readonly took?: string;
	readonly url?: string;
};

/** Why a notification came, said plainly. */
export type Reason = "review-requested" | "mention" | "assigned" | "ci" | "comment" | "activity";

export type NotificationCard = {
	readonly card: "notification";
	readonly reason: Reason;
	readonly unread: boolean;
	/** When it came (ms). */
	readonly at?: number;
	/** Its subject's title, as the notification says it. */
	readonly title: string;
	/** Its subject, by the URL the notification gives: drawn as its own card. */
	readonly subject?: string;
};

/** A discussion: open, answered or closed, in its category, with how many comments when they were read. */
export type DiscussionCard = {
	readonly card: "discussion";
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly state: "open" | "answered" | "closed" | "unknown";
	readonly category: string;
	readonly comments: number | null;
	readonly url?: string;
};

/** One pull request or issue as a repository's card names it: its number, title, author and state. */
export type Opened = {
	readonly number: number;
	readonly title: string;
	readonly author: string;
	readonly state: "open" | "draft" | "merged" | "closed";
};

/** A repository: what is newest in it. */
export type RepositoryCard = {
	readonly card: "repository";
	/** `owner/repo`. */
	readonly repo: string;
	/** The newest published release's tag, and when (ms). */
	readonly release?: string;
	readonly released?: number;
	/** The default branch's head commit: its first line, its short sha, and when (ms). */
	readonly commit?: string;
	readonly sha?: string;
	readonly committed?: number;
	/** The newest pull request and issue. */
	readonly pull?: Opened;
	readonly issue?: Opened;
	readonly url?: string;
};

export type EmailCard = {
	readonly card: "email";
	readonly from: string;
	readonly to: string;
	readonly subject: string;
	readonly date: string;
	readonly snippet: string;
	readonly body: string;
	/** JSON-encoded flat attachment metadata, kept scalar to respect the store's bounded JSON shape. */
	readonly attachmentManifest: string;
	readonly unread: boolean;
	readonly url?: string;
};

/** One message of a list, as a list says it: an email by its subject, a Slack message by its text. */
export type MessageLine = {
	readonly id: string;
	readonly from: string;
	readonly subject: string;
	readonly date: string;
	/** A chat message's words, plain; an email has its subject instead. */
	readonly text?: string;
};

/** Emails together: a conversation's (titled by its subject) or a search's (titled by its query), the newest first. */
export type MessagesCard = {
	readonly card: "messages";
	readonly title: string;
	/** A search's: its title is the query. */
	readonly search: boolean;
	/** The newest few. */
	readonly messages: MessageLine[];
	/** How many there are in all, as the service says (a search's is its estimate). */
	readonly total: number | null;
	/** Where it opens: in Gmail, the conversation by its id or the search by its query; in Slack, the thread or channel. */
	readonly url?: string;
	/** A Slack list's: a thread (titled by its first message, in its channel), a channel (its topic, its members) or a search. */
	readonly service?: "slack";
	readonly place?: "thread" | "channel";
	readonly channel?: string;
	readonly topic?: string;
	readonly members?: number | null;
};

/** How many emails a list's card shows. */
export const MESSAGES_SHOWN = 5;

/** A calendar event, every value scalar so the store's bounded JSON shape holds. */
export type EventCard = {
	readonly card: "event";
	readonly title: string;
	/** As the calendar gives it: a date for an all-day event, else a date-time. */
	readonly start: string;
	readonly end: string;
	readonly allDay: boolean;
	readonly timeZone: string;
	readonly location: string;
	readonly organizer: string;
	/** The first few guests and how many more: "Ana, Mira +3". */
	readonly who: string;
	readonly attendees: number | null;
	readonly response: "accepted" | "declined" | "tentative" | "needs-action" | "none";
	readonly status: "confirmed" | "tentative" | "cancelled";
	readonly description: string;
	readonly meet?: string;
	readonly url?: string;
};

/** A person from the owner's contacts, or from the people they have emailed (`other`). */
export type ContactCard = {
	readonly card: "contact";
	readonly name: string;
	/** Comma-separated, the primary first. */
	readonly emails: string;
	readonly phones: string;
	readonly organization: string;
	/** Their job title. */
	readonly title: string;
	readonly other: boolean;
	readonly photo?: string;
	readonly url?: string;
	/** A Slack person's: their handle, status and time zone, and whether they are of another team. */
	readonly service?: "slack";
	readonly handle?: string;
	readonly status?: string;
	readonly timezone?: string;
	readonly outside?: boolean;
};

/** A file in a drive, every value scalar so the store's bounded JSON shape holds. */
export type FileCard = {
	readonly card: "file";
	readonly name: string;
	readonly kind: "doc" | "sheet" | "slides" | "pdf" | "folder" | "image" | "file";
	readonly mimeType: string;
	readonly owner: string;
	/** When it last changed, as the drive gives it. */
	readonly modified: string;
	/** Its bytes; null for a Google Doc, Sheet or Slides deck, which have none of their own. */
	readonly size: number | null;
	readonly description: string;
	/** Only the drive's own page for it (docs.google.com or drive.google.com). */
	readonly url?: string;
};

export type ObjectCard =
	| PullRequestCard
	| IssueCard
	| CheckRunCard
	| NotificationCard
	| DiscussionCard
	| RepositoryCard
	| EmailCard
	| MessagesCard
	| EventCard
	| ContactCard
	| FileCard;

/** A plain line: no control or invisible characters, one space for each run of spaces, bounded. */
export function plainLine(value: unknown, max = 200): string {
	if (typeof value !== "string") return "";
	const visible = value
		.normalize("NFKC")
		.replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, "")
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = [...visible];
	return characters.length <= max ? visible : `${characters.slice(0, max - 1).join("")}…`;
}

/** Plain email body, keeping paragraph breaks while stripping invisible and control characters. */
function plainBody(value: unknown, max = 2000): string {
	if (typeof value !== "string") return "";
	return [
		...value
			.normalize("NFKC")
			.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, (char) => ("\n\r\t".includes(char) ? char : " ")),
	]
		.slice(0, max)
		.join("");
}

const count = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const loginOf = (value: unknown) =>
	plainLine(typeof value === "object" && value !== null ? (value as { login?: unknown }).login : value, 60);
const webUrl = (value: unknown) => {
	if (typeof value !== "string" || value.length > 500) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
};

/** The value at a dotted path of what the reads answered. */
function at(answers: { readonly [as: string]: unknown }, path: string | undefined): unknown {
	if (path === undefined) return undefined;
	let value: unknown = answers;
	for (const part of path.split(".")) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (!Object.hasOwn(value, part)) return undefined;
		value = (value as { [key: string]: unknown })[part];
	}
	return value;
}

const duration = (from: unknown, to: unknown): string | undefined => {
	const start = typeof from === "string" ? Date.parse(from) : Number.NaN;
	const end = typeof to === "string" ? Date.parse(to) : Number.NaN;
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
	const seconds = Math.round((end - start) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};

/** A check's state as a card says it, from its status and conclusion as GitHub (or a service like it) gives them. */
function checkState(status: unknown, conclusion: unknown): CheckRunCard["state"] {
	const s = typeof status === "string" ? status.toLowerCase() : "";
	const c = typeof conclusion === "string" ? conclusion.toLowerCase() : "";
	if (c === "success") return "passed";
	if (["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(c)) return "failed";
	if (c === "cancelled" || c === "skipped" || c === "neutral") return c;
	if (s === "in_progress" || s === "running") return "running";
	if (["queued", "waiting", "pending", "requested"].includes(s)) return "queued";
	return "unknown";
}

/** The reviews' last word per reviewer, in words: "Approved by ana", "ana requested changes", "None yet". */
function reviewWords(value: unknown): string {
	if (!Array.isArray(value)) return "Reviews unavailable";
	if (value.length >= 100) return "Reviews incomplete";
	const last = new Map<string, string>();
	for (const review of value) {
		const who = loginOf((review as { user?: unknown } | null)?.user);
		const state = String((review as { state?: unknown } | null)?.state ?? "").toUpperCase();
		if (who === "" || !["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(state))
			return "Reviews unavailable";
		if (state === "PENDING" || (state === "COMMENTED" && last.has(who))) continue;
		last.set(who, state);
	}
	const changes = [...last].filter(([, s]) => s === "CHANGES_REQUESTED").map(([who]) => who);
	const approved = [...last].filter(([, s]) => s === "APPROVED").map(([who]) => who);
	const commented = [...last].filter(([, s]) => s === "COMMENTED").map(([who]) => who);
	if (changes.length > 0) return `${changes.slice(0, 2).join(" and ")} requested changes`;
	if (approved.length > 0) return `Approved by ${approved.slice(0, 2).join(" and ")}`;
	if (commented.length > 0) return `Commented on by ${commented.slice(0, 2).join(" and ")}`;
	return "None yet";
}

/**
 * A list of emails as its card says it: titled by the `title` field (a conversation's subject) or, without one, by the
 * kind's name (a search's query); the newest few by date first.
 */
function messagesCard(kind: ObjectKind, ref: ObjectRef, field: (name: string) => unknown): MessagesCard {
	const list = field("messages");
	if (!Array.isArray(list)) throw new Error("Incomplete object");
	const search = kind.fields.title === undefined;
	const title = search ? plainLine(fill(kind.name, ref.values), 300) : plainLine(field("title"), 300);
	const when = (date: string) => {
		const ms = Date.parse(date);
		return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
	};
	const messages = list
		.flatMap((each): MessageLine[] => {
			if (!plain(each) || typeof each.id !== "string" || each.id.length > 200) return [];
			return [
				{
					id: each.id,
					from: plainLine(each.from, 250),
					subject: plainLine(each.subject, 300),
					date: plainLine(each.date, 100),
				},
			];
		})
		.map((each, i) => ({ each, i }))
		// newest first by date; one without a date keeps its place among those that have none
		.sort((a, b) => when(b.each.date) - when(a.each.date) || (search ? a.i - b.i : b.i - a.i))
		.slice(0, MESSAGES_SHOWN)
		.map(({ each }) => each);
	// Gmail opens a conversation by its id and a search by its query, both from the first account's mailbox
	const url = webUrl(
		search
			? `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(ref.values.query ?? "")}`
			: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(ref.values.id ?? "")}`,
	);
	return {
		card: "messages",
		title: title || (search ? "Search" : "(No subject)"),
		search,
		messages,
		total: count(field("total")),
		...(url === undefined ? {} : { url }),
	};
}

/** A Slack page worth linking: the team's own host, `<team>.slack.com`, over https. */
const slackUrl = (value: unknown) => {
	const url = webUrl(value);
	return url !== undefined && new URL(url).port === "" && /^[a-z0-9-]{1,63}\.slack\.com$/.test(new URL(url).hostname)
		? url
		: undefined;
};

/** A channel as the owner reads it: `#general`, or a direct message's `@bob`. */
const channelTitle = (name: string) => (name === "" || name.startsWith("@") ? name : `#${name}`);

/**
 * A Slack thread, channel or search as its card says it: the newest few messages first, each its author's handle and its
 * text as one plain line. A thread (a kind with a `root`) is titled by its first message's words, in its channel; a
 * channel (a kind with a `title`) by its name, with its topic and members; a search by its query.
 */
function slackMessagesCard(kind: ObjectKind, ref: ObjectRef, field: (name: string) => unknown): MessagesCard {
	const list = field("messages");
	if (!Array.isArray(list)) throw new Error("Incomplete object");
	const place = kind.fields.root !== undefined ? "thread" : kind.fields.title !== undefined ? "channel" : undefined;
	const search = place === undefined;
	const all = list
		.flatMap((each): MessageLine[] => {
			if (!plain(each) || typeof each.ts !== "string" || !/^\d{9,11}\.\d{6}$/.test(each.ts)) return [];
			return [
				{
					id: each.ts,
					from: plainLine(each.from, 120),
					subject: "",
					date: plainLine(each.date, 40),
					text: plainLine(each.text, 300),
				},
			];
		})
		.sort((a, b) => Number(b.id) - Number(a.id));
	const root = field("root");
	const first = all.find((each) => each.id === root) ?? all.at(-1);
	const channel = channelTitle(
		plainLine(place === "thread" ? field("channel") : field("title"), 200) || plainLine(ref.values.channel, 60),
	);
	const title = search
		? plainLine(ref.values.query ?? fill(kind.name, ref.values), 300)
		: place === "thread"
			? plainLine(first?.text, 120)
			: channel;
	const url = slackUrl(field("url"));
	return {
		card: "messages",
		title: title || (search ? "Search" : place === "thread" ? "Thread" : "Slack"),
		search,
		messages: all.slice(0, MESSAGES_SHOWN),
		total: count(field("total")),
		...(url === undefined ? {} : { url }),
		service: "slack",
		...(place === undefined ? {} : { place }),
		...(place === "thread" ? { channel } : {}),
		...(place === "channel" ? { topic: plainLine(field("topic"), 300), members: count(field("members")) } : {}),
	};
}

/** A person in Slack as the contact card says them: name, handle, title, status, time zone, and email when shared. */
function slackPersonCard(field: (name: string) => unknown): ContactCard {
	const handle = plainLine(field("handle"), 100);
	const url = slackUrl(field("url"));
	return {
		card: "contact",
		name: plainLine(field("name")) || (handle === "" ? "(No name)" : `@${handle}`),
		emails: plainLine(field("emails"), 300),
		phones: "",
		organization: "",
		title: plainLine(field("title"), 200),
		other: false,
		...(url === undefined ? {} : { url }),
		service: "slack",
		...(handle === "" ? {} : { handle: `@${handle}` }),
		status: plainLine(field("status"), 200),
		timezone: plainLine(field("timezone"), 100),
		outside: field("outside") === true,
	};
}

const REASONS: { readonly [reason: string]: Reason } = {
	review_requested: "review-requested",
	mention: "mention",
	team_mention: "mention",
	assign: "assigned",
	ci_activity: "ci",
	comment: "comment",
};

/**
 * The card a kind draws from what its reads answered (each read's answer parsed as JSON, by its name): the daemon's
 * own rendering, every string a plain line. The repo and number come from the ref when the answer does not say them.
 */
export function cardOf(
	kind: ObjectKind,
	ref: ObjectRef,
	answers: { readonly [as: string]: unknown },
	/** The built-in API that read it, when one did: Slack's lists and people are drawn as Slack's. */
	api?: string,
): ObjectCard {
	const field = (name: string) => at(answers, kind.fields[name]);
	if (kind.card === "messages")
		return api === "slack" ? slackMessagesCard(kind, ref, field) : messagesCard(kind, ref, field);
	if (kind.card === "contact" && api === "slack") return slackPersonCard(field);
	const titleField =
		kind.card === "check-run" || kind.card === "contact" || kind.card === "file"
			? "name"
			: kind.card === "email"
				? "subject"
				: "title";
	// a person may have no name: the card names them by address; a repository is named by its ref
	if (
		kind.card !== "repository" &&
		(typeof field(titleField) !== "string" || (kind.card !== "contact" && plainLine(field(titleField)) === ""))
	)
		throw new Error("Incomplete object");
	const repo = plainLine(field("repo"), 100) || plainLine(`${ref.values.owner ?? ""}/${ref.values.repo ?? ""}`, 100);
	const number = count(field("number")) || Number(ref.values.number ?? 0) || 0;
	const url = webUrl(field("url"));
	const withUrl = url === undefined ? {} : { url };
	switch (kind.card) {
		case "pull-request": {
			const state = String(field("state") ?? "").toLowerCase();
			const runs = Array.isArray(field("checks")) ? (field("checks") as unknown[]) : [];
			const checks = { passed: 0, failed: 0, running: 0 };
			let complete = Array.isArray(field("checks")) && count(field("checks_total")) === runs.length;
			for (const run of runs) {
				const s = checkState(
					(run as { status?: unknown } | null)?.status,
					(run as { conclusion?: unknown } | null)?.conclusion,
				);
				// a skipped or neutral run counts for nothing, as GitHub counts it; a cancelled one did not pass
				if (s === "passed") checks.passed++;
				else if (s === "failed" || s === "cancelled") checks.failed++;
				else if (s === "running" || s === "queued") checks.running++;
				else if (s === "unknown") complete = false;
			}
			return {
				card: "pull-request",
				repo,
				number,
				title: plainLine(field("title")),
				state:
					field("merged") === true || state === "merged"
						? "merged"
						: state === "closed"
							? "closed"
							: field("draft") === true
								? "draft"
								: state === "open"
									? "open"
									: "unknown",
				author: loginOf(field("author")),
				branch: plainLine(field("branch"), 100),
				checks: complete ? checks : null,
				reviews: reviewWords(field("reviews")),
				added: count(field("added")),
				removed: count(field("removed")),
				...withUrl,
			};
		}
		case "issue": {
			const state = String(field("state") ?? "").toLowerCase();
			const reason = String(field("reason") ?? "").toLowerCase();
			const labels = (Array.isArray(field("labels")) ? (field("labels") as unknown[]) : [])
				.map((label) =>
					plainLine(typeof label === "object" && label !== null ? (label as { name?: unknown }).name : label, 40),
				)
				.filter((label) => label !== "")
				.slice(0, 8);
			const assignees = Array.isArray(field("assignees")) ? (field("assignees") as unknown[]) : [];
			const assignee = assignees.map(loginOf).find((each) => each !== "");
			return {
				card: "issue",
				repo,
				number,
				title: plainLine(field("title")),
				state:
					state === "closed"
						? reason === "not_planned" || reason === "duplicate"
							? "not-planned"
							: "completed"
						: state === "open"
							? "open"
							: "unknown",
				author: loginOf(field("author")),
				labels,
				comments: count(field("comments")),
				...(assignee === undefined ? {} : { assignee }),
				...withUrl,
			};
		}
		case "check-run": {
			const state = checkState(field("status"), field("conclusion"));
			const steps = Array.isArray(field("steps")) ? (field("steps") as unknown[]) : [];
			const step = steps.find((each) => {
				const s = checkState(
					(each as { status?: unknown } | null)?.status,
					(each as { conclusion?: unknown } | null)?.conclusion,
				);
				return state === "failed" ? s === "failed" : state === "running" ? s === "running" : false;
			});
			const stepName = plainLine((step as { name?: unknown } | undefined)?.name, 100);
			const took = state === "queued" ? undefined : duration(field("started"), field("completed"));
			const where = plainLine(field("where"), 100);
			return {
				card: "check-run",
				repo,
				name: plainLine(field("name"), 100) || "check",
				state,
				...(where === "" ? {} : { where }),
				...(stepName === "" ? {} : { step: stepName }),
				...(took === undefined ? {} : { took }),
				...withUrl,
			};
		}
		case "notification": {
			const when = typeof field("at") === "string" ? Date.parse(field("at") as string) : Number.NaN;
			const subject = typeof field("subject") === "string" ? (field("subject") as string) : undefined;
			return {
				card: "notification",
				reason: REASONS[String(field("reason") ?? "")] ?? "activity",
				unread: field("unread") !== false,
				...(Number.isFinite(when) ? { at: when } : {}),
				title: plainLine(field("title")),
				...(subject === undefined || subject.length > 500 ? {} : { subject }),
			};
		}
		case "discussion":
			return {
				card: "discussion",
				repo,
				number,
				title: plainLine(field("title")),
				state:
					field("closed") === true
						? "closed"
						: field("answered") === true
							? "answered"
							: field("closed") === false
								? "open"
								: "unknown",
				category: plainLine(field("category"), 60),
				comments: count(field("comments")),
				...withUrl,
			};
		case "repository": {
			// its pull requests are the read every repository answers: without them it was not read
			if (!Array.isArray(field("pulls"))) throw new Error("Incomplete object");
			const newest = (list: unknown, ok: (item: { [key: string]: unknown }) => boolean = () => true) =>
				(Array.isArray(list) ? list : []).find((item): item is { [key: string]: unknown } => plain(item) && ok(item));
			const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) : Number.NaN);
			const opened = (item: { [key: string]: unknown } | undefined): Opened | undefined => {
				const n = count(item?.number);
				if (item === undefined || n === null || n === 0) return undefined;
				const state = String(item.state ?? "").toLowerCase();
				return {
					number: n,
					title: plainLine(item.title),
					author: loginOf(item.user),
					state:
						item.merged === true || state === "merged"
							? "merged"
							: state === "closed"
								? "closed"
								: item.draft === true
									? "draft"
									: "open",
				};
			};
			const release = newest(field("releases"), (each) => each.draft !== true && typeof each.tag_name === "string");
			const head = newest(field("commits"));
			const message = plainLine(
				String((head?.commit as { message?: unknown } | undefined)?.message ?? "").split("\n")[0],
				120,
			);
			const sha = typeof head?.sha === "string" && /^[0-9a-f]{7,64}$/.test(head.sha) ? head.sha.slice(0, 7) : "";
			const by = head?.commit as { committer?: { date?: unknown }; author?: { date?: unknown } } | undefined;
			const committed = time(by?.committer?.date ?? by?.author?.date);
			const released = time(release?.published_at);
			const pull = opened(newest(field("pulls")));
			const issue = opened(newest(field("issues")));
			const own = webUrl(`https://github.com/${ref.values.owner ?? ""}/${ref.values.repo ?? ""}`);
			return {
				card: "repository",
				repo,
				...(release === undefined ? {} : { release: plainLine(release.tag_name, 100) }),
				...(Number.isFinite(released) ? { released } : {}),
				...(message === "" ? {} : { commit: message }),
				...(sha === "" ? {} : { sha }),
				...(Number.isFinite(committed) ? { committed } : {}),
				...(pull === undefined ? {} : { pull }),
				...(issue === undefined ? {} : { issue }),
				...(own === undefined ? {} : { url: own }),
			};
		}
		case "email":
			return {
				card: "email",
				from: plainLine(field("from"), 250),
				to: plainLine(field("to"), 250),
				subject: plainLine(field("subject"), 300),
				date: plainLine(field("date"), 100),
				snippet: plainLine(field("snippet"), 300),
				body: plainBody(field("body")),
				attachmentManifest: JSON.stringify(
					(Array.isArray(field("attachments")) ? (field("attachments") as unknown[]) : [])
						.slice(0, 20)
						.flatMap((item) => {
							if (!plain(item) || typeof item.id !== "string" || item.id.length > 500 || typeof item.name !== "string")
								return [];
							const name = plainLine(item.name, 120);
							const size = count(item.size);
							if (name === "" || size === null) return [];
							return [
								{
									id: item.id,
									name,
									mimeType: plainLine(item.mimeType, 120) || "application/octet-stream",
									size,
								},
							];
						}),
				),
				unread: field("unread") === true,
				...withUrl,
			};
		case "event": {
			const response = String(field("response") ?? "");
			const status = String(field("status") ?? "");
			const meet = webUrl(field("meet"));
			return {
				card: "event",
				title: plainLine(field("title"), 300),
				start: plainLine(field("start"), 40),
				end: plainLine(field("end"), 40),
				allDay: field("all_day") === true,
				timeZone: plainLine(field("time_zone"), 100),
				location: plainLine(field("location"), 300),
				organizer: plainLine(field("organizer"), 250),
				who: plainLine(field("who"), 250),
				attendees: count(field("attendees")),
				response:
					(["accepted", "declined", "tentative", "needs-action"] as const).find((each) => each === response) ?? "none",
				status: (["tentative", "cancelled"] as const).find((each) => each === status) ?? "confirmed",
				description: plainBody(field("description"), 1000),
				...(meet === undefined ? {} : { meet }),
				...withUrl,
			};
		}
		case "contact": {
			const joined = (value: unknown, max: number) =>
				plainLine(Array.isArray(value) ? value.filter((each) => typeof each === "string").join(", ") : value, max);
			const emails = joined(field("emails"), 300);
			const other = field("other") === true;
			// a photo is fetched as the card draws it: only Google's own photo host
			const given = webUrl(field("photo"));
			const photo =
				given !== undefined && /(^|\.)googleusercontent\.com$/.test(new URL(given).hostname) ? given : undefined;
			return {
				card: "contact",
				name: plainLine(field("name")) || plainLine(emails.split(",")[0]) || "(No name)",
				emails,
				phones: joined(field("phones"), 200),
				organization: plainLine(field("organization"), 200),
				title: plainLine(field("title"), 200),
				other,
				...(photo === undefined ? {} : { photo }),
				...(other ? {} : withUrl),
			};
		}
		case "file": {
			const kindWord = String(field("kind") ?? "");
			const page = url === undefined ? undefined : new URL(url);
			const own = page?.port === "" && (page.hostname === "docs.google.com" || page.hostname === "drive.google.com");
			return {
				card: "file",
				name: plainLine(field("name"), 300),
				kind:
					(["doc", "sheet", "slides", "pdf", "folder", "image"] as const).find((each) => each === kindWord) ?? "file",
				mimeType: plainLine(field("mime_type"), 100),
				owner: plainLine(field("owner"), 200),
				modified: plainLine(field("modified"), 40),
				size: count(field("size")),
				description: plainBody(field("description"), 500),
				...(own ? withUrl : {}),
			};
		}
	}
}

// ---- readings

/** One reading of an object: as which account, when, and the card it drew, or why it could not be read. */
export type Reading = {
	readonly connection: string;
	readonly account: string;
	readonly kind: string;
	/** Accepted definition, account generation and listed schemas that produced this reading. */
	readonly source: string;
	readonly at: number;
	readonly card?: ObjectCard;
	readonly failed?: string;
};

/** How many readings the store keeps: the oldest go first. */
export const MAX_READINGS = 300;

/** The readings, by (connection, account, object): `<connection>/<account>/<ref's key>`. */
export const Readings = defineDoc<{ readings: { [key: string]: Reading } }>({
	kind: "banda.readings",
	version: 1,
	scope: "session",
	initial: () => ({ readings: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

export const readingKey = (account: string, key: string) => {
	const [connection = "", ...rest] = key.split(":");
	return `${connection}/${account}/${rest.join(":")}`;
};

/** In `tx`: keep `reading` under `key`, the oldest dropped past the bound. */
export async function keepReading(tx: Tx, key: string, reading: Reading): Promise<void> {
	const doc = await tx.doc(Readings);
	doc.readings[key] = JSON.parse(JSON.stringify(reading)) as Reading;
	const keys = Object.keys(doc.readings);
	if (keys.length <= MAX_READINGS) return;
	const oldest = keys
		.map((each) => [each, doc.readings[each]?.at ?? 0] as const)
		.sort((a, b) => a[1] - b[1])
		.slice(0, keys.length - MAX_READINGS);
	for (const [each] of oldest) delete doc.readings[each];
}

/** In `tx`: forget every reading made as account `account` of connection `connection` (it was signed out). */
export async function forgetReadings(tx: Tx, connection: string, account?: string): Promise<void> {
	const doc = await tx.doc(Readings);
	for (const [key, reading] of Object.entries(doc.readings))
		if (reading.connection === connection && (account === undefined || reading.account === account))
			delete doc.readings[key];
}
