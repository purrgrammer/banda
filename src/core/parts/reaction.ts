/**
 * A reaction (DESIGN.md "Messages"): one emoji on the owner's message the run answers, beside a reply or as the whole
 * of it ("got it", "thanks"), where nothing else needs saying. It is still a message: sent at least once like any other,
 * as its emoji where a gateway has no reactions; the app folds it onto the owner's message instead of a bubble.
 */
import type { EntryId } from "@earendil-works/pi-durable";
import { oneEmoji } from "../choices.ts";
import { errandOf } from "../permissions.ts";
import { WAKE } from "../routines.ts";
import type { MessagePart } from "./part.ts";

const emojiOf = (args: { readonly reaction?: unknown }) =>
	typeof args.reaction === "string" ? oneEmoji(args.reaction) : undefined;

export const reaction: MessagePart = {
	present: (args) => args.reaction !== undefined,
	refuse: (args) =>
		args.reaction === undefined || emojiOf(args) !== undefined ? undefined : "a reaction is exactly one emoji",
	said: (args) => emojiOf(args),
	prepare: async (args, api, ctx, { to }) => {
		// in a group, the room finds the owner's message the member's turn answers (`groups.ts`)
		if (args.reaction === undefined || to === "group") return undefined;
		// it reacts to the owner's message: a routine's run answers nobody's
		return api.commit(async (tx) => {
			const { input } = await errandOf(tx, Number(api.conversationId));
			const entry = input === 0 ? undefined : await tx.entry(input as EntryId);
			return entry === undefined || entry.kind === WAKE
				? "a reaction goes on the owner's message, and this run answers none: say it in words"
				: undefined;
		}, ctx);
	},
};
