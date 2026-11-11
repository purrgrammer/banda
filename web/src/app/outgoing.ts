/**
 * The owner's messages on their way: each shows from the moment it is sent until the daemon accounts for it,
 * and never after. The daemon accounts for one in one of three ways: as an entry in the transcript, as an input queued
 * behind the run (shown as any message until the run takes it), or, when the chat held an open question, as that question's answer
 * (shown on its card). Only the first two carry the message's id, so the third is settled by the post's own answer.
 */
import type { Item, Posted, Queued } from "../lib/api.ts";

export type PendingMessage = {
	readonly id: string;
	readonly text: string;
	readonly files: readonly File[];
	readonly state: "sending" | "failed";
};

/** The ids of the owner's messages the transcript shows: its entries and its queued inputs. */
export function shownMessages(items: readonly Item[], queued: readonly Queued[]): ReadonlySet<string> {
	return new Set([
		...items.flatMap((item) => (item.role === "user" && item.message !== undefined ? [item.message] : [])),
		...queued.flatMap((one) => (one.message === undefined ? [] : [one.message])),
	]);
}

/** What still shows as on its way: whatever the transcript does not show yet. */
export const stillPending = (outgoing: readonly PendingMessage[], shown: ReadonlySet<string>) =>
	outgoing.filter((item) => !shown.has(item.id));

/** Whether the post's answer itself settles it: it answered the open question, so no entry will carry its id. */
export const settledByAnswer = (posted: Posted) => "answered" in posted;
