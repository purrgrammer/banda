import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pbtRuns } from "../../../test/pbt.ts";
import {
	changesOf,
	cleanCommand,
	type HarnessStep,
	headlineOf,
	middleEllipsis,
	projectOf,
	toggledStep,
} from "./Harness.tsx";

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
	const FOLDER = "~/code/banda";
	const run = (command: string): HarnessStep => ({ kind: "run", command });
	it("names what a step acts on, and a command waiting on the owner", () => {
		expect(headlineOf({ kind: "edit", path: "src/auth.ts", added: 1, removed: 0 })).toEqual({
			verb: "Editing",
			object: "src/auth.ts",
			code: true,
		});
		expect(headlineOf({ kind: "waiting", command: "npm run dev" })).toEqual({
			verb: "Waiting on you:",
			object: "npm run dev",
			code: true,
		});
		expect(headlineOf(undefined)).toEqual({ verb: "Starting", object: "", code: false });
	});
	it("drops the cd prefix and makes paths relative to the project", () => {
		expect(headlineOf(run("cd /Users/ana/code/banda && npm run build:web"), FOLDER).object).toBe("npm run build:web");
		expect(headlineOf(run("cd ~/code/banda && node scripts/x.ts"), FOLDER).object).toBe("node scripts/x.ts");
		expect(cleanCommand("cd '/Users/ana/code/banda' && make lint", FOLDER)).toBe("make lint");
		expect(cleanCommand("node /Users/ana/code/banda/scripts/x.ts", FOLDER)).toBe("node scripts/x.ts");
	});
	it("says a search in words, with its pattern", () => {
		expect(headlineOf(run('rg -n "headlineOf" web/src'), FOLDER)).toEqual({
			verb: "Searching for",
			object: '"headlineOf"',
			code: false,
		});
		expect(headlineOf(run("grep -r 'steer' src"), FOLDER).object).toBe('"steer"');
	});
	it("says a read in words, whatever reads it", () => {
		expect(headlineOf(run("cat web/src/chat/Harness.tsx"), FOLDER)).toEqual({
			verb: "Reading",
			object: "web/src/chat/Harness.tsx",
			code: true,
		});
		expect(headlineOf(run("sed -n '1,40p' src/core/harness.ts"), FOLDER).object).toBe("src/core/harness.ts");
		expect(headlineOf(run("head -n 20 README.md"), FOLDER).object).toBe("README.md");
	});
	it("says a listing in words, the bare folder as the project", () => {
		expect(headlineOf(run("ls -la web/src"), FOLDER)).toEqual({ verb: "Listing", object: "web/src", code: true });
		expect(headlineOf(run("ls"), FOLDER).object).toBe("banda");
	});
	it("says tests and git in words", () => {
		expect(headlineOf(run("cd ~/code/banda && npm test -- auth.spec.ts"), FOLDER).verb).toBe("Running tests");
		expect(headlineOf(run("npx vitest run --project unit"), FOLDER).verb).toBe("Running tests");
		expect(headlineOf(run("git status --short"), FOLDER)).toEqual({ verb: "Checking git", object: "", code: false });
	});
	it("keeps an unknown command itself, cleaned, in mono", () => {
		expect(headlineOf(run("cd ~/code/banda && make -j4 release"), FOLDER)).toEqual({
			verb: "Running",
			object: "make -j4 release",
			code: true,
		});
	});
	it("speaks in the past once a command ran", () => {
		expect(headlineOf({ kind: "run", command: "make build", running: false }, FOLDER).verb).toBe("Ran");
		expect(headlineOf({ kind: "run", command: 'rg "x" .', running: false }, FOLDER).verb).toBe("Searched for");
		expect(headlineOf({ kind: "run", command: "npm test", running: false }, FOLDER).verb).toBe("Ran tests");
	});
});

describe("middleEllipsis", () => {
	it("truncates in the middle, never the end", () => {
		const long = `npm run build ${"x".repeat(100)} --reporter dot`;
		const cut = middleEllipsis(long, 40);
		expect(cut).toHaveLength(40);
		expect(cut.startsWith("npm run build")).toBe(true);
		expect(cut.endsWith("--reporter dot")).toBe(true);
		expect(cut).toContain("…");
		expect(middleEllipsis("short", 40)).toBe("short");
	});
});

describe("projectOf", () => {
	it("names the project by its folder's last name", () => {
		expect(projectOf("~/code/banda")).toBe("banda");
		expect(projectOf("/Users/ana/sancho/")).toBe("sancho");
		expect(projectOf("~")).toBe("~");
	});
});

describe("toggledStep", () => {
	it("opens and closes one step, leaving the others as they were", () => {
		const open = toggledStep(new Set(), "run:3");
		expect(open.has("run:3")).toBe(true);
		const two = toggledStep(open, "edit:5");
		expect([...two].sort()).toEqual(["edit:5", "run:3"]);
		// a step stays open while new steps arrive: the set only changes when the owner toggles
		expect(toggledStep(two, "run:3").has("run:3")).toBe(false);
		expect(toggledStep(two, "run:3").has("edit:5")).toBe(true);
	});
});
