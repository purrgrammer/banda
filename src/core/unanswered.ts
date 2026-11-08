/**
 * Whether a run left the owner unanswered (DESIGN.md "Messages"): it answered the owner (the newest input in its chat is
 * theirs, a message or a steer, or a task of theirs going on: a nudge), and since the owner last
 * acted there (wrote, or answered an ask: a question, an approval, the browser handed back) no act of the run toward
 * them went through: a speaking call (`message_user`, `ask_user`, `react`, `publish`, `connect`, …). The final text is notes whatever this says: an unanswered run is nudged, never voiced.
 *
 * Pure, over a chat's rows newest first, so the rule is tested on its own.
 */

import { isMessageTool } from "./toolsets.ts";

/** The owner's peer on every gateway (`gateway.ts`'s `OWNER`). */
const OWNER = "owner";

/** One row of a chat, as the rule reads it: `turn.ts` maps entries to these. */
export type Row =
	/** A person's input: the owner's when `origin.peer` is theirs. */
	| { readonly role: "user"; readonly origin?: { readonly peer: string } }
	/** An input nobody wrote that starts work of its own: a routine's wake. */
	| { readonly role: "other" }
	/** The daemon's nudge to a run that left the owner unanswered: it goes on with the task too. */
	| { readonly role: "nudge" }
	| { readonly role: "assistant"; readonly calls: readonly { readonly id: string; readonly name: string }[] }
	| { readonly role: "tool"; readonly call: string; readonly error: boolean }
	| { readonly role: "wait"; readonly outcome: string; readonly by?: { readonly peer: string } };

/**
 * Undefined when the run that ended at the newest row acted toward the owner, or answered no one's input of theirs;
 * else how many times it was already nudged since the owner last wrote. Rows that stop before an input: undefined.
 */
export function unanswered(newestFirst: Iterable<Row>): { readonly nudged: number } | undefined {
	/** Each call's result: whether it went through. */
	const through = new Map<string, boolean>();
	let answered = false;
	let nudged = 0;
	for (const row of newestFirst) {
		switch (row.role) {
			case "user":
				return row.origin?.peer === OWNER ? { nudged } : undefined;
			case "other":
				return undefined;
			case "nudge":
				nudged++;
				break;
			case "wait":
				if (row.outcome === "answered" && row.by?.peer === OWNER) answered = true;
				break;
			case "tool":
				through.set(row.call, !row.error);
				break;
			case "assistant":
				if (answered) break;
				for (const call of row.calls) {
					if (isMessageTool(call.name) && through.get(call.id) === true) return undefined;
				}
		}
	}
	return undefined;
}
