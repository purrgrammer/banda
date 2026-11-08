/**
 * The activity log (DESIGN.md "The app"): what routines, effects and the owner did, in the daemon's words, never the
 * model's. A bookkeeping doc written in the commit of what it records: nothing else holds those facts.
 */
import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import { markForeign } from "./foreign.ts";

/**
 * One thing done, in words; `outside` when it reached outside the box: a read, or a request sent for the owner, with
 * the hash of its exact bytes.
 */
export type Activity = {
	at: number;
	routine?: string;
	watch?: string;
	what: string;
	chat?: number;
	outside?: "read" | "sent";
	hash?: string;
};

/** The activity kept, newest last. */
export const ACTIVITY_KEPT = 100;

export const ActivityLog = defineDoc<{ events: Activity[] }>({
	kind: "banda.activity",
	version: 1,
	scope: "session",
	initial: () => ({ events: [] }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

/** Record one thing done; a read from outside marks its chat's task as having read foreign content (`foreign.ts`). */
export async function log(tx: Tx, event: Activity): Promise<void> {
	if (event.outside === "read" && event.chat !== undefined) await markForeign(tx, event.chat);
	const { events } = await tx.doc(ActivityLog);
	events.push({ ...event });
	if (events.length > ACTIVITY_KEPT) events.splice(0, events.length - ACTIVITY_KEPT);
}
