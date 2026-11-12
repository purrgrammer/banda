/**
 * Who a group's working line shows: the members at work that have shown nothing in the feed since they began. What
 * was seen lives here, between renders of one open group; nothing of it is stored.
 */

/** Each member on the line or held there: the newest entry of the log when it was first seen at work. */
export type WorkingSince = Map<string, number>;

export const noneWorking = (): WorkingSince => new Map();

type Log = {
	readonly latest: number;
	/** What each member showed in the feed: its messages and the daemon's notices about it, by entry. */
	readonly shown: readonly { readonly entry: number; readonly agent: string }[];
	/** Members whose ask is open in the feed now. */
	readonly asking: readonly string[];
};

/**
 * The members to draw, in the order they started, updating `since`. A member leaves the line as soon as anything of
 * its own shows after it began, even while it goes on working. One whose work ended stays until the log caught up with
 * the row: the end and what it said reach the page in two steps, and the line must not lose it in between.
 */
export function workingMembers(
	since: WorkingSince,
	log: Log | undefined,
	working: readonly string[],
	rowLatest: number | undefined,
): readonly string[] {
	if (log === undefined) return [];
	for (const member of working) if (!since.has(member)) since.set(member, log.latest);
	const behind = rowLatest !== undefined && rowLatest > log.latest;
	if (!behind) for (const member of since.keys()) if (!working.includes(member)) since.delete(member);
	return [...since].flatMap(([member, start]) =>
		log.asking.includes(member) || log.shown.some((each) => each.agent === member && each.entry > start)
			? []
			: [member],
	);
}
