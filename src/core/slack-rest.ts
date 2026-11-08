/**
 * A bounded Slack Web API surface, as the owner (a user token): reads, and posting a message or adding a reaction the
 * owner approved. Tokens
 * are supplied per call by the daemon and never enter a box. Every call goes through `slackBudget`, one queue per
 * (account, method), so a watch, an agent's read and a card's unfurl never hammer Slack between them.
 */
import { createHash } from "node:crypto";
import { boundedBytes, MAX_RESPONSE_BYTES } from "./google-rest.ts";
import { type McpResult, type McpTool, Unauthorized } from "./mcp.ts";
import { type SlackNames, slackAvatar, slackMentions, slackPlain, slackTs } from "./slack-text.ts";

const BASE = "https://slack.com/api";
export const SLACK_WRITES = ["post_message", "add_reaction"] as const;
/** A reaction added twice is the same end state (Slack answers `already_reacted`), so a crash's repeat runs unasked. */
export const SLACK_IDEMPOTENT = ["add_reaction"] as const;
/** The most bytes of a file in Slack the daemon fetches for the owner, as Gmail's attachments. */
export const MAX_SLACK_FILE_BYTES = 10 * 1024 * 1024;
/** An emoji's name as Slack writes it, `thumbsup` or `wave::skin-tone-3`. */
export const SLACK_EMOJI = /^[a-z0-9_+-]{1,100}(?:::skin-tone-\d)?$/;
const FILE = /^F[A-Z0-9]{2,40}$/;
const CHANNEL = /^[CDG][A-Z0-9]{2,40}$/;
const USER = /^[UWB][A-Z0-9]{2,40}$/;
const MAX_TEXT = 4000;
/** How many names one read looks up that the account's cache lacks; the rest stay as their ids. */
const MAX_LOOKUPS = 40;
const ACTIVE_MS = 10 * 60_000;

const tool = (
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[] = [],
): McpTool => ({
	name,
	description,
	inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
	readOnlyHint: !(SLACK_WRITES as readonly string[]).includes(name),
});

const channel = {
	type: "string",
	minLength: 3,
	maxLength: 41,
	description: "A channel's id (C…, G… or D…), as a Slack link or slack/<id> names it",
};
const ts = {
	type: "string",
	minLength: 16,
	maxLength: 18,
	description: "A message's timestamp, 1700000000.000100, or the p1700000000000100 of its link",
};
const naming =
	"Name a thread by its Slack link or slack/<channel>/p<ts>, a channel as slack/<channel>, a person as slack/user/<id>, so the app draws their cards.";

export const SLACK_TOOLS: McpTool[] = [
	tool("whoami", "Read who the owner is in this Slack team: their handle, @name at Team.", {}),
	tool(
		"list_channels",
		`List the channels the owner is a member of, with each one's id, name and whether it is private. Direct and group messages are listed only with types "im,mpim" and when the owner allowed direct messages. ${naming}`,
		{
			types: {
				type: "string",
				maxLength: 60,
				description:
					'Comma-separated: public_channel, private_channel, mpim, im. Default "public_channel,private_channel"',
			},
			limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 100" },
			cursor: { type: "string", maxLength: 500, description: "The next_cursor of the previous page" },
		},
	),
	tool(
		"get_channel",
		`Read one channel: its name, topic, how many members and whether the owner is in it. ${naming}`,
		{ channel },
		["channel"],
	),
	tool(
		"channel_history",
		`Read a channel's newest messages, newest first: who wrote each (@name, a bot marked [bot], someone from another team marked (outside)), its text, when, and whether it mentions the owner. Replies in threads are not here; read a thread with get_thread. ${naming}`,
		{
			channel,
			limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20" },
			cursor: { type: "string", maxLength: 500, description: "The next_cursor of the previous page" },
		},
		["channel"],
	),
	tool(
		"get_thread",
		`Read a message and the replies under it, oldest first. ${naming}`,
		{
			channel,
			ts,
			limit: { type: "integer", minimum: 1, maximum: 100, description: "How many replies; default 100" },
			cursor: { type: "string", maxLength: 500, description: "The next_cursor of the previous page" },
		},
		["channel", "ts"],
	),
	tool(
		"search_messages",
		`Search every message the owner can see, as Slack's own search does (in:#channel, from:@name, words), newest first. Needs the owner to allow direct messages and search. ${naming}`,
		{
			query: { type: "string", minLength: 1, maxLength: 500, description: "What to search for, in Slack's syntax" },
			count: { type: "integer", minimum: 1, maximum: 100, description: "Default 20" },
			sort: { type: "string", enum: ["timestamp", "score"], description: "Default timestamp" },
			sort_dir: { type: "string", enum: ["desc", "asc"], description: "Default desc" },
		},
		["query"],
	),
	tool(
		"get_person",
		`Read who someone is in Slack: name, title, time zone, status, and email when Slack shares it. ${naming}`,
		{ user: { type: "string", minLength: 3, maxLength: 41, description: "A person's id (U… or W…)" } },
		["user"],
	),
	tool(
		"get_file",
		`Read what a file shared in Slack is: its name, title, type, size and the message it is in. A message's files are listed with their ids in its "files". Needs the owner to allow "Read files you can see"; the file's contents are never given to you, the owner opens it from the message's card.`,
		{
			file_id: {
				type: "string",
				minLength: 3,
				maxLength: 41,
				description: "A file's id (F…), as a message's files list it",
			},
		},
		["file_id"],
	),
	tool(
		"post_message",
		"Post a message in a channel as the owner, or reply in a thread with thread_ts. Mention someone as <@U…>, a channel as <#C…>; <!here> and <!channel> notify everyone. Always asks the owner to approve, every time, showing exactly what will be sent and who it notifies; nothing is sent until they do.",
		{
			channel,
			text: { type: "string", minLength: 1, maxLength: MAX_TEXT, description: "The message, in Slack's mrkdwn" },
			thread_ts: { ...ts, description: "The thread's first message, to reply under it" },
		},
		["channel", "text"],
	),
	tool(
		"add_reaction",
		"React to a message as the owner, with an emoji by its name (thumbsup, eyes, white_check_mark, or a team's own). Asks the owner to approve first, showing the emoji and the message; they may allow more reactions for the task. Adding one already there changes nothing.",
		{
			channel,
			ts,
			name: {
				type: "string",
				minLength: 1,
				maxLength: 115,
				description: "The emoji's name without colons, as Slack writes it: thumbsup, or wave::skin-tone-3",
			},
		},
		["channel", "ts", "name"],
	),
];

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(object) : []);
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
const count = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

