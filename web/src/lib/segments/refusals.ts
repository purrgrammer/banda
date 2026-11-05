/**
 * Proposals the daemon refused, in the chat's feed: a `propose_*` call whose result is a refusal and that opened no ask
 * is one quiet line where it was made, "Not proposed: …", the reason in the daemon's own words (`refusalWhy`): it wrote
 * nothing, so nothing else names the call. A refused call followed in the same run by one of the same tool that the
 * daemon took draws no line: that one's line says what was done. Never from the call's arguments.
 */
import type { Segment } from "../chat.ts";
import { refusalWhy, withoutRetried } from "../feed.ts";
import type { Segmenter } from "./types.ts";

export type RefusalSegment = {
	readonly kind: "refusal";
	readonly key: string;
	readonly state: "refused";
	/** Why, in the daemon's words. */
	readonly why: string;
	readonly at?: number;
};

declare module "./types.ts" {
	interface AreaSegments {
		refusal: RefusalSegment;
	}
}

/** The tools that propose something the owner answers, whose refusal is the only trace of the call. */
export const PROPOSALS: ReadonlySet<string> = new Set(["propose_send", "propose_key"]);

export const refusalWords = (segment: Pick<RefusalSegment, "why">) => `Not proposed: ${segment.why}`;

/** A line any area drew for a call the daemon refused. */
const isRefused = (segment: Segment) => "state" in segment && segment.state === "refused";

export const refusals: Segmenter = {
	call: (call, key, at) => {
		if (!PROPOSALS.has(call.name) || at.result?.error !== true) return undefined;
		const asks = at.asks();
		// an ask it opened (a send the owner declined, a key that could not be kept) says how it ended
		if (asks.length > 0) return asks;
		const segment: RefusalSegment = {
			kind: "refusal",
			key,
			state: "refused",
			why: refusalWhy(at.result),
			...(at.result.at === undefined ? {} : { at: at.result.at }),
		};
		return [segment];
	},
	after: (segments, { items }) => withoutRetried(segments, items, isRefused),
	shown: (segment) => (segment.kind === "refusal" ? [refusalWords(segment)] : undefined),
};
