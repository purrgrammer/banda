/**
 * Memory in the chat's feed: a `remember` or `forget` call is one line, at the point it happened. Its subject is the
 * fact the daemon's receipt names (`Receipt`, as its file held it); how the line stands is read from memory as the
 * daemon reports it now (`MemoryView`), never from the call's arguments: a fact in memory reads "Remembered", one that
 * left memory since says so. A call the daemon refused, or that never answered, wrote nothing the line could claim.
 */
import type { FactView, MemoryView } from "../../../../src/server/api.ts";
import { callState, type FeedState, settled } from "../feed.ts";
import type { Segmenter } from "./types.ts";

export type MemorySegment = {
	readonly kind: "memory";
	readonly key: string;
	readonly act: "remember" | "forget";
	readonly state: FeedState;
	/** The fact the daemon named, as its file held it when the call wrote or took it out. */
	readonly fact?: { readonly id: string; readonly text: string };
	/** The fact as memory holds it now, when it does. */
	readonly view?: FactView;
	readonly at?: number;
};

declare module "./types.ts" {
	interface AreaSegments {
		memory: MemorySegment;
	}
	interface ViewContext {
		/** What the companion knows, as the daemon last said. */
		readonly memory?: MemoryView;
	}
}

/** How a call's fact stands in `memory` now. */
export function memoryState(
	act: MemorySegment["act"],
	id: string,
	memory: MemoryView,
): { state: FeedState; view?: FactView } {
	if (memory.unavailable) return { state: "pending" };
	const view = memory.facts.find((fact) => fact.id === id);
	if (act === "forget") return view === undefined ? { state: "done" } : { state: "declined", view };
	if (view !== undefined) return { state: "done", view };
	return { state: "removed" };
}

/** The line's words, by state: plain, and never "Remembered" for a fact memory does not hold. */
export function memoryWords(segment: Pick<MemorySegment, "act" | "state" | "fact" | "view">): string {
	if (segment.state === "pending") return "Can't check memory right now";
	const text = segment.view?.text ?? segment.fact?.text ?? "";
	if (segment.act === "forget")
		switch (segment.state) {
			case "working":
				return "Forgetting…";
			case "stopped":
				return "Didn't finish forgetting";
			case "refused":
				return "Nothing forgotten";
			case "declined":
				return `Kept: ${text}`;
			default:
				return `Forgot: ${text}`;
		}
	switch (segment.state) {
		case "working":
			return "Remembering…";
		case "stopped":
			return "Didn't finish remembering";
		case "refused":
			return "Not remembered";
		case "done":
			return `Remembered: ${text}`;
		case "declined":
			return `Not kept in mind: ${text}`;
		default:
			return `Forgotten since: ${text}`;
	}
}

const ACTS = new Set(["remember", "forget"]);

export const memory: Segmenter = {
	call: (call, key, at) => {
		if (!ACTS.has(call.name)) return undefined;
		const act = call.name as MemorySegment["act"];
		const named = at.result?.receipt;
		const receipt = named?.kind === "fact" ? named : undefined;
		const early = callState(at.result);
		const segment: MemorySegment = {
			kind: "memory",
			key,
			act,
			// answered without naming a fact (a forget of none): nothing changed
			state: early ?? (receipt === undefined ? "refused" : "working"),
			...(receipt === undefined || early !== undefined ? {} : { fact: { id: receipt.id, text: receipt.text } }),
			...(at.result?.at === undefined ? {} : { at: at.result.at }),
		};
		return [segment, ...at.asks()];
	},
	after: (segments, input) =>
		segments.map((segment) => {
			if (segment.kind !== "memory") return segment;
			// a fact named, and memory known: how it stands now; else still working, until the stream says
			if (segment.fact !== undefined)
				return input.context.memory === undefined
					? segment
					: { ...segment, ...memoryState(segment.act, segment.fact.id, input.context.memory) };
			return { ...segment, state: settled(segment.key, segment.state, input) };
		}),
	shown: (segment) => (segment.kind === "memory" ? [memoryWords(segment)] : undefined),
};
