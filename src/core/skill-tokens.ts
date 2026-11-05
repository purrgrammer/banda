/** Pure slash syntax for the composer. The daemon must use the same rules when it is wired. */
export type SkillToken = { name: string; start: number; end: number };

/** A slash in backticks, double quotes or after a backslash is the owner's literal text. */
function literalAt(text: string, at: number): boolean {
	let quote: "'" | '"' | undefined;
	let ticks = 0;
	for (let i = 0; i < at; i++) {
		const char = text[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if (char === "`" && quote === undefined) {
			let end = i + 1;
			while (text[end] === "`") end++;
			const count = end - i;
			if (ticks === 0) ticks = count;
			else if (ticks === count) ticks = 0;
			i = end - 1;
		} else if ((char === '"' || char === "'") && ticks === 0) {
			if (quote === char) quote = undefined;
			else if (quote === undefined && (char === '"' || i === 0 || !/[a-z0-9]/i.test(text[i - 1] ?? ""))) quote = char;
		}
	}
	return quote !== undefined || ticks !== 0 || (at > 0 && text[at - 1] === "\\");
}

/** Each known whole `/name` in message order, not quoted, escaped, or embedded in a URL/path. */
export function skillTokens(text: string, names: Iterable<string>): SkillToken[] {
	const known = new Set(names);
	const found: SkillToken[] = [];
	for (const match of text.matchAll(/(^|[\s(])\/([a-z0-9-]+)(?=$|[\s.,!?;:)\]}'"])/g)) {
		const name = match[2];
		if (name === undefined || match.index === undefined) continue;
		const start = match.index + (match[1]?.length ?? 0);
		if (known.has(name) && !literalAt(text, start)) found.push({ name, start, end: start + name.length + 1 });
	}
	return found;
}

/** The incomplete `/name` at the caret, with the complete token range to replace on pick. */
export function slashQuery(text: string, caret: number): { start: number; end: number; query: string } | undefined {
	let start = caret;
	while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start--;
	if (text[start] !== "/" || literalAt(text, start)) return undefined;
	const query = text.slice(start + 1, caret);
	if (!/^[a-z0-9-]*$/.test(query)) return undefined;
	let end = caret;
	while (end < text.length && !/\s/.test(text[end] ?? "")) end++;
	return { start, end, query };
}
