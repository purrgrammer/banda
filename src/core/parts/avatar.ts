/** A generated face is a message part, not an identity change. Only the owner's card can apply it. */
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, type JsonObject, type ToolTaskInput } from "@earendil-works/pi-durable";
import { validateAvatarCandidate } from "../../server/avatar-validation.ts";
import { PROPOSE_AVATAR } from "../toolsets.ts";
import type { MessagePart } from "./part.ts";

/** A face as geometry: what `propose_avatar` takes, which validation checks before any card is shown. */
export const AVATAR_GEOMETRY = Type.Object(
	{
		version: Type.Literal(1),
		id: Type.String({ minLength: 1, maxLength: 40 }),
		name: Type.String({ minLength: 1, maxLength: 40 }),
		body: Type.Object({ path: Type.String({ minLength: 1, maxLength: 6000 }) }, { additionalProperties: false }),
		eyes: Type.Object(
			{ x: Type.Number(), y: Type.Number(), spacing: Type.Number(), scale: Type.Number() },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const avatar: MessagePart = {
	present: (args) => args.avatar !== undefined,
	said: (args) =>
		args.avatar === undefined
			? undefined
			: "A face candidate is ready to preview in our direct chat in the app. Nothing has changed yet.",
	prepare: async (args, api, ctx) => {
		if (args.avatar === undefined) return undefined;
		const result = await validateAvatarCandidate(JSON.stringify(args.avatar));
		if (!result.ok) return `the face could not be previewed: ${result.errors.join("; ")}`;
		// Provider call IDs are not unique. Bind to the immutable assistant entry and call position instead.
		// The substrate resolves duplicate IDs within one entry by ID, so refuse that ambiguous case entirely.
		const occurrence = await api.commit(async (tx) => {
			const task = await tx.task(api.taskId);
			const input = task?.input as ToolTaskInput | undefined;
			if (input?.kind !== "model" || input.callId !== api.callId) return undefined;
			const entry = await tx.entry(AssistantEntry, input.assistant);
			const message = entry?.model?.[0];
			if (message?.role !== "assistant") return undefined;
			const calls = message.content.filter((part) => part.type === "toolCall");
			const matches = calls.filter((call) => call.id === api.callId);
			if (matches.length !== 1 || matches[0]?.name !== PROPOSE_AVATAR) return undefined;
			return { assistant: Number(input.assistant), index: calls.findIndex((call) => call.id === api.callId) };
		}, ctx);
		if (occurrence === undefined) return "the face preview needs an unambiguous call; use a fresh call ID";
		// Only the successful delivery result publishes this receipt. Replay revalidates the durable intent;
		// neither the raw (possibly coerced) model arguments nor a running result can attest geometry.
		return { receipt: { kind: "avatar", ...occurrence, definition: result.definition as unknown as JsonObject } };
	},
};
