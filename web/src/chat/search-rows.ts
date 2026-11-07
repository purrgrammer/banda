/**
 * Which of search's rows the keyboard can reach, in the list's order. While a new search runs the previous chat hits
 * stay on screen, dimmed, so the list never collapses — but they answer an older query, so they are inert: not among
 * the live rows, not selectable, and Enter never opens one. The local sections (agents, skills, pages) match the
 * current query instantly, so they stay live. Pure, so the tests read it plainly.
 */
export function liveRows(list: {
	readonly typed: boolean;
	readonly recent: readonly string[];
	readonly agents: readonly string[];
	readonly skills: readonly string[];
	readonly pages: readonly string[];
	readonly hits: readonly string[];
	/** A search runs, or the hits answer an older query: the chat rows are dimmed and inert. */
	readonly busy: boolean;
}): string[] {
	if (!list.typed) return list.recent.map((id) => `recent:${id}`);
	return [
		...list.agents.map((id) => `agent:${id}`),
		...list.skills.map((name) => `skill:${name}`),
		...list.pages.map((id) => `page:${id}`),
		...(list.busy ? [] : list.hits.map((id) => `hit:${id}`)),
	];
}

/** The active row: the one picked while it is live; dimmed or gone, the first live row; none live, none. */
export const activeRow = (live: readonly string[], picked: string): string =>
	live.includes(picked) ? picked : (live[0] ?? "");