// ---- the budget

/** Slack refused for now, by `Retry-After` seconds. */
class RateLimited extends Error {
	readonly seconds: number;
	constructor(seconds: number) {
		super("Slack is busy");
		this.seconds = seconds;
	}
}

/** When a held queue opens again, in the owner's words: "Slack is busy, back at 10:43". */
export class SlackBusy extends Error {
	readonly until: number;
	constructor(until: number) {
		const at = new Date(Math.ceil(until / 60_000) * 60_000);
		super(
			`Slack is busy, back at ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`,
		);
		this.until = until;
	}
}

export type SlackBudget = {
	/** Run `call` in the queue for `key`, after every call before it there; a refusal holds the queue. */
	readonly run: <T>(key: string, call: () => Promise<T>) => Promise<T>;
};

/**
 * One queue per (account, method): one call in flight at a time, and a `Retry-After` refusal holds the queue until it
 * passes, every caller meanwhile answered in words at once, never retried in a loop. A queue already `depth` deep
 * answers "try again" rather than growing.
 */
export function slackBudget(now: () => number = Date.now, depth = 8): SlackBudget {
	const queues = new Map<string, { tail: Promise<unknown>; waiting: number; until: number }>();
	return {
		run: <T>(key: string, call: () => Promise<T>): Promise<T> => {
			let queue = queues.get(key);
			if (queue === undefined) {
				queue = { tail: Promise.resolve(), waiting: 0, until: 0 };
				queues.set(key, queue);
			}
			const held = queue;
			if (held.until > now()) return Promise.reject(new SlackBusy(held.until));
			if (held.waiting >= depth) return Promise.reject(new Error("Slack is busy, try again in a moment"));
			held.waiting++;
			const ran = held.tail.then(async () => {
				if (held.until > now()) throw new SlackBusy(held.until);
				try {
					return await call();
				} catch (error) {
					if (!(error instanceof RateLimited)) throw error;
					held.until = now() + error.seconds * 1000;
					throw new SlackBusy(held.until);
				}
			});
			held.tail = ran.then(
				() => undefined,
				() => undefined,
			);
			const done = () => {
				held.waiting--;
				if (held.waiting === 0 && held.until <= now()) queues.delete(key);
			};
			ran.then(done, done);
			return ran;
		},
	};
}

/** The daemon's one budget: every caller of every account shares it. */
export const SLACK_BUDGET = slackBudget();

// ---- requests

const AUTH = ["invalid_auth", "not_authed", "token_expired", "token_revoked", "account_inactive"];
const REFUSALS: { readonly [code: string]: string } = {
	channel_not_found: "That channel is not one the owner can see in Slack.",
	thread_not_found: "That message is not in Slack, or the owner cannot see it.",
	message_not_found: "That message is not in Slack, or the owner cannot see it.",
	user_not_found: "Slack knows no such person.",
	not_in_channel: "The owner is not in that channel, so Slack will not post there.",
	is_archived: "That channel is archived.",
	msg_too_long: "The message is too long for Slack.",
	no_text: "The message has no text.",
	restricted_action: "Slack's team settings do not let the owner post there.",
	invalid_name: "Slack knows no emoji by that name.",
	too_many_emoji: "That message has as many different reactions as Slack allows.",
	too_many_reactions: "That message has as many reactions as Slack allows.",
	file_not_found: "That file is not in Slack, or the owner cannot see it.",
	file_deleted: "That file was deleted.",
};

