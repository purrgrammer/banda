/**
 * Slack's message text (mrkdwn) as plain words, and who a message will notify. Pure, with no store or network, so the
 * daemon's adapter and the app's draft share it: the adapter resolves names, and each caller passes what it knows.
 */

/** A name the caller knows for a user (`@bob`) or a channel (`#general`), by its id; undefined when it does not. */
export type SlackNames = (kind: "user" | "channel", id: string) => string | undefined;

const TOKEN = /<([^<>\n]{1,600})>/g;
const USER = /^@([UWB][A-Z0-9]{1,40})(?:\|([^>]{0,200}))?$/;
const CHANNEL = /^#([CDG][A-Z0-9]{1,40})(?:\|([^>]{0,200}))?$/;
const SPECIAL = /^!([a-z]+)(?:\^([^|>]{0,200}))?(?:\|([^>]{0,200}))?$/;

/** A Slack timestamp from what names one: `1700000000.000100`, or a link's `p1700000000000100`; else undefined. */
export function slackTs(value: string): string | undefined {
	const dotted = /^(\d{9,11})\.(\d{6})$/.exec(value);
	if (dotted !== null) return value;
	const packed = /^p?(\d{9,11})(\d{6})$/.exec(value);
	return packed === null ? undefined : `${packed[1]}.${packed[2]}`;
}

/** The ids a text mentions: the users and channels whose names it needs. */
export function slackMentions(text: string): { readonly users: string[]; readonly channels: string[] } {
	const users = new Set<string>();
	const channels = new Set<string>();
	for (const [, inner = ""] of text.matchAll(TOKEN)) {
		const user = USER.exec(inner);
		if (user?.[1] !== undefined) users.add(user[1]);
		const channel = CHANNEL.exec(inner);
		if (channel?.[1] !== undefined && (channel[2] ?? "") === "") channels.add(channel[1]);
	}
	return { users: [...users], channels: [...channels] };
}

const BROADCAST: { readonly [name: string]: string } = { here: "@here", channel: "@channel", everyone: "@everyone" };

const entities = (text: string) => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** One `<…>` token as words. */
function tokenWords(inner: string, names: SlackNames): string {
	const user = USER.exec(inner);
	if (user !== null) return names("user", user[1] ?? "") ?? (user[2] ? `@${user[2].replace(/^@/, "")}` : `@${user[1]}`);
	const channel = CHANNEL.exec(inner);
	if (channel !== null)
		return channel[2] ? `#${channel[2].replace(/^#/, "")}` : (names("channel", channel[1] ?? "") ?? `#${channel[1]}`);
	const special = SPECIAL.exec(inner);
	if (special !== null) {
		const [, kind = "", , label] = special;
		if (BROADCAST[kind] !== undefined) return BROADCAST[kind];
		return label ?? `@${kind}`;
	}
	const [target = "", label] = inner.split("|", 2);
	if (/^mailto:/i.test(target)) return label ?? target.slice("mailto:".length);
	if (/^https?:\/\//i.test(target)) return label !== undefined && label !== target ? `${label} (${target})` : target;
	return label ?? target;
}

/**
 * A message's text as plain words: mentions and channels by name, links as their words and address, Slack's escapes
 * undone, and the markers of bold, italic and strike-through dropped where they wrap words.
 */
export function slackPlain(text: string, names: SlackNames): string {
	const unmarked = text
		.replace(/(^|[\s(])\*([^*\n<>]+)\*(?=[\s).,!?:;]|$)/g, "$1$2")
		.replace(/(^|[\s(])_([^_\n<>]+)_(?=[\s).,!?:;]|$)/g, "$1$2")
		.replace(/(^|[\s(])~([^~\n<>]+)~(?=[\s).,!?:;]|$)/g, "$1$2");
	return entities(unmarked.replace(TOKEN, (_, inner: string) => tokenWords(inner, names)));
}

/**
 * Who a message will notify when it is posted, in words: a broadcast by what it reaches, a user by name, a group by its
 * handle. Empty when it notifies no one beyond the channel's own settings.
 */
export function slackNotifies(text: string, names: SlackNames): string[] {
	const said = new Set<string>();
	for (const [, inner = ""] of text.matchAll(TOKEN)) {
		const user = USER.exec(inner);
		if (user !== null) {
			said.add(names("user", user[1] ?? "") ?? `@${user[1]}`);
			continue;
		}
		const special = SPECIAL.exec(inner);
		if (special === null) continue;
		const [, kind = "", , label] = special;
		if (kind === "here") said.add("@here (everyone active in the channel)");
		else if (kind === "channel") said.add("@channel (everyone in the channel)");
		else if (kind === "everyone") said.add("@everyone (everyone in the team)");
		else if (kind === "subteam") said.add(label ?? "a user group");
	}
	return [...said];
}
