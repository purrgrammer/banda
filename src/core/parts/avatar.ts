/** A generated face is a message part, not an identity change. Only the owner's card can apply it. */
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, type JsonObject, type ToolTaskInput } from "@earendil-works/pi-durable";
import { validateAvatarCandidate } from "../../server/avatar-validation.ts";
import type { MessagePart } from "./part.ts";

export const avatar: MessagePart = {
	parameters: {
		avatar: Type.Optional(
			Type.Object(
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
			),
		),
	},
	describe:
		"Give `avatar` to offer a generated face for yourself as a preview card. First read `read_avatar_instructions`. " +
		"Supply geometry data here, never JSON in `text` or a file. Validation may refuse it with errors to correct. " +
		"Only the owner's Use this face button applies it; sending a candidate changes nothing. " +
		"Send it separately from a question, and only in your direct chat, not a group.",
	present: (args) => args.avatar !== undefined,
	refuse: (args) =>
		args.avatar !== undefined && args.question !== undefined
			? "send the face preview separately from a question; its own control lets the owner apply it"
			: undefined,
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
			if (matches.length !== 1 || matches[0]?.name !== "message_user") return undefined;
			return { assistant: Number(input.assistant), index: calls.findIndex((call) => call.id === api.callId) };
		}, ctx);
		if (occurrence === undefined)
			return "the face preview needs an unambiguous direct message call; use a fresh call ID";
		// Only the successful delivery result publishes this receipt. Replay revalidates the durable intent;
		// neither the raw (possibly coerced) model arguments nor a running result can attest geometry.
		return { receipt: { kind: "avatar", ...occurrence, definition: result.definition as unknown as JsonObject } };
	},
};
