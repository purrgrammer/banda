/**
 * A line of markdown as a preview reads it (the band's rows): bold, italic and code as such, a link as its words, and
 * the marks that only shape a block (a heading's #, a list's -, a quote's >) dropped; one line, whatever was cut.
 * `inlineParts` is pure, for the tests; a mark left open by the cut reads as plain text.
 */
import type { ReactNode } from "react";

export type InlinePart = { readonly text: string; readonly style?: "bold" | "italic" | "code" };

const TOKEN = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(!?\[([^\]]*)\]\([^)]*\))/g;

export function inlineParts(markdown: string): InlinePart[] {
	const line = markdown
		.split("\n")
		.map((one) => one.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "").trim())
		.filter((one) => one !== "")
		.join(" ");
	const parts: InlinePart[] = [];
	const plain = (text: string) => {
		if (text === "") return;
		const last = parts.at(-1);
		if (last !== undefined && last.style === undefined) parts[parts.length - 1] = { text: last.text + text };
		else parts.push({ text });
	};
	let at = 0;
	for (const match of line.matchAll(TOKEN)) {
		plain(line.slice(at, match.index));
		const [whole, code, bold, italic, link, words] = match;
		if (code !== undefined) parts.push({ text: code.slice(1, -1), style: "code" });
		else if (bold !== undefined) parts.push({ text: bold.slice(2, -2), style: "bold" });
		else if (italic !== undefined) parts.push({ text: italic.slice(1, -1), style: "italic" });
		else if (link !== undefined) plain(words ?? "");
		else plain(whole);
		at = match.index + whole.length;
	}
	plain(line.slice(at));
	return parts;
}

export function Inline({ children }: { children: string }) {
	return inlineParts(children).map((part, n): ReactNode => {
		const key = `${n}:${part.style ?? ""}`;
		switch (part.style) {
			case "bold":
				return (
					<strong key={key} className="font-semibold">
						{part.text}
					</strong>
				);
			case "italic":
				return <em key={key}>{part.text}</em>;
			case "code":
				return (
					<code key={key} className="font-code text-[0.92em]">
						{part.text}
					</code>
				);
			default:
				return part.text;
		}
	});
}