/** One request to Slack's Web API: an answer whose `ok` is true, or a refusal in words. */
async function slackRequest(
	token: string,
	method: string,
	params: Record<string, string | number | boolean | undefined>,
	post: boolean,
	signal: AbortSignal | undefined,
	fetcher: typeof fetch,
	fine: readonly string[] = [],
): Promise<Json> {
	const url = new URL(`${BASE}/${method}`);
	const given = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
	if (!post) for (const [key, value] of Object.entries(given)) url.searchParams.set(key, String(value));
	const response = await fetcher(url.toString(), {
		method: post ? "POST" : "GET",
		redirect: "error",
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/json",
			...(post ? { "content-type": "application/json; charset=utf-8" } : {}),
		},
		...(post ? { body: JSON.stringify(given) } : {}),
		...(signal === undefined ? {} : { signal }),
	});
	if (response.status === 429) {
		await response.body?.cancel();
		const seconds = Number(response.headers.get("retry-after"));
		throw new RateLimited(Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3600) : 60);
	}
	if (response.status === 401) {
		await response.body?.cancel();
		throw new Unauthorized("Slack did not take the credentials");
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Slack answered ${response.status}`);
	}
	const { bytes } = await boundedBytes(response, "Slack", MAX_RESPONSE_BYTES, false);
	let body: Json;
	try {
		body = object(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
	} catch {
		throw new Error("Slack answered something that is not JSON");
	}
	if (body.ok === true) return body;
	const code = typeof body.error === "string" && /^[a-z0-9_]{1,80}$/.test(body.error) ? body.error : "unknown";
	if (fine.includes(code)) return body;
	if (AUTH.includes(code)) throw new Unauthorized("Slack did not take the credentials");
	if (code === "ratelimited") throw new RateLimited(60);
	if (code === "missing_scope") {
		const needed = typeof body.needed === "string" && /^[a-z:,._-]{1,200}$/.test(body.needed) ? body.needed : "";
		throw new Error(
			`The owner did not allow this in Slack${needed === "" ? "" : ` (it needs ${needed})`}: they sign in again and allow it.`,
		);
	}
	throw new Error(REFUSALS[code] ?? `Slack refused (${code}).`);
}

// ---- the account

/** Who a token is: what `auth.test` answered, read once per token. */
type Identity = {
	readonly user: string;
	readonly userId: string;
	readonly team: string;
	readonly teamId: string;
	/** The team's address, `https://acme.slack.com/`. */
	readonly url: string;
};

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const MAX_ACCOUNTS = 64;
const identities = new Map<string, Promise<Identity>>();
/** Names each account has looked up: a user's handle, team and face, a channel's name. */
type Named = { readonly name: string; readonly team?: string; readonly avatar?: string };
const names = new Map<string, Map<string, Named>>();
const MAX_NAMES = 4000;

/** A Map kept to `max` entries, the oldest dropped first. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): V {
	map.delete(key);
	map.set(key, value);
	while (map.size > max) map.delete(map.keys().next().value as K);
	return value;
}

/** A team's own address, only `https://<team>.slack.com/`. */
function teamUrl(value: unknown): string {
	if (typeof value !== "string") return "";
	try {
		const url = new URL(value);
		return url.protocol === "https:" && /^[a-z0-9-]{1,63}\.slack\.com$/.test(url.hostname) && url.port === ""
			? `https://${url.hostname}/`
			: "";
	} catch {
		return "";
	}
}

type Call = (
	method: string,
	params?: Record<string, string | number | boolean | undefined>,
	post?: boolean,
	fine?: readonly string[],
) => Promise<Json>;

/** What one read or write of one account works with: its calls under the budget, who it is, and its names. */
type Session = {
	readonly call: Call;
	readonly me: () => Promise<Identity>;
	readonly lookup: (users: readonly string[], channels: readonly string[]) => Promise<void>;
	readonly named: SlackNames;
	readonly teamOf: (user: string) => string | undefined;
	readonly avatarOf: (user: string) => string | undefined;
};

function session(token: string, signal: AbortSignal | undefined, fetcher: typeof fetch, budget: SlackBudget): Session {
	const tokenKey = hashOf(token);
	const send = (
		key: string,
		method: string,
		params: Record<string, string | number | boolean | undefined>,
		post: boolean,
		fine: readonly string[] = [],
	) => budget.run(`${key}/${method}`, () => slackRequest(token, method, params, post, signal, fetcher, fine));
	const me = (): Promise<Identity> => {
		const known = identities.get(tokenKey);
		if (known !== undefined) return known;
		const asked = send(tokenKey, "auth.test", {}, false).then((body) => {
			const identity = {
				user: text(body.user, 100),
				userId: text(body.user_id, 41),
				team: text(body.team, 200),
				teamId: text(body.team_id, 41),
				url: teamUrl(body.url),
			};
			if (identity.user === "" || identity.userId === "" || identity.teamId === "")
				throw new Error("Slack did not say who signed in.");
			return identity;
		});
		remember(identities, tokenKey, asked, MAX_ACCOUNTS);
		asked.catch(() => identities.delete(tokenKey));
		return asked;
	};
	const accountKey = async () => {
		const identity = await me();
		return `${identity.teamId}/${identity.userId}`;
	};
	const call: Call = async (method, params = {}, post = false, fine = []) =>
		send(await accountKey(), method, params, post, fine);
	let held: Map<string, Named> | undefined;
	const book = async () => {
		if (held !== undefined) return held;
		const key = await accountKey();
		held = names.get(key) ?? remember(names, key, new Map(), MAX_ACCOUNTS);
		return held;
	};
	const lookup = async (users: readonly string[], channels: readonly string[]) => {
		const known = await book();
		const missing = [
			...users.filter((id) => USER.test(id) && !known.has(id)).map((id) => ["user", id] as const),
			...channels.filter((id) => CHANNEL.test(id) && !known.has(id)).map((id) => ["channel", id] as const),
		].slice(0, MAX_LOOKUPS);
		for (const [kind, id] of missing) {
			try {
				if (kind === "user") {
					const user = object((await call("users.info", { user: id })).user);
					const name = text(user.name, 100);
					const avatar = slackAvatar(object(user.profile).image_48);
					const team = text(user.team_id, 41);
					if (name !== "") remember(known, id, { name, team, ...(avatar === undefined ? {} : { avatar }) }, MAX_NAMES);
				} else {
					const found = await channelOf({ call, lookup, named }, id);
					if (found.name !== "") remember(known, id, { name: found.name }, MAX_NAMES);
				}
			} catch (error) {
				// a name that cannot be read stays its id; credentials refused, or Slack busy, stop the read
				if (error instanceof Unauthorized || error instanceof SlackBusy) throw error;
			}
		}
	};
	const named: SlackNames = (kind, id) => {
		const found = held?.get(id)?.name;
		if (found === undefined) return undefined;
		return kind === "user" ? `@${found}` : found.startsWith("@") ? found : `#${found}`;
	};
	return {
		call,
		me,
		lookup,
		named,
		teamOf: (user) => held?.get(user)?.team,
		avatarOf: (user) => held?.get(user)?.avatar,
	};
}

