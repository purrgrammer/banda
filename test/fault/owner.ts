/**
 * The owner as a fault worker plays them: answers an open ask and fails the run when the daemon refused the answer.
 * A worker polls the open asks until its Turn ends, so a refusal it ignored would be asked again forever. Only the
 * refusals a poll can race are passed over: the ask ended, or was answered (by this owner or a permission), since
 * it was listed.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { answer } from "../../src/core/wait.ts";

const RACES = new Set(["this ask is closed", "this ask was already answered", "no open ask has this id"]);

export async function ownerAnswer(...args: Parameters<typeof answer>): ReturnType<typeof answer> {
	const filled = await answer(...args);
	if ("refused" in filled && !RACES.has(filled.refused))
		throw new Error(`the owner's answer to ${args[1]} was refused: ${filled.refused}`);
	return filled;
}

/**
 * Note what the owner says to the ask `key`, before saying it. A kill can land between the note and the commit that
 * keeps the answer: the owner's answer never took, the same ask is still open and they say it again, so the note is
 * by ask and `answersGiven` counts each ask once. Two approvals in it are two asks, never one said twice.
 */
export const noteAnswer = (home: string, said: string, key: string) =>
	appendFileSync(join(home, "answers.txt"), `${said} ${key}\n`);

/** What the owner said, in order, one word for each ask. */
export const answersGiven = (home: string): string[] =>
	[
		...new Set(readFileSync(join(home, "answers.txt"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean)),
	].map((line) => line.slice(0, line.indexOf(" ")));
