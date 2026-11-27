import { describe, expect, it } from "vitest";
import type { Item, ToolCall } from "../../../../src/server/api.ts";
import { skillChanges, skillChangeWords, skillPut, skillsPut } from "./skill-changes.ts";

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

	it("a command that put two skills in effect and changed an agent file draws every line, the owner's wait included", () => {
		const mixed = result([
			{
				code: "skill-in-effect",
				text: "skills/a/SKILL.md is in effect: the skill /a was added, and the owner sees it.",
			},
			{ code: "awaits-acceptance", text: "agents/writer.md takes effect only once the owner accepts it in the app." },
			{
				code: "skill-in-effect",
				text: "skills/b/SKILL.md is in effect: the skill /b was changed, and the owner sees it.",
			},
			{
				code: "skill-removed",
				text: "skills/c/SKILL.md is gone from the workspace, but the skill /c stays in effect.",
			},
			{ code: "skill-waits", text: "skills/d/SKILL.md is not in effect: SKILL.md needs name and description." },
		]);
		expect(skillsPut(mixed)).toEqual([
			{ name: "a", change: "added" },
			{ name: "b", change: "changed" },
		]);
		const ask = { kind: "notice" as const, key: "1:c1:ask:0", text: "an ask" };
		const lines = skillChanges.call?.({ id: "c1", name: "bash", args: {} } as ToolCall, "1:c1", {
			result: mixed,
			asks: () => [ask],
			context: {},
		});
		expect(lines).toEqual([
			{ kind: "skillChange", key: "1:c1", state: "done", name: "a", change: "added", at: 5 },
			{ kind: "skillChange", key: "1:c1:skill:1", state: "done", name: "b", change: "changed", at: 5 },
			{ kind: "change", key: "1:c1:file:0", state: "working", folder: "agents", name: "writer", at: 5 },
			ask,
		]);
		// every key of one call is its own
		expect(new Set(lines?.map((line) => line.key)).size).toBe(lines?.length);
	});
});
