/**
 * The owner as a fault worker plays them: answers an open ask and fails the run when the daemon refused the answer.
 * A worker polls the open asks until its Turn ends, so a refusal it ignored would be asked again forever. Only the
 * refusals a poll can race are passed over: the ask ended, or was answered (by this owner or a permission), since
 * it was listed.
 */
import { answer } from "../../src/core/wait.ts";

const RACES = new Set(["this ask is closed", "this ask was already answered", "no open ask has this id"]);

export async function ownerAnswer(...args: Parameters<typeof answer>): ReturnType<typeof answer> {
	const filled = await answer(...args);
	if ("refused" in filled && !RACES.has(filled.refused))
		throw new Error(`the owner's answer to ${args[1]} was refused: ${filled.refused}`);
	return filled;
}
