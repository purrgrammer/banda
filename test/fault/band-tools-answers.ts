/**
 * What the band fault sweep (test/band-tools.faults.test.ts) lets an answer say under a fault, as pure rules over an
 * answer's tool and words, so they are tested on their own (test/band-tools-answers.test.ts) and nothing else
 * decides them.
 */
import type { Fault } from "./faults.ts";

export type Answer = { readonly tool: string; readonly error: boolean; readonly text: string };

/** update_agent's fail-closed refusal while the new agent's box file is still being written (src/core/band-tools.ts). */
export const PENDING =
	"Not updated: agents/writer.md in the workspace is not the version in effect: a change to it waits for the owner, or is still being written.";
/**
 * What the first write's skill note reads when it is in the answer (src/box/tools.ts `skillInEffect`, severity info):
 * the only note a cut write can carry. Only the first write can be cut, since the one fault fires before any retry,
 * and it adds the skill. A retried write of the same bytes leaves no note. The sweep checks this text against the
 * product's own words.
 */
export const SKILL_ADDED =
	"[info] skills/notes/SKILL.md is in effect: the skill /notes was added, and the owner sees it on the Skills page. It gives no tool, connection or permission.";
/** pi-durable's two words for a call a cut left in `execute` (harness/tool.js), the second after a restart's abort. */
const INTERRUPTED_WORDS = [
	"Tool write was interrupted and may have partially run",
	"Tool write was interrupted by a restart and may have partially run",
];
/**
 * The box's `write` reported interrupted, which is never run again (src/box/tools.ts), exactly as the model reads it.
 * pi-durable rebuilds the answer from the call's durable slot: what the slot holds, then one error diagnostic
 * (harness/tool.js `fromSlot`). It gives them in its envelope, one line each
 * (`<harness>\n[<severity>] <message>\n</harness>`). Write streams no output, so the slot holds diagnostics alone. A
 * diagnostic reaches the slot as soon as it is made, since chord's Progress commits the first change after idle at
 * once. So the skill note is there when the cut came after that commit, and not otherwise. Those two forms, and no
 * other.
 */
export function isInterruptedWrite(text: string): boolean {
	return INTERRUPTED_WORDS.some((words) =>
		["", `${SKILL_ADDED}\n`].some((held) => text === `<harness>\n${held}[error] ${words}\n</harness>`),
	);
}
/** An injected fault's own words (test/fault/faults.ts): none may reach an answer, but for the one note below. */
export const LEAKED = /InjectedFault|\b(commit|agent):[a-z:]+ #\d+/;
/**
 * The one place a fault's words reach an answer truthfully: a thrown fault at an `agent:*` box publication point is
 * the reason `once` gives in a successful create_agent or update_agent answer that its file is not written yet
 * (src/core/band-tools.ts), word for word, with the fault's own point and hit (test/fault/faults.ts).
 */
export const NOT_WRITTEN = "Not written to the workspace yet";
export const unwritten = (fault: Fault) =>
	` ${NOT_WRITTEN} (${fault.point} #${fault.hit}): the file follows when the computer can be written.`;

/** An answer's words with that note set aside, only where it is the note for this fault on a success that may carry it. */
export function withoutNote(answer: Answer, fault: Fault | undefined): string {
	if (fault?.kind !== "error" || !fault.point.startsWith("agent:")) return answer.text;
	if (answer.error || (answer.tool !== "create_agent" && answer.tool !== "update_agent")) return answer.text;
	const note = unwritten(fault);
	return answer.text.endsWith(note) ? answer.text.slice(0, -note.length) : answer.text;
}

/** Whether an error answer is one a cut may honestly leave before the owner's "try again", which makes it good. */
export const allowed = (answer: Answer, fault: Fault | undefined) =>
	(answer.tool === "update_agent" && answer.text === PENDING && fault?.point.startsWith("agent:") === true) ||
	(answer.tool === "write" && isInterruptedWrite(answer.text));
