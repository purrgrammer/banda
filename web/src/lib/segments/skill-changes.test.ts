import { describe, expect, it } from "vitest";
import type { Item, ToolCall } from "../../../../src/server/api.ts";
import { skillChanges, skillChangeWords, skillPut } from "./skill-changes.ts";

const result = (notes: { code: string; text: string }[], error = false): Extract<Item, { role: "tool" }> =>
	({
		id: 2,
		role: "tool",
		call: "c1",
		name: "write",
		text: "",
		error,
		at: 5,
		notes: notes.map((note) => ({ severity: "info" as const, ...note })),
	}) as Extract<Item, { role: "tool" }>;

describe("a skill an agent wrote, in the feed", () => {
	it("is one line from the daemon's note, linking the skill; a file that waits draws nothing here", () => {
		const put = result([
			{
				code: "skill-in-effect",
				text: "skills/notes/SKILL.md is in effect: the skill /notes was added, and the owner sees it on the Skills page.",
			},
		]);
		const line = skillChanges.call?.(
			{ id: "c1", name: "write", args: { path: "skills/other/SKILL.md" } } as ToolCall,
			"1:c1",
			{
				result: put,
				asks: () => [],
				context: {},
			},
		);
		expect(line).toEqual([{ kind: "skillChange", key: "1:c1", state: "done", name: "notes", change: "added", at: 5 }]);
		expect(skillChangeWords({ name: "notes", change: "added" })).toBe("Added the skill /notes");
		expect(skillChangeWords({ name: "notes", change: "changed" })).toBe("Changed the skill /notes");
		expect(
			skillPut(
				result([{ code: "skill-waits", text: "skills/notes/SKILL.md is not in effect: a command changed it." }]),
			),
		).toBeUndefined();
		// a note that names one skill and claims another is not the daemon's
		expect(
			skillPut(result([{ code: "skill-in-effect", text: "skills/a/SKILL.md is in effect: the skill /b was added" }])),
		).toBeUndefined();
		expect(
			skillPut(
				result(
					[{ code: "skill-in-effect", text: "skills/notes/SKILL.md is in effect: the skill /notes was added" }],
					true,
				),
			),
		).toBeUndefined();
		// a command that left a skill in effect draws the same line; a read draws nothing
		expect(
			skillChanges.call?.({ id: "c1", name: "bash", args: {} } as ToolCall, "1:c1", {
				result: put,
				asks: () => [],
				context: {},
			}),
		).toHaveLength(1);
		expect(
			skillChanges.call?.({ id: "c1", name: "read", args: {} } as ToolCall, "1:c1", {
				result: put,
				asks: () => [],
				context: {},
			}),
		).toBeUndefined();
	});
});
