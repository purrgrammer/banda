import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pbtRuns } from "../../../test/pbt.ts";
import { changesOf, type HarnessStep, headlineOf } from "./Harness.tsx";

const edit = fc.record({
	kind: fc.constant("edit" as const),
	path: fc.constantFrom("src/a.ts", "src/b.ts", "test/c.ts"),
	added: fc.nat(50),
	removed: fc.nat(50),
});
const other: fc.Arbitrary<HarnessStep> = fc.oneof(
	fc.record({ kind: fc.constant("read" as const), path: fc.string() }),
	fc.record({ kind: fc.constant("said" as const), text: fc.string() }),
	fc.record({ kind: fc.constant("run" as const), command: fc.string() }),
);

describe("changesOf", () => {
	it("counts each path once and sums every edit's lines", () => {
		fc.assert(
			fc.property(fc.array(fc.oneof(edit, other)), (steps) => {
				const edits = steps.filter((step) => step.kind === "edit");
				const { files, added, removed } = changesOf(steps);
				expect(files).toBe(new Set(edits.map((step) => step.path)).size);
				expect(added).toBe(edits.reduce((sum, step) => sum + step.added, 0));
				expect(removed).toBe(edits.reduce((sum, step) => sum + step.removed, 0));
			}),
			{ numRuns: pbtRuns(100) },
		);
	});
});

describe("headlineOf", () => {
	it("names what a step acts on, and a command waiting on the owner", () => {
		expect(headlineOf({ kind: "edit", path: "src/auth.ts", added: 1, removed: 0 })).toEqual({
			verb: "Editing",
			object: "src/auth.ts",
		});
		expect(headlineOf({ kind: "waiting", command: "npm test" })).toEqual({
			verb: "Waiting on you:",
			object: "npm test",
		});
		expect(headlineOf({ kind: "run", command: "npm test", running: false }).verb).toBe("Ran");
		expect(headlineOf(undefined)).toEqual({ verb: "Starting", object: "" });
	});
});
