/**
 * Markdown as plain text, for the moment before the renderer has loaded: the words as they will read, without the
 * syntax (`**`, `#`, backticks, link targets) flashing raw. Pure; not a renderer, so it is forgiving rather than exact.
 */
export function plainText(markdown: string): string {
	// an escaped character is held aside, so no rule below takes it for syntax
	const held: string[] = [];
	const text = markdown.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_, char: string) => {
		held.push(char);
		return `\u{F0000}${held.length - 1}\u{F0001}`;
	});
	return (
		text
			.split("\n")
			// a fence's own lines go; what is inside stays
			.filter((line) => !/^\s*(```|~~~)/.test(line))
			.map((line) =>
				line
					.replace(/^\s{0,3}#{1,6}\s+/, "")
					.replace(/^\s{0,3}>\s?/, "")
					.replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?/, "$1• ")
					.replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, "")
					// a table's alignment row
					.replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/, ""),
			)
			.join("\n")
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/`+([^`]*)`+/g, "$1")
			.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
			.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
			.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
			.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2")
			// what a stream left unclosed
			.replace(/\*\*|__|~~/g, "")
			.replace(/\u{F0000}(\d+)\u{F0001}/gu, (_, n: string) => held[Number(n)] ?? "")
	);
}
