/**
 * What an area adds to a chat's segments (`../chat.ts`), in its own file, so the areas grow side by side: its segment
 * kinds, what it needs to make them, and the hooks that make them. Pure, like `chat.ts`: types alone are imported.
 */
import type { Item, ShownWait, ToolCall } from "../../../../src/server/api.ts";
import type { Live, Segment } from "../chat.ts";

/**
 * Each area's segment kinds, by kind. An area adds its own by augmenting this interface in its own file:
 * `declare module "./types.ts" { interface AreaSegments { routine: { kind: "routine"; key: string; … } } }`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: each area augments it
export interface AreaSegments {}
export type AreaSegment = AreaSegments[keyof AreaSegments];

/**
 * What a chat's view is made from besides its items, its open asks and its live state (the tasks, the browser…). An
 * area adds its own field, optional, by augmenting this interface, and the chat passes it.
 */
// biome-ignore lint/suspicious/noEmptyInterface: each area augments it
export interface ViewContext {}

export type ViewInput = {
	readonly items: readonly Item[];
	readonly waits: readonly ShownWait[];
	readonly live: Live;
	readonly context: ViewContext;
};

export type Segmenter = {
	/**
	 * The segments of a tool call other than `message_user`, in place of its asks (`asks()` makes those); undefined
	 * leaves the call to the next area, and to its asks alone after the last.
	 */
	readonly call?: (
		call: ToolCall,
		key: string,
		at: {
			readonly result?: Extract<Item, { role: "tool" }>;
			readonly asks: () => Segment[];
			/** What the chat's view is made from besides its items: a call is found by its id in what the store holds. */
			readonly context: ViewContext;
		},
	) => Segment[] | undefined;
	/** Segments that follow a `message_user` call's message (an artifact it published…). */
	readonly message?: (
		call: ToolCall,
		key: string,
		at: {
			readonly result?: Extract<Item, { role: "tool" }>;
			readonly occurrence?: { readonly assistant: number; readonly index: number };
		},
	) => Segment[];
	/** A pass over the whole list once it is built: insert, replace or drop. */
	readonly after?: (segments: Segment[], input: ViewInput) => Segment[];
	/** Every string a segment of its own kinds shows the owner; undefined for a kind not its own. */
	readonly shown?: (segment: AreaSegment) => readonly string[] | undefined;
};
