/**
 * A skill an agent put in the workspace, in the chat's feed: a `write`, `edit` or `bash` call the daemon marked as
 * putting a skill's instructions in effect (its note `skill-in-effect`, naming the file as the daemon resolved it) is
 * one line per skill where it happened, linking to the skill. There is nothing to accept. A skill file that cannot be
 * in effect (its note `skill-waits`: it does not parse, or hides a character) or that a command removed (`skill-removed`:
 * the skill stays until the owner removes it) draws nothing here: the Skills page says what is wrong. Never from the
 * call's arguments. A command that also changed a file the owner must allow (`changes.ts`) keeps those lines, after
 * the skills': what waits on the owner is never hidden by what did not.
 */
import type { Item } from "../../../../src/server/api.ts";
import { changeLines } from "./changes.ts";
import type { Segmenter } from "./types.ts";

export type SkillChangeSegment = {
	readonly kind: "skillChange";
	readonly key: string;
	readonly state: "done";
	readonly name: string;
	readonly change: "added" | "changed";
	readonly at?: number;
};

declare module "./types.ts" {
	interface AreaSegments {
		skillChange: SkillChangeSegment;
	}
}

const NOTED = /^skills\/([a-z0-9-]+)\/SKILL\.md is in effect: the skill \/\1 was (added|changed)/;

/** The skills a call's result says it put in effect, from the daemon's own notes, in their order. */
export function skillsPut(result: Extract<Item, { role: "tool" }> | undefined) {
	if (result === undefined || result.error) return [];
	return (result.notes ?? []).flatMap((note) => {
		const found = note.code === "skill-in-effect" ? NOTED.exec(note.text) : null;
		return found === null ? [] : [{ name: found[1] as string, change: found[2] as "added" | "changed" }];
	});
}

/** The first skill a call's result says it put in effect; undefined when none. */
export const skillPut = (result: Extract<Item, { role: "tool" }> | undefined) => skillsPut(result)[0];

export const skillChangeWords = (segment: Pick<SkillChangeSegment, "name" | "change">) =>
	`${segment.change === "added" ? "Added" : "Changed"} the skill /${segment.name}`;

const TOOLS = new Set(["write", "edit", "bash"]);

export const skillChanges: Segmenter = {
	call: (call, key, at) => {
		if (!TOOLS.has(call.name)) return undefined;
		const put = skillsPut(at.result);
		if (put.length === 0) return undefined;
		const lines = put.map(
			(skill, i): SkillChangeSegment => ({
				kind: "skillChange",
				key: i === 0 ? key : `${key}:skill:${i}`,
				state: "done",
				...skill,
				...(at.result?.at === undefined ? {} : { at: at.result.at }),
			}),
		);
		return [...lines, ...changeLines(key, at.result, false), ...at.asks()];
	},
	shown: (segment) => (segment.kind === "skillChange" ? [skillChangeWords(segment)] : undefined),
};
