/**
 * A skill an agent put in the workspace, in the chat's feed: a `write`, `edit` or `bash` call the daemon marked as
 * putting a skill's instructions in effect (its note `skill-in-effect`, naming the file as the daemon resolved it) is
 * one line where it happened, linking to the skill. There is nothing to accept. A skill file that cannot be in effect
 * (its note `skill-waits`: it does not parse, or hides a character) draws nothing here: the Skills page says what is
 * wrong. Never from the call's arguments.
 */
import type { Item } from "../../../../src/server/api.ts";
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

/** The skill a call's result says it put in effect, from the daemon's own note. */
export function skillPut(result: Extract<Item, { role: "tool" }> | undefined) {
	if (result === undefined || result.error) return undefined;
	for (const note of result.notes ?? []) {
		const found = note.code === "skill-in-effect" ? NOTED.exec(note.text) : null;
		if (found !== null) return { name: found[1] as string, change: found[2] as "added" | "changed" };
	}
	return undefined;
}

export const skillChangeWords = (segment: Pick<SkillChangeSegment, "name" | "change">) =>
	`${segment.change === "added" ? "Added" : "Changed"} the skill /${segment.name}`;

const TOOLS = new Set(["write", "edit", "bash"]);

export const skillChanges: Segmenter = {
	call: (call, key, at) => {
		if (!TOOLS.has(call.name)) return undefined;
		const put = skillPut(at.result);
		if (put === undefined) return undefined;
		const segment: SkillChangeSegment = {
			kind: "skillChange",
			key,
			state: "done",
			...put,
			...(at.result?.at === undefined ? {} : { at: at.result.at }),
		};
		return [segment, ...at.asks()];
	},
	shown: (segment) => (segment.kind === "skillChange" ? [skillChangeWords(segment)] : undefined),
};
