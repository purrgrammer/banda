/**
 * The one maker of a file's name from words, for every file the daemon names on its own (a routine from its
 * description, a watch from its object or its card). Routines, watches and agents share one rule (`AGENT_NAME`:
 * lowercase letters and digits in words joined by dashes, beginning with a letter), and a name made here always meets
 * it, whatever the words: that is the whole point of there being one maker. A watch on a Drive file was once refused
 * the name the tool itself had made from the file's id, which began with a digit, because the tool had a maker of its
 * own.
 */
import { AGENT_NAME } from "./agents.ts";

/** The most characters a made name has before its kind's prefix: a line in the panel, a file in a folder. */
export const NAME_LENGTH = 40;

/**
 * `words` as a file name of `kind`: lowercase, accents off their letters, whole words joined by dashes up to
 * `NAME_LENGTH` characters (a single word longer than that is cut), `kind` alone when nothing is left, and behind
 * `kind-` when the first character is not a letter.
 */
export function fileNameFor(words: string, kind: "routine" | "watch"): string {
	const parts = words
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter((word) => word !== "");
	let name = "";
	for (const word of parts) {
		const next = name === "" ? word : `${name}-${word}`;
		if (next.length > NAME_LENGTH) {
			if (name === "") name = word.slice(0, NAME_LENGTH);
			break;
		}
		name = next;
	}
	if (name === "") return kind;
	const made = /^[a-z]/.test(name) ? name : `${kind}-${name}`;
	// unreachable by construction; said anyway, so a change above can never hand out a name the parser refuses
	return AGENT_NAME.test(made) ? made : kind;
}
