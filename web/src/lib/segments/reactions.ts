/**
 * The owner's message in the chat, with a reaction only when the agent actually sent one. Pure, like `../chat.ts`.
 */
import type { Item } from "../../../../src/server/api.ts";
import type { Segment, SegmentFile } from "../chat.ts";
import type { Segmenter, ViewInput } from "./types.ts";

declare module "./types.ts" {
	interface AreaSegments {
		/** The owner's words, with a reaction only when the agent sent one. */
		"owner-message": {
			readonly kind: "owner-message";
			readonly key: string;
			readonly text: string;
			readonly files: readonly SegmentFile[];
			readonly at?: number;
			/** The emoji the agent put on it. */
			readonly reaction?: string;
		};
	}
}

/**
 * Only reactions that a successful `message_user` sent, attributed to the owner's message that run answered.
 */
export function reactionsOf(items: readonly Item[]): Map<number, string> {
	const results = new Map<string, Extract<Item, { role: "tool" }>>();
	for (const item of items) if (item.role === "tool") results.set(item.call, item);
	const out = new Map<number, string>();
	let answering: number | undefined;
	for (const item of items) {
		if (item.role === "user") {
			answering = item.id;
			continue;
		}
		if (item.role !== "assistant" || answering === undefined) continue;
		for (const call of item.calls ?? []) {
			const emoji = (call.args as { reaction?: unknown }).reaction;
			if (call.name !== "message_user" || typeof emoji !== "string") continue;
			// A proposed call is not a sent reaction; wait for its successful tool result.
			if (results.get(call.id)?.error !== false) continue;
			if (emoji.trim() !== "") out.set(answering, emoji.trim());
		}
	}
	return out;
}

export function withReactions(segments: Segment[], { items }: ViewInput): Segment[] {
	const reactions = reactionsOf(items);
	return segments.map((segment): Segment => {
		if (segment.kind !== "owner") return segment;
		const reaction = reactions.get(Number(segment.key));
		return { ...segment, kind: "owner-message", ...(reaction === undefined ? {} : { reaction }) };
	});
}

export const reactions: Segmenter = {
	after: withReactions,
	shown: (segment) => {
		if (segment.kind === "owner-message")
			return [segment.text, ...segment.files.map((file) => file.name), segment.reaction ?? ""];
		return undefined;
	},
};
