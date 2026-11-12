import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pbtRuns } from "../../../test/pbt.ts";
import {
	changesOf,
	cleanCommand,
	compoundCommand,
	type HarnessSessionView,
	type HarnessStep,
	HarnessTranscript,
	headlineOf,
	middleEllipsis,
	projectOf,
	relativeTo,
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
		expect(headlineOf({ kind: "waiting", command: "npm run dev", ask: "execute" })).toEqual({
			verb: "Waiting on you:",
			object: "run a command",
			code: false,
		});
		expect(headlineOf({ kind: "waiting", command: "src/auth.ts", ask: "edit" }).object).toBe("change a file");
		expect(headlineOf({ kind: "waiting", command: "something" }).object).toBe("do something");
		expect(headlineOf(undefined)).toEqual({ verb: "Starting", object: "", code: false });
	});
	it("drops the cd prefix and makes paths under the real root relative to the project", () => {
		expect(headlineOf(run("cd /Users/ana/code/banda && npm run build:web"), FOLDER).object).toBe("npm run build:web");
		expect(headlineOf(run("cd ~/code/banda && node scripts/x.ts"), FOLDER).object).toBe("node scripts/x.ts");
		expect(cleanCommand("cd '/Users/ana/code/banda' && make lint", FOLDER)).toBe("make lint");
		expect(cleanCommand("node /Users/ana/code/banda/scripts/x.ts", FOLDER, "/Users/ana/code/banda")).toBe(
			"node scripts/x.ts",
		);
	});
	it("says a search in words, with its pattern", () => {
		expect(headlineOf(run('rg -n "headlineOf" web/src'), FOLDER)).toEqual({
			verb: "Searching for",
			object: '"headlineOf"',
			code: false,
		});
		expect(headlineOf(run("grep -r 'steer' src"), FOLDER).object).toBe('"steer"');
	});
	it("says a read in words, for a plain cat, head or tail", () => {
		expect(headlineOf(run("cat web/src/chat/Harness.tsx"), FOLDER)).toEqual({
			verb: "Reading",
			object: "web/src/chat/Harness.tsx",
			code: true,
		});
		expect(headlineOf(run("head -n 20 README.md"), FOLDER).object).toBe("README.md");
	});
	it("never titles a sed as a read: a sed shows itself, whatever its flags", () => {
		expect(headlineOf(run("sed -i '' 's/a/b/' config.yml"), FOLDER)).toEqual({
			verb: "Running",
			object: "sed -i '' 's/a/b/' config.yml",
			code: true,
		});
		expect(headlineOf(run("sed -n '1,40p' src/core/harness.ts"), FOLDER).verb).toBe("Running");
		expect(headlineOf(run("sed -n 1,10p notes.txt > /tmp/out"), FOLDER).object).toBe(
			"sed -n 1,10p notes.txt > /tmp/out",
		);
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
	it("says Checking git only for a git that looks; one that writes shows itself whole", () => {
		expect(headlineOf(run("git log --oneline -5"), FOLDER).verb).toBe("Checking git");
		expect(headlineOf(run("git diff --stat"), FOLDER).verb).toBe("Checking git");
		expect(headlineOf(run("git branch -a"), FOLDER).verb).toBe("Checking git");
		expect(headlineOf(run("git remote -v"), FOLDER).verb).toBe("Checking git");
		expect(headlineOf(run("git push --force origin main"), FOLDER)).toEqual({
			verb: "Running",
			object: "git push --force origin main",
			code: true,
		});
		expect(headlineOf(run("git commit -m update"), FOLDER).verb).toBe("Running");
		expect(headlineOf(run("git branch -D topic"), FOLDER).object).toBe("git branch -D topic");
		expect(headlineOf(run("git branch topic"), FOLDER).verb).toBe("Running");
		expect(headlineOf(run("git checkout -- ."), FOLDER).verb).toBe("Running");
		expect(headlineOf(run("git stash pop"), FOLDER).verb).toBe("Running");
	});
	it("never hides a chained, piped or redirected command behind one quiet verb", () => {
		expect(headlineOf(run("rg foo && make deploy"), FOLDER)).toEqual({
			verb: "Running",
			object: "rg foo && make deploy",
			code: true,
		});
		expect(headlineOf(run("git status && git push --force origin main"), FOLDER).object).toBe(
			"git status && git push --force origin main",
		);
		expect(headlineOf(run("npm test && make release"), FOLDER).verb).toBe("Running");
		expect(headlineOf(run("cat a.txt; rm -rf build"), FOLDER).object).toBe("cat a.txt; rm -rf build");
		expect(headlineOf(run("cat a.txt | wc -l"), FOLDER).object).toBe("cat a.txt | wc -l");
		expect(headlineOf(run("grep -r pattern . | sort"), FOLDER).verb).toBe("Running");
		expect(headlineOf(run("ls $(basename x)"), FOLDER).verb).toBe("Running");
		expect(headlineOf(run("echo hi > out.txt"), FOLDER).verb).toBe("Running");
		expect(headlineOf(run("make build 2>&1"), FOLDER).verb).toBe("Running");
		expect(headlineOf(run("ls `pwd`"), FOLDER).verb).toBe("Running");
	});
	it("still drops a leading cd, and separators inside quotes stay words, not structure", () => {
		expect(headlineOf(run("cd ~/code/banda && npm run build:web"), FOLDER).object).toBe("npm run build:web");
		expect(headlineOf(run('rg "a && b" src'), FOLDER)).toEqual({
			verb: "Searching for",
			object: '"a && b"',
			code: false,
		});
		expect(compoundCommand('echo "a | b"')).toBe(false);
		expect(compoundCommand("echo 'a; b'")).toBe(false);
		expect(compoundCommand("cat a.txt | wc -l")).toBe(true);
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

describe("a long headline keeps what it ends on", () => {
	it("keeps an edited file's name whole, its folders giving way", () => {
		const { object } = headlineOf({ kind: "edit", path: `src/${"deeply/nested/".repeat(8)}auth-session-store.ts` });
		expect(object.length).toBeLessThanOrEqual(64);
		expect(object.endsWith("…auth-session-store.ts")).toBe(true);
	});
	it("keeps a chain's last step whole, the steps before it giving way", () => {
		const command = `npm ci && npm run build && npm run lint -- ${"--max-warnings 0 ".repeat(5)}&& git push --force origin main`;
		const { verb, object } = headlineOf({ kind: "run", command, running: false });
		expect(verb).toBe("Ran");
		expect(object.length).toBeLessThanOrEqual(72);
		expect(object.startsWith("npm ci && npm run build")).toBe(true);
		expect(object.endsWith("&& git push --force origin main")).toBe(true);
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

describe("relativeTo", () => {
	it("cuts only paths anchored at the folder or its real root, never by the folder's name", () => {
		expect(relativeTo("cat /Users/ana/sancho/notes.txt", "~/sancho", "/Users/ana/sancho")).toBe("cat notes.txt");
		expect(relativeTo("ls ~/sancho/docs", "~/sancho")).toBe("ls docs");
		expect(relativeTo("ls ~/sancho", "~/sancho")).toBe("ls .");
		expect(relativeTo("ls /Users/ana/sancho", "~/sancho", "/Users/ana/sancho")).toBe("ls .");
		// a stranger's path that merely ends in the folder's name stays whole
		expect(relativeTo("cat /tmp/sancho/data.txt", "~/sancho", "/Users/ana/sancho")).toBe("cat /tmp/sancho/data.txt");
		expect(relativeTo("cat /Users/other/sancho/notes.txt", "~/sancho", "/Users/ana/sancho")).toBe(
			"cat /Users/other/sancho/notes.txt",
		);
		expect(relativeTo("ls /tmp/sancho", "~/sancho", "/Users/ana/sancho")).toBe("ls /tmp/sancho");
		// with no root from the daemon, an absolute path stays whole: showing too much beats a wrong "inside the project"
		expect(relativeTo("cat /Users/ana/sancho/notes.txt", "~/sancho")).toBe("cat /Users/ana/sancho/notes.txt");
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
			{ kind: "decided", command: "npm test", ask: "execute", allowed: true },
			{ kind: "run", command: "npm test -- auth.spec.ts", output: "6 passed", running: true },
			{ kind: "waiting", command: "cd /Users/sam/sancho && git push origin main", ask: "execute" },
			{ kind: "said", text: "Fixed: refresh compared seconds with milliseconds." },
		],
	};
	it("folds every step, the last and the streaming ones included: none is born expanded", () => {
		const html = renderToStaticMarkup(createElement(HarnessTranscript, { session }));
		expect(html).not.toContain('aria-expanded="true"');
		expect(html).not.toContain("data-terminal"); // a run's Terminal only exists once opened
		expect(html).not.toContain("6 passed"); // its output too
		expect(html).not.toContain("+ b"); // an edit's diff too
		expect(html).not.toContain("cd /Users/sam/sancho"); // the raw command too: its row says the ask's kind in words
		expect(html).not.toContain("git push"); // no part of a waiting command: whole once opened, never in a folded row
	});
	it("shows what was asked at three lines with Show all, with no click to see it", () => {
		const html = renderToStaticMarkup(createElement(HarnessTranscript, { session }));
		expect(html).toContain("line-clamp-3");
		expect(html).toContain("Show all");
		expect(html).toContain("Fix the auth test.");
	});
});

describe("a waiting or decided row never shows the command, whole or in part", () => {
	// 127 chars with the risky tail last, 128 with it in the middle: either way a middle cut would hide or keep it by luck
	const tailed = `make deploy ${"a".repeat(86)} git push --force origin main`;
	const centred = `echo start ${"b".repeat(47)} rm -rf build ${"b".repeat(46)} echo done`;
	const sessionWith = (steps: readonly HarnessStep[]): HarnessSessionView => ({
		harness: "Claude Code",
		folder: "~/sancho",
		state: "waiting",
		elapsed: "0:10",
		steps: [{ kind: "asked", text: "Ship it." }, ...steps],
	});
	it("holds the lengths the finding named", () => {
		expect(tailed).toHaveLength(127);
		expect(centred).toHaveLength(128);
	});
	it("says the headline by the ask's kind, with no text of the command and no ellipsis", () => {
		for (const command of [tailed, centred]) {
			const head = headlineOf({ kind: "waiting", command, ask: "execute" });
			expect(head).toEqual({ verb: "Waiting on you:", object: "run a command", code: false });
			expect(head.object).not.toContain("…");
		}
	});
	it("folds both rows to the kind in words, with no fragment of either command", () => {
		const html = renderToStaticMarkup(
			createElement(HarnessTranscript, {
				session: sessionWith([
					{ kind: "decided", command: centred, ask: "execute", allowed: true },
					{ kind: "waiting", command: tailed, ask: "execute" },
				]),
			}),
		);
		expect(html).toContain("You allowed:");
		expect(html).toContain("Waiting on you to allow:");
		expect(html).toContain("run a command");
		for (const fragment of ["make deploy", "git push", "rm -rf", "echo start", "aaaa", "bbbb", "…"])
			expect(html).not.toContain(fragment);
	});
	it("shows the whole command, untruncated, once a row is opened; a denial too", () => {
		const html = renderToStaticMarkup(
			createElement(HarnessTranscript, {
				session: sessionWith([
					{ kind: "decided", command: centred, ask: "execute", allowed: false },
					{ kind: "waiting", command: tailed, ask: "execute" },
				]),
				defaultOpenSteps: ["decided:1", "waiting:2"],
			}),
		);
		expect(html).toContain("You denied:");
		expect(html).toContain(tailed); // all 127 chars, nothing cut
		expect(html).toContain(centred); // all 128 chars, the middle included
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