// ---- what reads answer

export type SlackMessage = {
	readonly ts: string;
	readonly from: string;
	/**
	 * Who wrote it in the account's own form, `@ana at Acme`, so the owner's own posts are the account's: someone of
	 * another team by that team's id (never equal to an account), a bot `@deploybot [bot]`.
	 */
	readonly author: string;
	readonly user: string;
	readonly text: string;
	readonly date: string;
	readonly thread_ts?: string;
	readonly reply_count?: number;
	readonly mentions_me: boolean;
	/** Its author's face, a `slack-edge.com` image: absent for a bot without one, or for someone not looked up. */
	readonly avatar?: string;
	/** The emoji people reacted with, and how many did: absent when none. */
	readonly reactions?: readonly SlackReaction[];
	/** The files shared in it: absent when none. Their contents are fetched by the daemon for the owner only. */
	readonly files?: readonly SlackFile[];
};

export type SlackReaction = { readonly name: string; readonly count: number };
export type SlackFile = {
	readonly id: string;
	readonly name: string;
	readonly size: number;
	readonly mimetype: string;
};

/** A file's name as one plain line, without a path or any control or format character. */
const fileName = (value: unknown) =>
	text(value, 200)
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.replace(/[/\\]/g, "_")
		.trim();
const mimeOf = (value: unknown) => {
	const said = text(value, 201);
	return /^[\w.+-]{1,100}\/[\w.+-]{1,100}$/.test(said) ? said : "";
};

const reactionsOf = (value: unknown): SlackReaction[] =>
	list(value)
		.flatMap((raw) => {
			const name = typeof raw.name === "string" && SLACK_EMOJI.test(raw.name) ? raw.name : undefined;
			const many = count(raw.count);
			return name === undefined || many === undefined || many === 0 ? [] : [{ name, count: many }];
		})
		.slice(0, 50);

const filesOf = (value: unknown): SlackFile[] =>
	list(value)
		.flatMap((raw) => {
			const id = typeof raw.id === "string" && FILE.test(raw.id) ? raw.id : undefined;
			if (id === undefined) return [];
			const name = fileName(raw.name) || fileName(raw.title) || id;
			return [{ id, name, size: count(raw.size) ?? 0, mimetype: mimeOf(raw.mimetype) }];
		})
		.slice(0, 20);

export type SlackChannel = {
	readonly id: string;
	readonly name: string;
	readonly topic: string;
	readonly member_count: number | null;
	readonly private: boolean;
	readonly is_member: boolean;
};

const dateOf = (value: string) => {
	const seconds = Number(value);
	return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : "";
};

const botName = (raw: Json) =>
	(text(object(raw.bot_profile).name, 80) || text(raw.username, 80) || "bot").replace(/[\p{Cc}\p{Cf}]/gu, "").trim() ||
	"bot";

/**
 * A message as banda says it: its author a handle, `[bot]` only for a message with no user or Slack's bot subtype (the
 * owner's own posts through banda carry a `bot_id` too), `(outside)` for someone of another team; its text plain.
 */
function messageOf(raw: Json, me: Identity, s: Session): SlackMessage | undefined {
	const stamp = typeof raw.ts === "string" ? slackTs(raw.ts) : undefined;
	if (stamp === undefined) return undefined;
	const user = typeof raw.user === "string" && USER.test(raw.user) ? raw.user : undefined;
	const bot = user === undefined || raw.subtype === "bot_message";
	const team =
		(typeof raw.user_team === "string" ? raw.user_team : undefined) ??
		(user === undefined ? undefined : s.teamOf(user)) ??
		(typeof raw.team === "string" ? raw.team : undefined);
	const outside = !bot && team !== undefined && team !== "" && team !== me.teamId;
	// the owner's own handle is known without a lookup, so their posts are the account's whatever the names cache holds
	const handle =
		user === me.userId
			? `@${me.user}`
			: ((user === undefined ? undefined : s.named("user", user)) ?? `@${text(raw.username, 80) || user}`);
	const from = bot ? `@${botName(raw)} [bot]` : `${handle}${outside ? " (outside)" : ""}`;
	const author = bot ? from : `${handle} at ${outside ? team : me.team}`;
	const said = typeof raw.text === "string" ? raw.text : "";
	const thread = typeof raw.thread_ts === "string" ? slackTs(raw.thread_ts) : undefined;
	const replies = count(raw.reply_count);
	const avatar = bot
		? slackAvatar(object(object(raw.bot_profile).icons).image_48 ?? object(raw.icons).image_48)
		: user === undefined
			? undefined
			: s.avatarOf(user);
	const reactions = reactionsOf(raw.reactions);
	const files = filesOf(raw.files);
	return {
		ts: stamp,
		from,
		author,
		user: user ?? text(raw.bot_id, 41),
		text: slackPlain(said, s.named).slice(0, MAX_TEXT),
		date: dateOf(stamp),
		...(thread === undefined ? {} : { thread_ts: thread }),
		...(replies === undefined ? {} : { reply_count: replies }),
		mentions_me: new RegExp(`<@${me.userId}(?:\\|[^>]*)?>`).test(said),
		...(avatar === undefined ? {} : { avatar }),
		...(reactions.length === 0 ? {} : { reactions }),
		...(files.length === 0 ? {} : { files }),
	};
}

