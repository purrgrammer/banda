/**
 * A reaction (DESIGN.md "Messages"): one emoji on the owner's message the run answers, beside a reply or as the whole
 * of it ("got it", "thanks"), where nothing else needs saying. It is still a message: sent at least once like any other,
 * as its emoji where a gateway has no reactions; the app folds it onto the owner's message instead of a bubble.
 */
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { oneEmoji } from "../choices.ts";
import { WAKE } from "../routines.ts";
import type { MessagePart } from "./part.ts";

const emojiOf = (args: { readonly reaction?: unknown }) =>
	typeof args.reaction === "string" ? oneEmoji(args.reaction) : undefined;

/** Whether `chat`'s newest input of a person's or a routine's is the owner's message (a steer included). Reads only. */
async function answersOwner(tx: Tx, chat: number): Promise<boolean> {
	let cursor: Parameters<Tx["scanEntries"]>[2];
	do {
		const page = await tx.scanEntries({ conversationId: chat as ConversationId }, 50, cursor);
		const input = page.items.find(
			(item) => item.model?.[0]?.role === "user" && (item.kind === "banda.inbound" || item.kind === WAKE),
		);
		if (input !== undefined) return input.kind !== WAKE;
		cursor = page.next;
	} while (cursor !== undefined);
	return false;
}

export const reaction: MessagePart = {
	present: (args) => args.reaction !== undefined,
	refuse: (args) =>
		args.reaction === undefined || emojiOf(args) !== undefined ? undefined : "a reaction is exactly one emoji",
	said: (args) => emojiOf(args),
	prepare: async (args, api, ctx, { to }) => {
		// in a group, the room finds the owner's message the member's turn answers (`groups.ts`)
		if (args.reaction === undefined || to === "group") return undefined;
		// it reacts to the owner's message: a routine's run answers nobody's
		return api.commit(
			async (tx) =>
				(await answersOwner(tx, Number(api.conversationId)))
					? undefined
					: "a reaction goes on the owner's message, and this run answers none: say it in words",
			ctx,
		);
	},
};
