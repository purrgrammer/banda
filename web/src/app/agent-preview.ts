/** The identity is drawn beside the definition, never exposed as geometry JSON in an approval. */
export function withoutFace(text: string): string {
	return text.replace(
		/^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/,
		(_match, start: string, head: string, end: string) =>
			`${start}${head
				.split(/\r?\n/)
				.filter((line) => !/^face\s*:/.test(line))
				.join("\n")}${end}`,
	);
}
