/**
 * Routines in the chat's feed: a `schedule` call is one line, where the chat last made or changed that
 * routine. The call's receipt names the file it wrote (the routine, the hash, and whether it made one or changed one
 * in effect); how the line stands is read from the routine as the daemon reports it now (`RoutineView`), and when it was
 * removed from what the store keeps: waiting for the owner (its card inline), scheduled, changed, paused, ran, needing
 * attention, not set up or not changed, or removed since. Never the call's description or schedule. The line shows
 * the face of the agent the routine runs as.
 */
import type { AvatarFace } from "../../../../src/core/avatar-face.ts";
import type { Receipt, RoutineView } from "../../../../src/server/api.ts";
import type { Segment } from "../chat.ts";
import { callState, type FeedState, refusalWhy, settled } from "../feed.ts";
import type { Segmenter } from "./types.ts";

type Written = Extract<Receipt, { kind: "routine" }>;

export type RoutineSegment = {
	readonly kind: "routine";
	readonly key: string;
	readonly state: FeedState;
	/** The routine's name, as the call's receipt names the file it wrote. */
	readonly name?: string;
	/** The hash of what the call wrote, and whether it made the routine, changed one in effect, or found it as written. */
	readonly sha?: string;
	readonly change?: Written["change"];
	/** Why the daemon refused the call, in its words. */
	readonly why?: string;
	/** The routine as the daemon reports it now, when it has it. */
	readonly routine?: RoutineView;
	/** The agent it runs as, when not the lead: its name and face. The lead's is the companion's. */
	readonly runsAs?: { readonly name: string; readonly face: AvatarFace };
	readonly at?: number;
};

declare module "./types.ts" {
	interface AreaSegments {
		routine: RoutineSegment;
	}
	interface ViewContext {
		/** The routines, as the control room last said. */
		readonly routines?: readonly RoutineView[];
	}
}

/**
 * How routine `name` stands now, for a line whose call wrote `sha` at `since`: waiting for the owner while any change
 * of it waits; done while what the call wrote is in effect, or was allowed (whatever the owner changed since); removed
 * when it was taken out of effect after the call; declined otherwise (never allowed).
 */
export function routineState(
	routines: readonly RoutineView[],
	name: string,
	removed: { readonly [path: string]: number } | undefined,
	since = 0,
	sha?: string,
): { state: FeedState; routine?: RoutineView } {
	const routine = routines.find((each) => each.name === name);
	if (routine?.change !== undefined) return { state: "pending", routine };
	const allowed =
		routine?.accepted?.routine !== undefined &&
		(sha === undefined || routine.accepted.sha === sha || routine.allowed?.includes(sha) === true);
	if (allowed) return { state: "done", routine };
	const gone = removed?.[`routines/${name}.md`];
	if (gone !== undefined && gone >= since) return { state: "removed" };
	return routine === undefined ? { state: "declined" } : { state: "declined", routine };
}

/** The line's words, by state, from the routine as it is. */
export function routineWords(segment: Pick<RoutineSegment, "state" | "name" | "routine" | "change" | "why">): string {
	const { routine } = segment;
	const what =
		routine?.accepted?.routine?.description ??
		(routine?.change && "routine" in routine.change ? routine.change.routine?.description : undefined) ??
		segment.name ??
		"";
	const changed = segment.change === "changed";
	switch (segment.state) {
		case "working":
			return "Setting up a routine…";
		case "stopped":
			return "Didn't finish setting up a routine";
		case "refused":
			return segment.why === undefined ? "No routine set up" : `No routine set up: ${segment.why}`;
		case "pending":
			return routine?.change?.kind === "removed"
				? `Remove routine ${what}? Waiting for you`
				: routine?.change?.kind === "changed"
					? `Routine change: ${what} · waiting for you`
					: `New routine: ${what} · waiting for you`;
		case "declined":
			return changed ? `Routine not changed: ${what}` : `Routine not set up: ${what}`;
		case "removed":
			return `Routine removed: ${what}`;
		default:
			if (routine?.state === "done") return `Routine ran: ${what}`;
			if (routine?.state === "failing" || routine?.state === "limit") return `Routine needs attention: ${what}`;
			if (routine?.paused !== undefined) return `Routine paused: ${what}`;
			if (changed) return `Routine changed: ${what}`;
			return `Routine scheduled: ${what}`;
	}
}

const TOOLS = new Set(["schedule"]);

export const routines: Segmenter = {
	call: (call, key, at) => {
		if (!TOOLS.has(call.name)) return undefined;
		const early = callState(at.result);
		// the file is known only from the receipt of the daemon's write
		const receipt = early === undefined && at.result?.receipt?.kind === "routine" ? at.result.receipt : undefined;
		const segment: RoutineSegment = {
			kind: "routine",
			key,
			state: early ?? (receipt === undefined ? "refused" : "working"),
			...(receipt === undefined ? {} : { name: receipt.name, sha: receipt.sha, change: receipt.change }),
			...(early === "refused" ? { why: refusalWhy(at.result) } : {}),
			...(at.result?.at === undefined ? {} : { at: at.result.at }),
		};
		return [segment, ...at.asks()];
	},
	// one line per routine: where the chat last made or changed it
	after: (segments, input) => {
		const last = new Map<string, number>();
		segments.forEach((segment, i) => {
			if (segment.kind === "routine" && segment.name !== undefined) last.set(segment.name, i);
		});
		return segments.flatMap((segment, i): Segment[] => {
			if (segment.kind !== "routine") return [segment];
			if (segment.name === undefined) return [{ ...segment, state: settled(segment.key, segment.state, input) }];
			if (last.get(segment.name) !== i) return [];
			const { routines, removed, agents } = input.context;
			if (routines === undefined) return [segment];
			const now = routineState(routines, segment.name, removed, segment.at, segment.sha);
			const agent =
				now.routine?.agent === undefined ? undefined : agents?.find((each) => each.name === now.routine?.agent);
			const shown = agent?.accepted?.agent;
			return [
				{ ...segment, ...now, ...(shown === undefined ? {} : { runsAs: { name: shown.name, face: shown.face } }) },
			];
		});
	},
	shown: (segment) => (segment.kind === "routine" ? [routineWords(segment)] : undefined),
};