/** The names a page of messages needs, looked up: its authors and what they mention. */
async function namesOf(raws: readonly Json[], s: Session): Promise<void> {
	const users = new Set<string>();
	const channels = new Set<string>();
	for (const raw of raws) {
		if (typeof raw.user === "string") users.add(raw.user);
		const mentioned = slackMentions(typeof raw.text === "string" ? raw.text : "");
		for (const id of mentioned.users) users.add(id);
		for (const id of mentioned.channels) channels.add(id);
	}
	await s.lookup([...users], [...channels]);
}

/** A page of messages as banda says them, their names looked up first. */
async function messagesOf(raws: readonly Json[], me: Identity, s: Session): Promise<SlackMessage[]> {
	await namesOf(raws, s);
	return raws.flatMap((raw) => messageOf(raw, me, s) ?? []);
}

/** A channel by its id, never through a list (Slack's lists leave channels out); a direct message named by its person. */
async function channelOf(s: Pick<Session, "call" | "lookup" | "named">, id: string): Promise<SlackChannel> {
	const raw = object((await s.call("conversations.info", { channel: id, include_num_members: true })).channel);
	const dm = raw.is_im === true;
	const peer = typeof raw.user === "string" ? raw.user : "";
	if (dm && peer !== "") await s.lookup([peer], []);
	const named = s.named;
	return {
		id: text(raw.id, 41) || id,
		name: dm ? (named("user", peer) ?? `@${peer}`) : text(raw.name, 100),
		topic: text(object(raw.topic).value, 500),
		member_count: count(raw.num_members) ?? null,
		private: raw.is_private === true || raw.is_group === true || dm || raw.is_mpim === true,
		is_member: raw.is_member === true || dm,
	};
}

