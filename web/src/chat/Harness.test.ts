import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pbtRuns } from "../../../test/pbt.ts";
import {
	changesOf,
	cleanCommand,
	type HarnessSessionView,
	type HarnessStep,
	HarnessTranscript,
	headlineOf,
	middleEllipsis,
	projectOf,
	stepKey,
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

describe("HarnessTranscript, as it opens", () => {
	const session: HarnessSessionView = {
		harness: "Claude Code",
		provider: "anthropic",
		folder: "~/sancho",
		state: "working",
		elapsed: "0:42",
		steps: [
			{ kind: "asked", text: `Fix the auth test.\n${"It fails on main. ".repeat(20)}` },
			{ kind: "steered", text: "Keep the diff small", taken: true },
			{ kind: "read", path: "test/auth.spec.ts" },
			{ kind: "thought", text: "Refresh compares seconds with milliseconds." },
			{ kind: "edit", path: "src/auth.ts", added: 2, removed: 1, diff: "- a\n+ b" },
			{ kind: "decided", command: "npm test", allowed: true },
			{ kind: "run", command: "npm test -- auth.spec.ts", output: "6 passed", running: true },
			{ kind: "waiting", command: "cd /Users/sam/sancho && git push origin main" },
			{ kind: "said", text: "Fixed: refresh compared seconds with milliseconds." },
		],
	};
	it("folds every step, the last and the streaming ones included: none is born expanded", () => {
		const html = renderToStaticMarkup(createElement(HarnessTranscript, { session }));
		expect(html).not.toContain('aria-expanded="true"');
		expect(html).not.toContain("data-terminal"); // a run's Terminal only exists once opened
		expect(html).not.toContain("6 passed"); // its output too
		expect(html).not.toContain("+ b"); // an edit's diff too
		expect(html).not.toContain("cd /Users/sam/sancho"); // the raw command too: its row says it in words, cleaned
	});
	it("shows what was asked at three lines with Show all, with no click to see it", () => {
		const html = renderToStaticMarkup(createElement(HarnessTranscript, { session }));
		expect(html).toContain("line-clamp-3");
		expect(html).toContain("Show all");
		expect(html).toContain("Fix the auth test.");
	});
});

describe("stepKey", () => {
	const kinds = ["read", "run", "edit", "said", "thought"] as const;
	const stepOf = (n: number): HarnessStep => {
		const kind = kinds[n % kinds.length] as (typeof kinds)[number];
		return kind === "read"
			? { kind, path: `f${n}` }
			: kind === "run"
				? { kind, command: `c${n}` }
				: kind === "edit"
					? { kind, path: `f${n}` }
					: { kind, text: `t${n}` };
	};
	it("never moves a kept step's key while the daemon drops old ones and more stream in", () => {
		fc.assert(
			fc.property(fc.nat(60), fc.nat(40), fc.nat(10), (count, drop, grow) => {
				const steps: HarnessStep[] = [
					{ kind: "asked", text: "do it" },
					...Array.from({ length: count }, (_, n) => stepOf(n)),
				];
				const before = new Map(steps.map((step, index) => [step, stepKey(step, index, 0)]));
				// the daemon keeps the first step (the ask) and drops the next `drop`, then `grow` more arrive
				const dropped = Math.min(drop, steps.length - 1);
				const after = [
					steps[0] as HarnessStep,
					...steps.slice(1 + dropped),
					...Array.from({ length: grow }, (_, n) => stepOf(count + n)),
				];
				const keys = after.map((step, index) => stepKey(step, index, dropped));
				// a surviving step keeps its key; a new step never inherits one
				after.forEach((step, index) => {
					const prior = before.get(step);
					if (prior !== undefined) expect(keys[index]).toBe(prior);
					else expect(before.has(step)).toBe(false);
				});
				expect(new Set(keys).size).toBe(keys.length);
			}),
			{ numRuns: pbtRuns(100) },
		);
	});
	it("gives a step that arrives later a key no earlier step ever had", () => {
		const steps: HarnessStep[] = [{ kind: "asked", text: "do it" }, ...Array.from({ length: 5 }, (_, n) => stepOf(n))];
		const had = new Set(steps.map((step, index) => stepKey(step, index, 3)));
		const fresh = stepKey(stepOf(99), steps.length, 3);
		expect(had.has(fresh)).toBe(false);
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
