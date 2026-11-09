/**
 * The companion's defaults and Identity choices: name, avatar face and personality. A new home starts with these
 * defaults, without a setup screen.
 */

import { type AvatarFace, defaultAvatarFace } from "./avatar-face.ts";
import { hiddenError, nfc } from "./visible.ts";

export const DEFAULT_NAME = "Sancho";
export const NAME_SUGGESTIONS = ["Sancho", "Rucio", "Dulcinea", "Teresa"] as const;

/** The chat bubble, copied into each new agent's definition. */
export const DEFAULT_FACE = defaultAvatarFace();

// The library uses interfaces; mapped objects make the same shape satisfy pi-durable's JSON document constraint.
type Stored<T> = { -readonly [K in keyof T]: T[K] extends object ? Stored<T[K]> : T[K] };
export type StoredAvatarFace = Stored<AvatarFace>;

const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** `text` as one emoji (trimmed), or undefined when it is not exactly one. */
export function oneEmoji(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "" || trimmed.length > 32) return undefined;
	const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)];
	if (graphemes.length !== 1 || !PICTOGRAPH.test(trimmed)) return undefined;
	return trimmed;
}

/** The first emoji in `text`, for a field the owner types or pastes into; undefined when there is none. */
export function firstEmoji(text: string): string | undefined {
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
		const emoji = oneEmoji(segment);
		if (emoji !== undefined) return emoji;
	}
	return undefined;
}

/**
 * The personality: how the companion speaks, in the owner's own words (no presets), written into the lead's agent file
 * as its own section. The default is where a new companion starts; the owner rewrites it on Identity, and the companion
 * may propose new words.
 */
export const DEFAULT_PERSONALITY =
	"Speak warmly and plainly, like a trusted friend: kind and encouraging, never gushing.";
/** The longest personality: a paragraph or two. */
export const MAX_PERSONALITY = 2000;

/** The longest name the owner can give an account. */
export const ACCOUNT_LABEL_MAX = 60;

const HEADING = "## Personality";
const SECTION = /\n*^## Personality[ \t]*\r?\n[\s\S]*?(?=^## |(?![\s\S]))/m;

/**
 * `text` as a personality, or why it cannot be one: a few words, at most `MAX_PERSONALITY` characters once trimmed,
 * and no line a heading (which would end its section of the agent file).
 */
export function personalityWords(text: string): string | { refused: string } {
	// checked before trimming: trim() removes some invisible characters (U+FEFF) rather than let them be refused
	const hidden = hiddenError(text, { lines: true });
	if (hidden !== undefined) return { refused: `a personality ${hidden.replace(/^it /, "")}` };
	const words = nfc(text.replace(/\r\n?/g, "\n").trim());
	if (words === "") return { refused: "a personality needs a few words" };
	if ([...words].length > MAX_PERSONALITY) return { refused: `a personality is at most ${MAX_PERSONALITY} characters` };
	if (/^\s*#/m.test(words)) return { refused: "a personality has no headings" };
	return words;
}

/** An agent file with its personality section's words replaced by `words` (added at the end when it had none). */
export function withPersonality(text: string, words: string): string {
	const rest = text.replace(SECTION, "\n\n").trimEnd();
	return `${rest}\n\n${HEADING}\n${words.trim()}\n`;
}

/** The words of an agent file's personality section; undefined when it has none. */
export function personalityOf(text: string): string | undefined {
	const section = SECTION.exec(text)?.[0];
	return section === undefined ? undefined : section.trim().slice(HEADING.length).trim();
}