const channelArg = (value: unknown) => {
	if (typeof value !== "string" || !CHANNEL.test(value.replace(/^slack\//, "")))
		throw new Error("Give a channel's id (C…, G… or D…), as its Slack link or slack/<id> names it.");
	return value.replace(/^slack\//, "");
};
const tsArg = (value: unknown, what = "message") => {
	const stamp = typeof value === "string" ? slackTs(value) : undefined;
	if (stamp === undefined) throw new Error(`Give the ${what}'s timestamp, 1700000000.000100, or the p… of its link.`);
	return stamp;
};
const intArg = (value: unknown, fallback: number, max: number, name: string) => {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(`Give ${name} as a number from 1 to ${max}.`);
	return Math.max(1, Math.min(max, Math.floor(value)));
};
const cursorArg = (value: unknown) => {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > 500 || /\s/.test(value))
		throw new Error("Give the cursor exactly as the previous page answered it.");
	return value;
};
const nextOf = (body: Json) => {
	const next = text(object(body.response_metadata).next_cursor, 500);
	return next === "" ? {} : { next_cursor: next };
};
/** Whether the newest message is recent enough that more may come soon: a watch looks again sooner. */
const activeOf = (messages: readonly SlackMessage[], now: number) =>
	messages.some((each) => now - Number(each.ts) * 1000 < ACTIVE_MS);
/** A permalink Slack gave, only on the team's own host. */
const permalinkOf = (value: unknown) => {
	const url = teamUrl(value);
	return url === "" || typeof value !== "string" ? "" : value.slice(0, 500);
};

/** Execute one Slack read. Error text never contains a URL, response body, or token. */
export async function slackCall(
	token: string,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
	budget: SlackBudget = SLACK_BUDGET,
	now: () => number = Date.now,
): Promise<McpResult> {
	const s = session(token, signal, fetcher, budget);
	try {
		let answer: unknown;
		switch (name) {
			case "whoami": {
				const me = await s.me();
				answer = {
					handle: `@${me.user} at ${me.team}`,
					user: me.user,
					user_id: me.userId,
					team: me.team,
					team_id: me.teamId,
					url: me.url,
				};
				break;
			}
			case "list_channels": {
				const types = args.types === undefined ? "public_channel,private_channel" : args.types;
				if (
					typeof types !== "string" ||
					!types.split(",").every((each) => ["public_channel", "private_channel", "mpim", "im"].includes(each.trim()))
				)
					throw new Error("Give types as some of public_channel, private_channel, mpim, im, comma-separated.");
				const body = await s.call("users.conversations", {
					types: types.replaceAll(" ", ""),
					limit: intArg(args.limit, 100, 200, "limit"),
					cursor: cursorArg(args.cursor),
					exclude_archived: true,
				});
				const raws = list(body.channels);
				await s.lookup(
					raws.flatMap((raw) => (raw.is_im === true && typeof raw.user === "string" ? [raw.user] : [])),
					[],
				);
				answer = {
					channels: raws.map((raw) => {
						const dm = raw.is_im === true;
						const peer = typeof raw.user === "string" ? raw.user : "";
						return {
							id: text(raw.id, 41),
							name: dm ? (s.named("user", peer) ?? `@${peer}`) : text(raw.name, 100),
							topic: text(object(raw.topic).value, 500),
							member_count: count(raw.num_members) ?? null,
							private: raw.is_private === true || raw.is_group === true || dm || raw.is_mpim === true,
							is_member: true,
						} satisfies SlackChannel;
					}),
					...nextOf(body),
				};
				break;
			}
			case "get_channel": {
				answer = await channelOf(s, channelArg(args.channel));
				break;
			}
			case "channel_history": {
				const id = channelArg(args.channel);
				const me = await s.me();
				const body = await s.call("conversations.history", {
					channel: id,
					limit: intArg(args.limit, 20, 100, "limit"),
					cursor: cursorArg(args.cursor),
					oldest: args.oldest === undefined ? undefined : tsArg(args.oldest, "oldest message"),
				});
				const messages = await messagesOf(list(body.messages), me, s);
				answer = {
					channel: id,
					messages,
					active: activeOf(messages, now()),
					...(me.url === "" ? {} : { url: `${me.url}archives/${id}` }),
					...nextOf(body),
				};
				break;
			}
			case "get_thread": {
				const id = channelArg(args.channel);
				const root = tsArg(args.ts);
				const me = await s.me();
				const body = await s.call("conversations.replies", {
					channel: id,
					ts: root,
					limit: intArg(args.limit, 100, 100, "limit"),
					cursor: cursorArg(args.cursor),
					oldest: args.oldest === undefined ? undefined : tsArg(args.oldest, "oldest message"),
				});
				// every page of replies repeats the thread's first message: keep each message once, by its timestamp
				const seen = new Set<string>();
				const raws = list(body.messages).filter((raw) => {
					const stamp = typeof raw.ts === "string" ? raw.ts : "";
					if (seen.has(stamp)) return false;
					seen.add(stamp);
					return true;
				});
				const messages = await messagesOf(raws, me, s);
				const first = raws[0] ?? {};
				const thread = typeof first.thread_ts === "string" ? slackTs(first.thread_ts) : undefined;
				await s.lookup([], [id]);
				const replies = count(first.reply_count);
				const start = thread ?? messages[0]?.ts ?? root;
				answer = {
					channel: id,
					channel_name: s.named("channel", id)?.replace(/^#/, "") ?? id,
					root: start,
					messages,
					total: replies === undefined ? messages.length : replies + 1,
					active: activeOf(messages, now()),
					...(me.url === "" ? {} : { url: slackPermalink(me.url, id, start) }),
					...nextOf(body),
				};
				break;
			}
			case "search_messages": {
				if (typeof args.query !== "string" || args.query.trim() === "" || args.query.length > 500)
					throw new Error("Give a search of 1 to 500 characters.");
				const sort = args.sort ?? "timestamp";
				const direction = args.sort_dir ?? "desc";
				if (sort !== "timestamp" && sort !== "score") throw new Error("Sort by timestamp or score.");
				if (direction !== "desc" && direction !== "asc") throw new Error("Sort desc or asc.");
				const me = await s.me();
				const body = await s.call("search.messages", {
					query: args.query,
					count: intArg(args.count, 20, 100, "count"),
					sort,
					sort_dir: direction,
				});
				const found = object(body.messages);
				const matches = list(found.matches);
				await namesOf(matches, s);
				// a match is its own message by its permalink: one timestamp may name messages in two channels
				const messages = matches.flatMap((raw) => {
					const message = messageOf(raw, me, s);
					const permalink = permalinkOf(raw.permalink);
					if (message === undefined || permalink === "") return [];
					const where = object(raw.channel);
					return [{ ...message, channel_id: text(where.id, 41), channel_name: text(where.name, 100), permalink }];
				});
				answer = { query: args.query, messages, total: count(found.total) ?? messages.length };
				break;
			}
			case "get_person": {
				const id = typeof args.user === "string" ? args.user.replace(/^slack\/user\//, "") : "";
				if (!USER.test(id)) throw new Error("Give a person's id (U… or W…), as slack/user/<id> names them.");
				const me = await s.me();
				const user = object((await s.call("users.info", { user: id })).user);
				const profile = object(user.profile);
				const email = text(profile.email, 254);
				const avatar = slackAvatar(profile.image_72);
				answer = {
					id,
					name: text(user.name, 100),
					real_name: text(user.real_name, 200) || text(profile.real_name, 200) || text(user.name, 100),
					title: text(profile.title, 200),
					tz: text(user.tz, 100),
					status_text: text(profile.status_text, 200),
					...(email === "" ? {} : { email }),
					outside: typeof user.team_id === "string" && user.team_id !== "" && user.team_id !== me.teamId,
					...(me.url === "" ? {} : { url: `${me.url}team/${id}` }),
					...(avatar === undefined ? {} : { avatar }),
				};
				break;
			}
			case "get_file": {
				const file = await fileInfo(s, args.file_id);
				answer = {
					id: file.id,
					name: file.name,
					title: file.title,
					mimetype: file.mimetype,
					size: file.size,
					...(file.channel === undefined ? {} : { channel: file.channel }),
					...(file.ts === undefined ? {} : { ts: file.ts }),
					...(file.link === undefined ? {} : { link: file.link }),
					too_large: file.size > MAX_SLACK_FILE_BYTES,
				};
				break;
			}
			default:
				throw new Error("That Slack read is not available.");
		}
		const json = JSON.stringify(answer);
		return json.length > MAX_RESPONSE_BYTES
			? { text: JSON.stringify({ error: "Slack result too large; ask for fewer messages." }), isError: true }
			: { text: json, isError: false };
	} catch (error) {
		if (error instanceof Unauthorized) {
			identities.delete(hashOf(token));
			throw error;
		}
		return {
			text: error instanceof Error ? error.message : "Slack could not be read.",
			isError: true,
			...(error instanceof SlackBusy ? { retryAt: error.until } : {}),
		};
	}
}

/** What `files.info` says of a file: what it is, the message it is in, and where its bytes are. */
type FileInfo = {
	readonly id: string;
	readonly name: string;
	readonly title: string;
	readonly mimetype: string;
	readonly size: number;
	readonly channel?: string;
	readonly ts?: string;
	readonly link?: string;
	readonly download?: string;
};

/** A file's download address, only on Slack's own file host over https. */
const downloadOf = (value: unknown) => {
	if (typeof value !== "string" || value.length > 2000) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === "files.slack.com" && url.port === "" && url.username === ""
			? url.toString()
			: undefined;
	} catch {
		return undefined;
	}
};

async function fileInfo(s: Session, given: unknown): Promise<FileInfo> {
	const id = typeof given === "string" ? given.trim() : "";
	if (!FILE.test(id)) throw new Error("Give a file's id (F…), as a message's files list it.");
	const me = await s.me();
	const raw = object((await s.call("files.info", { file: id })).file);
	// the first message it was shared in, of the channels the owner can see it in
	const shares = object(raw.shares);
	const share = [...Object.entries(object(shares.public)), ...Object.entries(object(shares.private))].find(
		([where, each]) => CHANNEL.test(where) && Array.isArray(each) && each.length > 0,
	);
	const first = object(Array.isArray(share?.[1]) ? share[1][0] : undefined);
	const stamp = typeof first.ts === "string" ? slackTs(first.ts) : undefined;
	const thread = typeof first.thread_ts === "string" ? slackTs(first.thread_ts) : undefined;
	const channel = share?.[0];
	const download = downloadOf(raw.url_private_download);
	return {
		id,
		name: fileName(raw.name) || fileName(raw.title) || id,
		title: fileName(raw.title),
		mimetype: mimeOf(raw.mimetype),
		size: count(raw.size) ?? 0,
		...(channel === undefined ? {} : { channel }),
		...(stamp === undefined ? {} : { ts: stamp }),
		...(channel === undefined || stamp === undefined || me.url === ""
			? {}
			: { link: slackPermalink(me.url, channel, stamp, thread) }),
		...(download === undefined ? {} : { download }),
	};
}

const NO_FILES = 'Slack would not give that file: the owner signs in again and allows "Read files you can see".';

/**
 * A file's bytes, fetched by the daemon for the owner with the account's token, at most `MAX_SLACK_FILE_BYTES`; never
 * handed to a box. Error text never contains a URL, body or token.
 */
export async function slackFile(
	token: string,
	fileId: string,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
	budget: SlackBudget = SLACK_BUDGET,
): Promise<{ readonly bytes: Uint8Array; readonly name: string; readonly mimetype: string }> {
	const s = session(token, signal, fetcher, budget);
	try {
		const file = await fileInfo(s, fileId);
		if (file.size > MAX_SLACK_FILE_BYTES) throw new Error(`${file.name} is larger than 10 MB.`);
		if (file.download === undefined) throw new Error("Slack gave no way to download that file.");
		const response = await fetcher(file.download, {
			redirect: "error",
			headers: { authorization: `Bearer ${token}` },
			...(signal === undefined ? {} : { signal }),
		});
		// without the files scope Slack answers its sign-in page, not the file
		const page = (response.headers.get("content-type") ?? "").startsWith("text/html") && file.mimetype !== "text/html";
		if (response.status === 401 || response.status === 403 || (response.ok && page)) {
			await response.body?.cancel();
			throw new Error(NO_FILES);
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Slack answered ${response.status}`);
		}
		const { bytes } = await boundedBytes(response, "Slack", MAX_SLACK_FILE_BYTES, false).catch((error: unknown) => {
			throw error instanceof Error && error.message.endsWith("too large")
				? new Error(`${file.name} is larger than 10 MB.`)
				: error;
		});
		return { bytes, name: file.name, mimetype: file.mimetype };
	} catch (error) {
		if (error instanceof Unauthorized) identities.delete(hashOf(token));
		throw error;
	}
}

/** A message's link, as Slack makes them: a reply's names its thread. */
export function slackPermalink(team: string, channelId: string, stamp: string, thread?: string): string {
	const link = `${team}archives/${channelId}/p${stamp.replace(".", "")}`;
	return thread === undefined || thread === stamp ? link : `${link}?thread_ts=${thread}&cid=${channelId}`;
}

/** An emoji's name as Slack writes it, colons around it dropped. */
const emojiOf = (value: unknown) => (typeof value === "string" ? value.trim().replace(/^:(.*):$/, "$1") : "");
const emojiArg = (value: unknown) => {
	const name = emojiOf(value);
	if (!SLACK_EMOJI.test(name))
		throw new Error("Give the emoji's name as Slack writes it, such as thumbsup or wave::skin-tone-3.");
	return name;
};

/**
 * Post an approved message. Never retried here: Slack takes no idempotency key, so a post a crash cut short is asked
 * again by the daemon (the tool is `unsafe`), never repeated unasked. Error text never contains a URL, body or token.
 */
export async function slackWriteCall(
	token: string,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
	budget: SlackBudget = SLACK_BUDGET,
): Promise<McpResult> {
	const s = session(token, signal, fetcher, budget);
	try {
		if (name === "add_reaction") {
			const id = channelArg(args.channel);
			const stamp = tsArg(args.ts);
			const emoji = emojiArg(args.name);
			// a reaction already there is the end state asked for: a repeat after a crash changes nothing
			await s.call("reactions.add", { channel: id, timestamp: stamp, name: emoji }, true, ["already_reacted"]);
			return { text: JSON.stringify({ ok: true, channel: id, ts: stamp, name: emoji }), isError: false };
		}
		if (name !== "post_message") throw new Error("That Slack change is not available.");
		const id = channelArg(args.channel);
		if (typeof args.text !== "string" || args.text.trim() === "" || args.text.length > MAX_TEXT)
			throw new Error(`Give the message's text, at most ${MAX_TEXT} characters.`);
		const thread = args.thread_ts === undefined ? undefined : tsArg(args.thread_ts, "thread's first message");
		const me = await s.me();
		const body = await s.call("chat.postMessage", { channel: id, text: args.text, thread_ts: thread }, true);
		const posted = typeof body.ts === "string" ? slackTs(body.ts) : undefined;
		return {
			text: JSON.stringify({
				ok: true,
				channel: id,
				...(posted === undefined ? {} : { ts: posted }),
				...(posted === undefined || me.url === "" ? {} : { link: slackPermalink(me.url, id, posted, thread) }),
			}),
			isError: false,
		};
	} catch (error) {
		if (error instanceof Unauthorized) {
			identities.delete(hashOf(token));
			throw error;
		}
		return { text: error instanceof Error ? error.message : "Slack could not post the message.", isError: true };
	}
}

// ---- the owner's words for a post

/** What a post or a reaction does, in the owner's words, and its button: where, by the channel's name the draft read. */
export function slackDraft(name: string, args: Record<string, unknown>): { what: string; verb: string } | undefined {
	if (name !== "post_message" && name !== "add_reaction") return undefined;
	const said = typeof args._channel_name === "string" && args._channel_name !== "" ? args._channel_name : undefined;
	const where = said === undefined ? "this channel" : said.startsWith("@") ? said : `#${said}`;
	if (name === "add_reaction") {
		const emoji = emojiOf(args.name);
		return { what: `React${SLACK_EMOJI.test(emoji) ? ` :${emoji}:` : ""} to a message in ${where}`, verb: "React" };
	}
	return {
		what: typeof args.thread_ts === "string" ? `Reply in thread in ${where}` : `Post in ${where}`,
		verb: "Send",
	};
}

/** The owner may edit a post's text before approving it, never where it goes. */
export const slackEditable = (name: string): readonly string[] => (name === "post_message" ? ["text"] : []);

/** A draft as the model gave it, without anything it named as the daemon's (`_…`), which the daemon reads itself. */
export function slackExpand(_name: string, args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).filter(([key]) => !key.startsWith("_")));
}

/**
 * What a post's draft shows beside its text, read once as it is drafted: the channel's name, and the names of the
 * people and channels its text mentions, so the owner sees who it will notify. A channel the owner cannot see refuses
 * the draft before it is asked.
 */
export async function slackResolve(
	token: string,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
	budget: SlackBudget = SLACK_BUDGET,
): Promise<Record<string, unknown>> {
	if (name !== "post_message" && name !== "add_reaction") return {};
	const s = session(token, signal, fetcher, budget);
	const id = channelArg(args.channel);
	// what the card's words will carry: a name as Slack has it, without any control or format character someone slipped in
	const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
	if (name === "add_reaction") {
		tsArg(args.ts);
		emojiArg(args.name);
		return { _channel_name: clean((await channelOf(s, id)).name) };
	}
	if (args.thread_ts !== undefined) tsArg(args.thread_ts, "thread's first message");
	const found = await channelOf(s, id);
	const mentioned = slackMentions(typeof args.text === "string" ? args.text : "");
	await s.lookup(mentioned.users, mentioned.channels);
	const known: Record<string, string> = {};
	for (const user of mentioned.users) {
		const said = s.named("user", user);
		if (said !== undefined) known[user] = said;
	}
	for (const each of mentioned.channels) {
		const said = s.named("channel", each);
		if (said !== undefined) known[each] = said;
	}
	return {
		_channel_name: clean(found.name),
		_names: Object.fromEntries(Object.entries(known).map(([id, said]) => [id, clean(said)])),
	};
}
