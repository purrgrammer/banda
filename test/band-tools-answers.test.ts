/**
 * The band fault sweep's answer rules (test/fault/band-tools-answers.ts), on the words the model really reads: the
 * interrupted write in pi-durable's envelope as run 45987599523 printed it, the one publication note, and what must
 * not pass.
 */
import { describe, expect, it } from "vitest";
import {
	allowed,
	isInterruptedWrite,
	LEAKED,
	PENDING,
	SKILL_ADDED,
	unwritten,
	withoutNote,
} from "./fault/band-tools-answers.ts";
import type { Fault } from "./fault/faults.ts";

/** As printed by faults 1/6 of run 45987599523 (c9cbc27), at commit:after #27. */
const INTERRUPTED_SEEN = "<harness>\n[error] Tool write was interrupted and may have partially run\n</harness>";
const RESTARTED = "<harness>\n[error] Tool write was interrupted by a restart and may have partially run\n</harness>";
const commit: Fault = { point: "commit:after", hit: 27, kind: "error" };
const publication: Fault = { point: "agent:directory:before", hit: 1, kind: "error" };

describe("the band sweep's answer rules", () => {
	it("allows the interrupted write exactly as the model reads it, and nothing near it", () => {
		expect(isInterruptedWrite(INTERRUPTED_SEEN)).toBe(true);
		expect(isInterruptedWrite(RESTARTED)).toBe(true);
		// cut after the skill note's progress commit: the note the slot held, then the error, one line each
		const held = INTERRUPTED_SEEN.replace("<harness>\n", `<harness>\n${SKILL_ADDED}\n`);
		expect(isInterruptedWrite(held)).toBe(true);
		expect(isInterruptedWrite(RESTARTED.replace("<harness>\n", `<harness>\n${SKILL_ADDED}\n`))).toBe(true);
		expect(allowed({ tool: "write", error: true, text: held }, commit)).toBe(true);
		// any other note, the same note changed, twice, or after the error: not allowed
		for (const text of [
			INTERRUPTED_SEEN.replace("<harness>\n", "<harness>\n[info] something else\n"),
			held.replace("was added", "was changed"),
			held.replace("[info]", "[warn]"),
			held.replace(`${SKILL_ADDED}\n`, `${SKILL_ADDED}\n${SKILL_ADDED}\n`),
			INTERRUPTED_SEEN.replace("\n</harness>", `\n${SKILL_ADDED}\n</harness>`),
			held.replace("[error] Tool write", "[error] Tool bash"),
		])
			expect(isInterruptedWrite(text), text).toBe(false);
		expect(allowed({ tool: "write", error: true, text: INTERRUPTED_SEEN }, commit)).toBe(true);
		for (const text of [
			"Tool write was interrupted and may have partially run",
			`${INTERRUPTED_SEEN}\n`,
			`Wrote it.${INTERRUPTED_SEEN}`,
			INTERRUPTED_SEEN.replace("[error]", "[info]"),
			INTERRUPTED_SEEN.replace("Tool write", "Tool bash"),
			INTERRUPTED_SEEN.replace("</harness>", "\n[error] commit:after #27\n</harness>"),
		])
			expect(isInterruptedWrite(text), text).toBe(false);
		// another tool's interruption is never allowed, whatever its words
		expect(allowed({ tool: "create_group", error: true, text: INTERRUPTED_SEEN }, commit)).toBe(false);
	});

	it("allows update_agent's pending refusal only under a publication fault", () => {
		expect(allowed({ tool: "update_agent", error: true, text: PENDING }, publication)).toBe(true);
		expect(allowed({ tool: "update_agent", error: true, text: PENDING }, commit)).toBe(false);
		expect(allowed({ tool: "update_agent", error: true, text: `${PENDING} ` }, publication)).toBe(false);
		expect(allowed({ tool: "create_agent", error: true, text: PENDING }, publication)).toBe(false);
	});

	it("sets aside only this fault's publication note on a band success, and the leak check sees the rest", () => {
		const made = 'Created the agent "Writer" (writer). It is in the band now, and the owner is shown it.';
		const noted = `${made}${unwritten(publication)}`;
		expect(LEAKED.test(noted)).toBe(true);
		expect(withoutNote({ tool: "create_agent", error: false, text: noted }, publication)).toBe(made);
		expect(withoutNote({ tool: "update_agent", error: false, text: noted }, publication)).toBe(made);
		// another fault's note, an error answer, another tool, a kill, or a commit fault: kept, so the leak check fails it
		for (const [answer, fault] of [
			[
				{ tool: "create_agent", error: false, text: noted },
				{ ...publication, hit: 2 },
			],
			[{ tool: "create_agent", error: true, text: noted }, publication],
			[{ tool: "write", error: false, text: noted }, publication],
			[
				{ tool: "create_agent", error: false, text: noted },
				{ ...publication, kind: "kill" },
			],
			[{ tool: "create_agent", error: false, text: noted }, commit],
		] as const)
			expect(LEAKED.test(withoutNote(answer, fault)), JSON.stringify({ answer, fault })).toBe(true);
		expect(LEAKED.test(made)).toBe(false);
	});
});
