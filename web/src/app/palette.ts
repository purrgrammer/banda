/**
 * Search's local sections: agents, skills and pages matched in the app itself, instantly, with no request. Matching
 * is case-insensitive, accent-insensitive, and by word prefix: every word of the query begins some word of the text.
 * An empty query matches nothing here: the Recent rows cover it. Pure, so the tests read it plainly.
 */

const fold = (text: string) =>
	text
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase();

const words = (text: string) =>
	fold(text)
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);

/** Whether every word of the query begins some word of the text; an empty query matches nothing. */
export function matches(query: string, text: string): boolean {
	const asked = words(query);
	if (asked.length === 0) return false;
	const had = words(text);
	return asked.every((one) => had.some((word) => word.startsWith(one)));
}

/** The pages search can open, by their labels. */
export const PAGES = [
	{ id: "skills", label: "Skills" },
	{ id: "connections", label: "Connections" },
	{ id: "settings", label: "Settings" },
] as const;

export type Page = (typeof PAGES)[number];

export const matchAgents = <A extends { readonly name: string }>(agents: readonly A[], query: string): A[] =>
	agents.filter((agent) => matches(query, agent.name));

export const matchSkills = <S extends { readonly name: string; readonly description: string }>(
	skills: readonly S[],
	query: string,
): S[] => skills.filter((skill) => matches(query, skill.name) || matches(query, skill.description));

export const matchPages = (query: string): Page[] => PAGES.filter((page) => matches(query, page.label));
