/**
 * Which working faces a group's feed shows, and which message each became. A member's message takes the key of the
 * face that stood for its work, so the face stays one element from the work to the reply. What was seen lives here,
 * between renders of one open group; nothing of it is stored.
 */
export type FaceTandas = {
	/** Each member's face at the foot of the feed: its key. */
	readonly open: Map<string, string>;
	/** A message that came out of a face: the face's key. */
	readonly taken: Map<number, string>;
	/** The newest message already matched to a face. */
	seen: number;
};

export const noTandas = (): FaceTandas => ({ open: new Map(), taken: new Map(), seen: -1 });

type Log = {
	readonly latest: number;
	readonly messages: readonly { readonly entry: number; readonly author: { readonly agent: string } | object }[];
};

/**
 * The faces to draw, updating `tandas` with what this log shows. A member stays while the row says it works and until
 * the log caught up with the row: the run's end and its reply reach the page in two steps, and the face must not go
 * in between.
 */
export function groupFaces(
	tandas: FaceTandas,
	log: Log | undefined,
	working: readonly string[],
	rowLatest: number | undefined,
): readonly { readonly member: string; readonly key: string }[] {
	if (log === undefined) return [];
	for (const message of log.messages) {
		if (message.entry <= tandas.seen || !("agent" in message.author)) continue;
		const key = tandas.open.get(message.author.agent);
		if (key === undefined) continue;
		tandas.taken.set(message.entry, key);
		tandas.open.delete(message.author.agent);
	}
	tandas.seen = Math.max(tandas.seen, log.latest);
	const behind = rowLatest !== undefined && rowLatest > log.latest;
	for (const member of working) if (!tandas.open.has(member)) tandas.open.set(member, `face:${member}:${log.latest}`);
	if (!behind) for (const member of tandas.open.keys()) if (!working.includes(member)) tandas.open.delete(member);
	return [...tandas.open].map(([member, key]) => ({ member, key }));
}
