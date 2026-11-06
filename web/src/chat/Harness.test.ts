import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pbtRuns } from "../../../test/pbt.ts";
import { changedFiles, changesOf, foldedSteps, type HarnessStep, headlineOf, shortFolder } from "./harness-steps.ts";

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
				expect(added).toBe(edits.reduce((sum, step) => sum + (step.added ?? 0), 0));
				expect(removed).toBe(edits.reduce((sum, step) => sum + (step.removed ?? 0), 0));
			}),
			{ numRuns: pbtRuns(100) },
		);
	});
});

describe("changesOf, when a harness did not say", () => {
	it("counts the file and leaves its lines unknown, never zero", () => {
		expect(changesOf([{ kind: "edit", path: "auth.js" }])).toEqual({ files: 1 });
		expect(
			changesOf([
				{ kind: "edit", path: "a", added: 2, removed: 1 },
				{ kind: "edit", path: "b" },
			]),
		).toEqual({ files: 2 });
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

describe("shortFolder", () => {
	it("keeps a short folder whole and a long one by its last two parts", () => {
		expect(shortFolder("~/code")).toBe("~/code");
		expect(shortFolder("/private/tmp/claude-501/-Users-bandarra-sancho/scratchpad/code/demo")).toBe("…/code/demo");
		fc.assert(
			fc.property(fc.array(fc.stringMatching(/^[a-z0-9-]{1,12}$/), { minLength: 1, maxLength: 8 }), (parts) => {
				const folder = `/${parts.join("/")}`;
				const shown = shortFolder(folder);
				expect(folder.endsWith(shown.replace(/^…/, ""))).toBe(true);
			}),
			{ numRuns: pbtRuns(100) },
		);
	});
});

describe("changedFiles", () => {
	it("agrees with changesOf, keeps each file's diffs in order, and lists files as first changed", () => {
		const diffed = fc.record({
			kind: fc.constant("edit" as const),
			path: fc.constantFrom("src/a.ts", "src/b.ts"),
			added: fc.nat(9),
			removed: fc.nat(9),
			diff: fc.string(),
		});
		fc.assert(
			fc.property(fc.array(fc.oneof(edit, diffed, other)), (steps) => {
				const files = changedFiles(steps);
				const total = changesOf(steps);
				expect(files).toHaveLength(total.files);
				expect(files.reduce((sum, file) => sum + (file.added ?? 0), 0)).toBe(total.added ?? 0);
				const edits = steps.filter((step) => step.kind === "edit");
				expect(files.map((file) => file.path)).toEqual([...new Set(edits.map((step) => step.path))]);
				for (const file of files)
					expect(file.diffs).toEqual(
						edits.flatMap((step) => (step.path === file.path && "diff" in step ? [step.diff] : [])),
					);
			}),
			{ numRuns: pbtRuns(100) },
		);
	});
});

describe("foldedSteps", () => {
	it("folds each run of two or more reads, and loses no step", () => {
		fc.assert(
			fc.property(fc.array(fc.oneof(edit, other)), (steps) => {
				const items = foldedSteps(steps);
				const back = items.flatMap((item) =>
					item.kind === "step" ? [item.step] : item.paths.map((path): HarnessStep => ({ kind: "read", path })),
				);
				expect(back).toEqual(steps);
				for (const [i, item] of items.entries()) {
					if (item.kind === "reads") expect(item.paths.length).toBeGreaterThan(1);
					const next = items[i + 1];
					// two reads never sit side by side unfolded
					if (item.kind === "step" && item.step.kind === "read" && next?.kind === "step")
						expect(next.step.kind).not.toBe("read");
				}
			}),
			{ numRuns: pbtRuns(100) },
		);
	});
});
