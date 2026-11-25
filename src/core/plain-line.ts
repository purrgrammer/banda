/**
 * Words as banda keeps a name or a line it was given: free of Node's modules, so the web app reads a name the way the
 * daemon stores it.
 */

/** A plain line: no control or invisible characters, one space for each run of spaces, bounded. */
export function plainLine(value: unknown, max = 200): string {
	if (typeof value !== "string") return "";
	const visible = value
		.normalize("NFKC")
		.replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, "")
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = [...visible];
	return characters.length <= max ? visible : `${characters.slice(0, max - 1).join("")}…`;
}
