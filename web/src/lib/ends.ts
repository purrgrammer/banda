/**
 * Where a line that runs out of room is cut. Never at its end when its end says what happened: a path's file name, a
 * command's last step, a trailing " · submit". The text is split in two, a head that gives way and an end that stays
 * (chat/KeepEnd.tsx draws them), and a cap in characters cuts the head, not the end. Pure.
 */

/** A line split for the eye: `head` gives way first, `end` stays as long as anything does. `head + end` is the text. */
export type Ends = { readonly head: string; readonly end: string };

/** The text with each quoted string's insides and each escaped character blanked, same length: what the shell reads as structure. */
const bare = (text: string) =>
	text
		.replace(/\\./g, "  ")
		.replace(/"(?:\\.|[^"\\])*"/g, (quoted) => `"${" ".repeat(quoted.length - 2)}"`)
		.replace(/'[^']*'/g, (quoted) => `'${" ".repeat(quoted.length - 2)}'`);

/**
 * A command's last step kept: the end starts at the last `&&`, `||`, `;` or `|` outside quotes (`npm test && git push`
 * keeps `&& git push`). A command of one step keeps its last word's path end, like a path; with no path, what follows
 * a cut already made ("…") stays.
 */
export function commandEnds(command: string): Ends {
	const shape = bare(command);
	let at = -1;
	// a separator with nothing after it (`npm test;`) ends no step: the step before it is the last
	for (const match of shape.matchAll(/&&|\|\||;|\|/g))
		if (shape.slice(match.index + match[0].length).trim() !== "") at = match.index;
	if (at > 0) return { head: command.slice(0, at), end: command.slice(at) };
	const path = pathEnds(command);
	const cut = command.lastIndexOf("…");
	return path.head === "" && cut > 0 ? { head: command.slice(0, cut + 1), end: command.slice(cut + 1) } : path;
}

/** A path's file name kept: the end starts after its last `/` (a trailing one aside). No `/`, no head. */
export function pathEnds(path: string): Ends {
	const at = path.replace(/\/+$/, "").lastIndexOf("/");
	return at < 0 ? { head: "", end: path } : { head: path.slice(0, at + 1), end: path.slice(at + 1) };
}

/** A trailing " · " part kept: "ref · text · submit" keeps " · submit", when it is short enough to be a mark. */
export function suffixEnds(text: string, longest = 24): Ends {
	const at = text.lastIndexOf(" · ");
	return at < 0 || text.length - at > longest
		? { head: text, end: "" }
		: { head: text.slice(0, at), end: text.slice(at) };
}

/**
 * At most `max` characters, cut in the head: "…" where the head gave way, the end whole. An end that alone runs past
 * `max` is cut in its middle instead: both of its ends still read.
 */
export function capEnds({ head, end }: Ends, max: number): Ends {
	if (head.length + end.length <= max) return { head, end };
	if (end.length + 1 >= max) {
		const keep = max - 1;
		const front = Math.ceil(keep * 0.6);
		return { head: "", end: `${end.slice(0, front)}…${end.slice(end.length - (keep - front))}` };
	}
	const room = max - end.length - 1;
	// the head keeps its start (the program, the root), the end its tail
	return { head: `${head.slice(0, room)}…`, end };
}
