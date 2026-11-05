/**
 * Text the box writes that can reach a prompt or a card the owner answers (DESIGN.md "Trust", law 5): what the owner
 * reads must be every character the model reads. So such text is normalised (NFC) and refused when it holds a
 * character nobody sees: a control (bar tab, and newline where the text has lines), a format character (zero-width
 * ones, bidi controls, Unicode tag characters), a private-use, surrogate or unassigned code point, or a line or
 * paragraph separator. A zero-width joiner between two emoji is how emoji are drawn, so it is kept.
 *
 * Every reader of such text checks it here: the frontmatter files (agents, tools, connections, routines), the
 * memory facts. `foldKey` is what two titles that mean the same share.
 */

/** A zero-width joiner drawing two emoji as one, which shows. */
const JOINED_EMOJI =
	/(?<=\p{Extended_Pictographic}(?:\p{M}|[\u{1F3FB}-\u{1F3FF}])*)\u{200D}(?=\p{Extended_Pictographic})/gu;

const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u{2028}\u{2029}]/u;

/**
 * The first character of `text` nobody sees, as `U+XXXX`, or undefined when there is none. `lines`: the text may
 * break lines (a newline, or a carriage return before one).
 */
export function hiddenIn(text: string, { lines = false }: { lines?: boolean } = {}): string | undefined {
	const plain = (lines ? text.replace(/\r\n/g, "\n") : text).replace(JOINED_EMOJI, "");
	for (const char of plain) {
		if (char === "\t" || (lines && char === "\n")) continue;
		if (HIDDEN.test(char)) return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
	}
	return undefined;
}

/** Why `text` is refused, saying what to write instead; undefined when every character shows. */
export function hiddenError(text: string, options?: { lines?: boolean }): string | undefined {
	const hidden = hiddenIn(text, options);
	return hidden === undefined
		? undefined
		: `it holds a character nobody sees (${hidden}): write it in plain characters`;
}

/** `text` as it is kept and read: NFC. */
export const nfc = (text: string) => text.normalize("NFC");

/**
 * A title as a key: what two titles the owner would read as the same share, whatever their form (NFKC), invisible
 * characters, spacing or case.
 */
export const foldKey = (text: string) =>
	text
		.normalize("NFKC")
		.replace(/\p{Cf}/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.toUpperCase()
		.toLowerCase();
