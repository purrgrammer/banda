/**
 * A harness at work in the chat: an agent's `harness__work` call that started one is drawn as its session, live, in
 * the call's place. A call refused, or not answered yet, draws nothing: the agent says why in its own words.
 */
import type { Segmenter } from "./types.ts";

declare module "./types.ts" {
	interface AreaSegments {
		harness: {
			readonly kind: "harness";
			readonly key: string;
			/** The call that started it: how the session is found in the shell. */
			readonly call: string;
		};
	}
}

export const harness: Segmenter = {
	call: (call, key, { result, asks }) => {
		if (call.name !== "harness__work") return undefined;
		if (result === undefined || result.error === true) return asks();
		return [...asks(), { kind: "harness", key: `${key}:harness`, call: call.id }];
	},
	shown: (segment) => (segment.kind === "harness" ? [] : undefined),
};
