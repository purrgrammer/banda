/**
 * What a Slack message's words render as (`../chat/Object.tsx`): the emoji its `:shortcodes:` name, by Slack's own names,
 * and the lines it quotes. Pure, for the tests. A workspace's custom emoji has no character, and stays as its shortcode.
 */
import shortcodes from "emojibase-data/en/shortcodes/iamcal.json";

const EMOJI = new Map<string, string>();
for (const [hex, names] of Object.entries(shortcodes as { readonly [hex: string]: string | readonly string[] }))
	for (const name of [names].flat())
		EMOJI.set(name, String.fromCodePoint(...hex.split("-").map((n) => parseInt(n, 16))));

const TONES: { readonly [tone: string]: string } = {
	"2": "\u{1F3FB}",
	"3": "\u{1F3FC}",
	"4": "\u{1F3FD}",
	"5": "\u{1F3FE}",
	"6": "\u{1F3FF}",
};

/** Emoji drawn as emoji: a lone older codepoint (a sun, a heart) would otherwise draw as a black glyph. */
const asEmoji = (character: string) =>
	[...character].length === 1 && (character.codePointAt(0) ?? 0) < 0x1f000 ? `${character}\ufe0f` : character;

export function slackEmoji(text: string): string {
	return text.replace(/:([a-z0-9_+'-]{1,64}):(?::skin-tone-([2-6]):)?/g, (whole, name: string, tone?: string) => {
		const character = EMOJI.get(name);
		if (character === undefined) return whole;
		return tone === undefined ? asEmoji(character) : `${character}${TONES[tone] ?? ""}`;
	});
}

export type SlackBlock = { readonly quote: boolean; readonly lines: readonly string[] };

/** Runs of lines, quoted or not: `> ` quotes its line, `>>> ` every line after it. */
export function slackBlocks(text: string): SlackBlock[] {
	const blocks: { quote: boolean; lines: string[] }[] = [];
	let restQuoted = false;
	for (const raw of text.split("\n")) {
		const rest = /^>>>\s?(.*)$/.exec(raw);
		if (rest !== null) restQuoted = true;
		const one = rest === null ? /^>\s?(.*)$/.exec(raw) : null;
		const quote = restQuoted || one !== null;
		const line = rest?.[1] ?? one?.[1] ?? raw;
		if (quote && line === "") continue;
		const last = blocks.at(-1);
		if (last?.quote === quote) last.lines.push(line);
		else blocks.push({ quote, lines: [line] });
	}
	return blocks;
}

/** A message as one line, for a reference: its emoji drawn, its quote marks gone. */
export const slackLine = (text: string): string =>
	slackBlocks(slackEmoji(text))
		.flatMap((block) => block.lines)
		.join(" ");
