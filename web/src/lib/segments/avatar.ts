/** Only a completed, successful message call has passed isolated geometry validation. Never render raw pending args. */
import type { AvatarDefinition } from "open-bot-avatar";
import type { Segmenter } from "./types.ts";

declare module "./types.ts" {
	interface AreaSegments {
		avatar: {
			readonly kind: "avatar";
			readonly key: string;
			readonly definition: AvatarDefinition;
			readonly at?: number;
		};
	}
}

export const avatar: Segmenter = {
	message: (call, key, { result, occurrence }) => {
		const receipt = result?.receipt;
		if (
			call.name !== "message_user" ||
			result?.name !== "message_user" ||
			result.call !== call.id ||
			result.error !== false ||
			receipt?.kind !== "avatar" ||
			occurrence === undefined ||
			receipt.assistant !== occurrence.assistant ||
			receipt.index !== occurrence.index
		)
			return [];
		return [
			{
				kind: "avatar",
				key: `${key}:avatar`,
				// Only the normalized worker-validated data, never the provider's raw/coerced arguments.
				definition: receipt.definition,
				...(result.at === undefined ? {} : { at: result.at }),
			},
		];
	},
	shown: (segment) => (segment.kind === "avatar" ? ["Face preview", segment.definition.name] : undefined),
};
