/** The owner's read position: entries and tasks derive everything else about unread chats. */
import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import { context } from "./store.ts";

export const ChatReads = defineDoc<{ chats: { [chat: string]: number } }>({
	kind: "banda.chat-reads",
	version: 1,
	scope: "session",
	initial: () => ({ chats: {} }),
	checkpointWhen: () => true,
});

/** Read only through the latest entry actually shown, never beyond it or backwards after another tab read later. */
export function readChat(
	harness: Harness,
	chat: number,
	through?: number,
	_now = Date.now(),
	ctx: Context = context,
): Promise<boolean> {
	return harness.commit(async (tx) => {
		const conversationId = chat as ConversationId;
		if ((await tx.conversation(conversationId)) === undefined) return false;
		const tail = (await tx.scanEntries({ conversationId, order: "descending" }, 1)).items[0];
		const cursor = (await tx.doc(ChatReads)).chats;
		cursor[chat] = Math.max(cursor[chat] ?? 0, Math.min(Number(tail?.id ?? 0), through ?? Number(tail?.id ?? 0)));
		return true;
	}, ctx);
}

/** The owner's read position in each group's log, by room: the newest entry read. */
export const GroupReads = defineDoc<{ rooms: { [room: string]: number } }>({
	kind: "banda.group-reads",
	version: 1,
	scope: "session",
	initial: () => ({ rooms: {} }),
	checkpointWhen: () => true,
});

/** Read group `room` through entry `through`: forward only, so a stale tab never unreads what another read. */
export function readGroup(harness: Harness, room: number, through: number, ctx: Context = context): Promise<void> {
	return harness.commit(async (tx) => {
		const reads = (await tx.doc(GroupReads)).rooms;
		reads[room] = Math.max(reads[room] ?? 0, through);
	}, ctx);
}
