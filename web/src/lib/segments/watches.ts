/**
 * Watches in the chat's feed: a `watch` call is one line, where the chat last made or changed that watch. The call's
 * receipt names the file it wrote (the watch, the hash, and whether it made one or changed one in effect); how the
 * line stands is read from the watch as the daemon reports it now (`WatchView`), and when it was removed from what
 * the store keeps: waiting for the owner (its card inline), following, changed, paused, done, not set up or removed
 * since. Never the call's words.
 */
import type { Receipt, WatchView } from "../../../../src/server/api.ts";
import type { Segment } from "../chat.ts";
import { callState, type FeedState, refusalWhy, settled } from "../feed.ts";
import type { Segmenter } from "./types.ts";

type Written = Extract<Receipt, { kind: "watch" }>;

export type WatchCallSegment = {
	readonly kind: "watchCall";
	readonly key: string;
	readonly state: FeedState;
	/** The watch's name, as the call's receipt names the file it wrote. */
	readonly name?: string;
	readonly sha?: string;
	readonly change?: Written["change"];
	/** Why the daemon refused the call, in its words. */
	readonly why?: string;
	/** The watch as the daemon reports it now, when it has it. */
	readonly watch?: WatchView;
	readonly at?: number;
};

declare module "./types.ts" {
	interface AreaSegments {
		watchCall: WatchCallSegment;
	}
	interface ViewContext {
		/** The watches, as the control room last said. */
		readonly watches?: readonly WatchView[];
	}
}

/**
 * How watch `name` stands now, for a line whose call wrote `sha` at `since`: waiting for the owner while any change
 * of it waits; done while what the call wrote is in effect, or was allowed; removed when it was taken out of effect
 * after the call; declined otherwise (never allowed).
 */
export function watchState(
	watches: readonly WatchView[],
	name: string,
	removed: { readonly [path: string]: number } | undefined,
	since = 0,
	sha?: string,
): { state: FeedState; watch?: WatchView } {
	const watch = watches.find((each) => each.name === name);
	if (watch?.change !== undefined) return { state: "pending", watch };
	const allowed =
		watch?.accepted?.watch !== undefined &&
		(sha === undefined || watch.accepted.sha === sha || watch.allowed?.includes(sha) === true);
	if (allowed) return { state: "done", watch };
	const gone = removed?.[`watches/${name}.md`];
	if (gone !== undefined && gone >= since) return { state: "removed" };
	return watch === undefined ? { state: "declined" } : { state: "declined", watch };
}

/** What the watch follows, as its line names it: the daemon's name for the object, else the file's link. */
export function watchObject(segment: Pick<WatchCallSegment, "name" | "watch">): string {
	const { watch } = segment;
	return (
		watch?.object?.name ??
		watch?.accepted?.watch?.object ??
		(watch?.change && "watch" in watch.change ? watch.change.watch?.object : undefined) ??
		segment.name ??
		""
	);
}

/**
 * The line's words, by state, from the watch as it is, as every feed item reads: who, what they did, what to.
 * Without `who` (a search's text), the verb leads.
 */
export function watchCallWords(
	segment: Pick<WatchCallSegment, "state" | "name" | "watch" | "change" | "why">,
	who?: string,
): string {
	const { watch } = segment;
	const what = watchObject(segment);
	const changed = segment.change === "changed";
	const said = (() => {
		switch (segment.state) {
			case "working":
				return "is setting up a watch…";
			case "stopped":
				return "didn't finish setting up a watch";
			case "refused":
				return segment.why === undefined ? "couldn't follow it" : `couldn't follow it: ${segment.why}`;
			case "pending":
				return watch?.change?.kind === "removed"
					? `wants to stop following ${what}`
					: watch?.change?.kind === "changed"
						? `wants to change how it follows ${what}`
						: `wants to follow ${what}`;
			case "declined":
				return changed ? `didn't change how it follows ${what}` : `isn't following ${what}`;
			case "removed":
				return `stopped following ${what}`;
			default:
				if (watch?.state === "done")
					return `finished following ${what}${watch.done === undefined ? "" : `: ${watch.done.why}`}`;
				if (watch?.state === "failing") return `can't reach ${what}`;
				if (watch?.paused !== undefined) return `paused following ${what}`;
				if (changed) return `changed how it follows ${what}`;
				return `followed ${what}`;
		}
	})();
	return who === undefined ? said.replace(/^./, (first) => first.toUpperCase()) : `${who} ${said}`;
}

const TOOLS = new Set(["watch"]);

export const watches: Segmenter = {
	call: (call, key, at) => {
		if (!TOOLS.has(call.name)) return undefined;
		const early = callState(at.result);
		const receipt = early === undefined && at.result?.receipt?.kind === "watch" ? at.result.receipt : undefined;
		const segment: WatchCallSegment = {
			kind: "watchCall",
			key,
			state: early ?? (receipt === undefined ? "refused" : "working"),
			...(receipt === undefined ? {} : { name: receipt.name, sha: receipt.sha, change: receipt.change }),
			...(early === "refused" ? { why: refusalWhy(at.result) } : {}),
			...(at.result?.at === undefined ? {} : { at: at.result.at }),
		};
		return [segment, ...at.asks()];
	},
	// one line per watch: where the chat last made or changed it
	after: (segments, input) => {
		const last = new Map<string, number>();
		segments.forEach((segment, i) => {
			if (segment.kind === "watchCall" && segment.name !== undefined) last.set(segment.name, i);
		});
		return segments.flatMap((segment, i): Segment[] => {
			if (segment.kind !== "watchCall") return [segment];
			if (segment.name === undefined) return [{ ...segment, state: settled(segment.key, segment.state, input) }];
			if (last.get(segment.name) !== i) return [];
			const { watches, removed } = input.context;
			if (watches === undefined) return [segment];
			return [{ ...segment, ...watchState(watches, segment.name, removed, segment.at, segment.sha) }];
		});
	},
	shown: (segment) => (segment.kind === "watchCall" ? [watchCallWords(segment)] : undefined),
};
