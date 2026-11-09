/**
 * Mentions in a group's composer (DESIGN.md "Groups"): an `@` offers the group's agents, and a message asks to work
 * only the agents picked from that offer whose mention is still in its text, never a name typed by hand. Pure.
 */
import type { ChatAgent } from "./navigation.ts";

/** The `@word` being typed just before the caret, or undefined. */
export function mentionQuery(
	text: string,
	caret: number,
): { readonly start: number; readonly query: string } | undefined {
	const match = /(?:^|\s)@([\p{L}\p{N}-]*)$/u.exec(text.slice(0, caret));
	if (match === null) return undefined;
	const query = match[1] ?? "";
	return { start: caret - query.length - 1, query };
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with each `@Name` of the agents named in `ids` written as a mention link, `[@Name](#/a/<id>)`, for
 * the message to draw as a chip; any other `@` is left as words. Longer names first, so "@Ana Lu" wins over "@Ana".
 */
export function linkMentions(text: string, ids: readonly string[], agents: readonly ChatAgent[]): string {
	const named = agents.filter((agent) => ids.includes(agent.id)).sort((a, b) => b.name.length - a.name.length);
	if (named.length === 0) return text;
	const pattern = new RegExp(
		`(^|\\s)@(${named.map((agent) => escaped(agent.name)).join("|")})(?![\\p{L}\\p{N}])`,
		"gu",
	);
	return text.replace(pattern, (_all, before: string, name: string) => {
		const agent = named.find((each) => each.name === name);
		return agent === undefined ? `${before}@${name}` : `${before}[@${name}](#/a/${agent.id})`;
	});
}

/** The agents picked whose `@Name` is still in `text`, each once, in the order picked. */
export function mentionsIn(text: string, picked: readonly ChatAgent[]): string[] {
	// whatever the case the owner typed it in, and only as a whole name: @mara asks Mara, @marat does not
	const ids = picked
		.filter((agent) => new RegExp(`(^|\\s)@${escaped(agent.name)}(?![\\p{L}\\p{N}])`, "iu").test(text))
		.map((agent) => agent.id);
	return [...new Set(ids)];
}

/** A message cut where its mentions stand: words, and the agent each mention names. */
export type MentionPart = { readonly text: string } | { readonly mention: string };

/**
 * The parts of a group message with every agent it mentions (`ids`, the message's own) shown once, the same way
 * whoever wrote it: at its first `@Name`, else at the first time its name stands as a word ("Sancho, send me…"), else
 * before the words, so a mention is never invisible. Whatever the case, a whole name only. Pure.
 */
export function mentionParts(
	text: string,
	ids: readonly string[],
	agents: readonly { readonly id: string; readonly name: string }[],
): MentionPart[] {
	const named = agents.filter((agent) => ids.includes(agent.id));
	// where each mentioned agent stands: [start, end) in text, the @ included when there is one
	const spans: { start: number; end: number; id: string }[] = [];
	const leading: string[] = [];
	const free = (start: number, end: number) => spans.every((span) => end <= span.start || start >= span.end);
	for (const agent of [...named].sort((a, b) => b.name.length - a.name.length)) {
		const name = escaped(agent.name);
		const at = new RegExp(`(?<![\\p{L}\\p{N}_])@${name}(?![\\p{L}\\p{N}_])`, "iu").exec(text);
		const bare = at === null ? new RegExp(`(?<![\\p{L}\\p{N}_@])${name}(?![\\p{L}\\p{N}_])`, "iu").exec(text) : null;
		const found = at ?? bare;
		if (found !== null && free(found.index, found.index + found[0].length))
			spans.push({ start: found.index, end: found.index + found[0].length, id: agent.id });
		else leading.push(agent.id);
	}
	spans.sort((a, b) => a.start - b.start);
	const parts: MentionPart[] = [];
	for (const id of leading) parts.push({ mention: id }, { text: " " });
	let at = 0;
	for (const span of spans) {
		if (span.start > at) parts.push({ text: text.slice(at, span.start) });
		parts.push({ mention: span.id });
		at = span.end;
	}
	if (at < text.length) parts.push({ text: text.slice(at) });
	return parts;
}
