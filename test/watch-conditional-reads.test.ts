import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type Item, type Json, madeNow, mayCarry, parseUnless, SURE_AFTER } from "../src/core/follow.ts";
import { pause } from "../src/server/watches.ts";
import { Faults } from "./fault/faults.ts";
import {
	byMethod,
	failure,
	GITHUB,
	NOW,
	QUIET_READS,
	quietWorld,
	runsEnded,
	SCENARIOS,
	type ScenarioConnection,
	type Scene,
	type World,
	watchInvariants,
	watchScenario,
	world,
} from "./fault/watch-scenario.ts";
import { definition, refusal } from "./fixtures/shipped.ts";
import { tempHome } from "./helpers.ts";

const MINUTE = 60_000;

/** GitHub as banda shipped it before reads had an `unless`: every read at every look. */
const EVERY_READ: ScenarioConnection = {
	...GITHUB,
	file: (() => {
		const parsed = JSON.parse(GITHUB.file) as {
			objects: { pull_request: { reads: { [as: string]: { unless?: unknown } } } };
		};
		for (const read of Object.values(parsed.objects.pull_request.reads)) delete read.unless;
		return `${JSON.stringify(parsed, null, "\t")}\n`;
	})(),
};

/** The reads each look made, by method, from the scenario's log of reads. */
const readsIn = (home: string): string[] =>
	readFileSync(join(home, "reads.jsonl"), { encoding: "utf8", flag: "a+" })
		.split("\n")
		.filter(Boolean)
		.map((line) => String((JSON.parse(line) as { method?: string }).method));

/**
 * The act's looks at a pull request whose world is `worldAt`, one every `every` from NOW for `looks` looks, through
 * `connection`: the reads each look made, by method, and the summary.
 */
async function looked(
	worldAt: (step: number) => World,
	looks: number,
	every: number,
	connection: ScenarioConnection = GITHUB,
	clicks: (string | undefined)[] = Array.from({ length: looks }, () => undefined),
) {
	const home = await tempHome();
	const perLook: string[][] = [];
	const summary = await watchScenario(home, new Faults(), {
		connection,
		tasks: false,
		world: worldAt,
		clicks,
		at: (step) => NOW + (step - 1) * every,
		act: async (_step, { harness, core }) => {
			await runsEnded(harness);
			const before = readsIn(home).length;
			await core.lookWatch(harness, "banda-142");
			perLook.push(readsIn(home).slice(before));
		},
	});
	return { perLook, summary, home };
}

const sum = (looks: string[][]) => looks.reduce((total, each) => total + each.length, 0);

/** A pull request nothing happens to: its checks done and green on one head, `updated_at` still. */
const quiet = (_step: number): World => quietWorld(1);

/**
 * A pull request busy for an hour: lint runs throughout, so it is looked at every two minutes; bob comments at
 * minute 20 and ana approves at minute 40, each moving `updated_at`.
 */
const busy = (step: number): World => {
	const at = world(0) as { [read: string]: Json } & { get: { [key: string]: Json } };
	const minute = (step - 1) * 2;
	at.get.updated_at =
		minute >= 40 ? "2026-11-02T09:40:00Z" : minute >= 20 ? "2026-11-02T09:20:00Z" : "2026-11-02T08:00:00Z";
	if (minute >= 20) at.get_comments = [{ id: 5, user: { login: "bob" }, body: "one question" }];
	if (minute >= 40) at.get_reviews = [{ id: 1, user: { login: "ana" }, state: "APPROVED" }];
	return at;
};

describe("a read's unless", () => {
	it("is a path into a read made at every look, a condition and a period, or the definition is refused", () => {
		const reads = (change: (reads: { [as: string]: { [key: string]: unknown } }) => void) =>
			refusal("github", (file) =>
				change(
					(file.objects as unknown as { pull_request: { reads: { [as: string]: { [key: string]: unknown } } } })
						.pull_request.reads,
				),
			);
		expect(reads(() => {})).toBe("");
		expect(reads((r) => Object.assign(r.reviews as object, { unless: { same: ["pr"] } }))).toMatch(/unless/);
		expect(
			reads((r) => Object.assign(r.reviews as object, { unless: { same: ["pr.updated_at"], every: "soon" } })),
		).toMatch(/unless/);
		expect(
			reads((r) => Object.assign(r.reviews as object, { unless: { same: ["pr.updated_at"], while: "nonsense" } })),
		).toMatch(/unless/);
		expect(reads((r) => Object.assign(r.reviews as object, { unless: { same: ["pr.updated_at"], also: 1 } }))).not.toBe(
			"",
		);
		// a list of paths, one at least
		expect(reads((r) => Object.assign(r.reviews as object, { unless: { same: "pr.updated_at" } }))).toMatch(/unless/);
		expect(reads((r) => Object.assign(r.reviews as object, { unless: { same: [] } }))).toMatch(/unless/);
		// what skips a read is a read made at every look, never another the same may skip, nor one the kind lacks
		expect(
			reads((r) => Object.assign(r.reviews as object, { unless: { same: ["pr.updated_at", "comments.length"] } })),
		).toMatch(/made at every look/);
		expect(reads((r) => Object.assign(r.reviews as object, { unless: { same: ["nothing.here"] } }))).toMatch(
			/made at every look/,
		);
		// a condition names one of the kind's reads (as kept) or a derived condition it declares, else it is refused: a
		// misspelt path with `!=` would hold forever
		expect(
			reads((r) =>
				Object.assign(r.checks as object, { unless: { same: ["pr.head.sha"], while: "derived.nope = true" } }),
			),
		).toMatch(/derived condition/);
		expect(
			reads((r) =>
				Object.assign(r.checks as object, { unless: { same: ["pr.head.sha"], while: "chekcs.total_count != 0" } }),
			),
		).toMatch(/derived condition/);
		expect(
			reads((r) =>
				Object.assign(r.checks as object, { unless: { same: ["pr.head.sha"], while: "checks.total_count != 0" } }),
			),
		).toBe("");
		expect(parseUnless({ same: ["pr.head.sha"], while: "derived.checks_done = true", every: "30m" })).toEqual({
			same: ["pr.head.sha"],
			while: "derived.checks_done = true",
			every: "30m",
		});
	});

	it("GitHub's pull request reads its checks, reviews and comments only when what they move moved", () => {
		const reads = definition("github").objects?.pull_request?.reads ?? {};
		expect(reads.pr?.unless).toBeUndefined();
		expect(reads.checks?.unless).toEqual({
			same: ["pr.head.sha", "pr.updated_at"],
			while: "derived.checks_done = true",
			every: "10m",
		});
		expect(reads.reviews?.unless).toEqual({ same: ["pr.updated_at"], every: "2h" });
		expect(reads.comments?.unless).toEqual({ same: ["pr.updated_at"], every: "2h" });
	});

	it("carries an answer only when it was made after the value was already known, the condition holds and it is young", () => {
		const unless = { same: ["pr.updated_at"], while: "derived.done = true", every: "30m" };
		const kept: Item = { pr: { updated_at: "x" }, reviews: [], derived: { done: true } };
		const answers: Item = { pr: { updated_at: "x" } };
		const t = NOW;
		// made at the look that first saw "x": a change in the same second after it would leave "x", so read again
		expect(mayCarry(unless, answers, kept, { at: t }, t + 5 * MINUTE)).toBe(false);
		expect(mayCarry(unless, answers, kept, undefined, t + 5 * MINUTE)).toBe(false);
		const sure = { at: t, sure: JSON.stringify(['["x"]']) };
		expect(mayCarry(unless, answers, kept, sure, t + 5 * MINUTE)).toBe(true);
		// moved, not there, the condition does not hold, or the answer is too old: read
		expect(mayCarry(unless, { pr: { updated_at: "y" } }, kept, sure, t + 5 * MINUTE)).toBe(false);
		expect(mayCarry(unless, { pr: {} }, kept, sure, t + 5 * MINUTE)).toBe(false);
		expect(mayCarry(unless, answers, { ...kept, derived: { done: false } }, sure, t + 5 * MINUTE)).toBe(false);
		expect(mayCarry(unless, answers, kept, sure, t + 30 * MINUTE)).toBe(false);
		// a clock that went back carries nothing
		expect(mayCarry(unless, answers, kept, sure, t - MINUTE)).toBe(false);
		// an answer is sure when the reading before its look already had the value, a minute or more before
		expect(madeNow(unless, answers, { answers: kept, at: t - SURE_AFTER }, t)).toEqual(sure);
		expect(madeNow(unless, answers, { answers: kept, at: t - SURE_AFTER + 1 }, t)).toEqual({ at: t });
		expect(madeNow(unless, { pr: { updated_at: "y" } }, { answers: kept, at: t - MINUTE }, t)).toEqual({ at: t });
		expect(madeNow(unless, answers, undefined, t)).toEqual({ at: t });
		// a minute after the reads of that reading ended, not after its look began: a slow read moves the minute on
		expect(madeNow(unless, answers, { answers: kept, at: t - 5 * MINUTE, through: t - SURE_AFTER + 1 }, t)).toEqual({
			at: t,
		});
		expect(madeNow(unless, answers, { answers: kept, at: t - 5 * MINUTE, through: t - SURE_AFTER }, t)).toEqual(sure);
		// and only when the condition already held over that reading: one just come true (the last check finished as
		// another may start) is made again at the next look
		expect(madeNow(unless, answers, { answers: { ...kept, derived: { done: false } }, at: t - MINUTE }, t)).toEqual({
			at: t,
		});
		// with more than one path, every one must be as kept, and there
		const both = { ...unless, same: ["pr.head.sha", "pr.updated_at"] };
		const head = (sha: string, updated: string): Item => ({ pr: { head: { sha }, updated_at: updated } });
		const keptBoth: Item = { ...head("a", "x"), derived: { done: true } };
		const sureBoth = madeNow(both, head("a", "x"), { answers: keptBoth, at: t - MINUTE }, t);
		expect(sureBoth.sure).toBeDefined();
		expect(mayCarry(both, head("a", "x"), keptBoth, sureBoth, t + 5 * MINUTE)).toBe(true);
		expect(mayCarry(both, head("a", "y"), keptBoth, sureBoth, t + 5 * MINUTE)).toBe(false);
		expect(mayCarry(both, head("b", "x"), keptBoth, sureBoth, t + 5 * MINUTE)).toBe(false);
		expect(mayCarry(both, { pr: { updated_at: "x" } }, keptBoth, sureBoth, t + 5 * MINUTE)).toBe(false);
	});
});

describe("a watch's looks with conditional reads", () => {
	it("skips what did not move and carries it forward: every change wakes once, an approval in the comment's second too", async () => {
		const { perLook, summary } = await looked(quietWorld, QUIET_READS.length, 5 * MINUTE);
		expect(perLook).toEqual(QUIET_READS);
		expect(SCENARIOS.carried?.problems(summary)).toEqual([]);
		// each held for the kind's settling minute, so it wakes at the look after the one that saw it
		expect(summary.wakes.map((wake) => wake.at)).toEqual([NOW + 15 * MINUTE, NOW + 30 * MINUTE]);
	}, 60_000);

	it("a quiet pull request is one request a look: 48 an hour before, 18 now, 19 on average over two hours", async () => {
		// a look every five minutes: the baseline, the look that confirms it, then two hours of looks
		const looks = 2 + 24;
		const after = await looked(quiet, looks, 5 * MINUTE);
		const before = await looked(quiet, looks, 5 * MINUTE, EVERY_READ);
		const hour = (each: string[][]) => sum(each.slice(2, 14));
		expect(hour(before.perLook)).toBe(48);
		// the pull request every look, the checks every ten minutes for a re-run on the same head
		expect(hour(after.perLook)).toBe(18);
		expect(after.perLook.slice(2, 14).filter((each) => each.length === 1)).toHaveLength(6);
		// over two hours the reviews and comments are read once each, as their two hours have passed
		expect(sum(after.perLook.slice(2))).toBe(38);
		expect(sum(before.perLook.slice(2))).toBe(96);
		for (const { summary } of [after, before]) {
			expect(watchInvariants(summary)).toEqual([]);
			expect(summary.wakes).toEqual([]);
			expect(summary.tells).toEqual([]);
		}
	}, 120_000);

	it("a busy pull request reads its running checks every look, its reviews and comments when updated_at moved: 120 an hour before, 70 now", async () => {
		const looks = 1 + 30;
		const after = await looked(busy, looks, 2 * MINUTE);
		const before = await looked(busy, looks, 2 * MINUTE, EVERY_READ);
		const hour = (each: string[][]) => sum(each.slice(1));
		expect(hour(before.perLook)).toBe(120);
		// 30 looks of the pull request and its checks; the reviews and comments at the look that confirms the baseline,
		// at the looks that saw `updated_at` move (minutes 20 and 40) and at the look after each, which confirms it
		expect(hour(after.perLook)).toBe(70);
		for (const { summary } of [after, before]) {
			expect(watchInvariants(summary)).toEqual([]);
			expect(summary.wakes.map((wake) => wake.changes)).toEqual([["bob commented"], ["ana approved"]]);
			// each seen at minute 20 or 40 and held for the kind's settling minute: it wakes at the look after
			expect(summary.wakes.map((wake) => wake.at)).toEqual([NOW + 22 * MINUTE, NOW + 42 * MINUTE]);
		}
	}, 120_000);

	it("a check run again on the same head moves nothing on the pull request: it is seen within the checks' ten minutes", async () => {
		// green at the baseline and confirmed at +5m; lint runs again at +10m and fails at +15m, on the same head
		const rerun = (step: number): World => {
			const at = quietWorld(1) as { get_check_runs: { check_runs: { [key: string]: Json }[] } };
			const lint = at.get_check_runs.check_runs[1] as { [key: string]: Json };
			if (step >= 3) Object.assign(lint, { id: 12, status: "in_progress", conclusion: null });
			if (step >= 4) Object.assign(lint, { status: "completed", conclusion: "failure" });
			return at as World;
		};
		const { perLook, summary } = await looked(rerun, 9, 5 * MINUTE);
		const checked = perLook.flatMap((each, i) => (each.includes("get_check_runs") ? [i + 1] : []));
		// read at the baseline, its confirmation, then every ten minutes after that (+15m, +25m, +35m)
		expect(checked).toEqual([1, 2, 4, 6, 8]);
		// seen at +15m, held for the kind's settling minute, woken at the look after
		expect(summary.wakes.map((wake) => [wake.at, wake.changes])).toEqual([[NOW + 20 * MINUTE, ["lint failed"]]]);
		expect(watchInvariants(summary)).toEqual([]);
	}, 60_000);

	it("a workflow a label starts on the same head moves updated_at: its checks are read at that look", async () => {
		// green at the baseline and confirmed at +5m; at +10m a label starts a workflow on the same head, which fails at
		// +15m. The label moved `updated_at` (the head did not): the checks are read again at once, and while they run
		const labelled = (step: number): World => {
			const at = quietWorld(1) as { get: { [key: string]: Json }; get_check_runs: { check_runs: Json[] } };
			if (step >= 3) {
				at.get.updated_at = "2026-11-02T09:10:00Z";
				at.get.labels = ["deploy"];
				at.get_check_runs.check_runs.push({ id: 20, name: "deploy", status: "in_progress", conclusion: null });
			}
			if (step >= 4)
				Object.assign(at.get_check_runs.check_runs[2] as object, { status: "completed", conclusion: "failure" });
			return at as unknown as World;
		};
		const { perLook, summary } = await looked(labelled, 6, 5 * MINUTE);
		const checked = perLook.flatMap((each, i) => (each.includes("get_check_runs") ? [i + 1] : []));
		// read at the look that saw `updated_at` move, at the next (the deploy check ran, and that answer was not yet sure,
		// which finds it failed), and at the one after (done had only just come true: a check that starts as the last
		// one finishes is seen); then carried
		expect(checked).toEqual([1, 2, 3, 4, 5]);
		expect(summary.wakes.map((wake) => [wake.at, wake.changes])).toEqual([
			[NOW + 20 * MINUTE, ["deploy failed", "checks finished"]],
		]);
		expect(watchInvariants(summary)).toEqual([]);
	}, 60_000);

	it("the owner's Check now reads everything, as they asked", async () => {
		// the last step's click looks after the act's look of that step: the act's carries, the click reads every read
		const { perLook, home } = await looked(quiet, 3, 5 * MINUTE, GITHUB, [undefined, undefined, "k3"]);
		expect(perLook.map((each) => each.length)).toEqual([4, 4, 1]);
		expect(readsIn(home).slice(sum(perLook))).toEqual(["get", "get_check_runs", "get_reviews", "get_comments"]);
	}, 60_000);
	it("a minute after the reads that saw a value ended, not sooner: a look within it reads again", async () => {
		// the baseline at NOW, a look 30 seconds on, then five minutes apart: the look at +30s is within the minute of
		// the baseline's reads, so what it reads is not sure and the next look reads again; only then is it carried
		const home = await tempHome();
		const counts: number[] = [];
		await watchScenario(home, new Faults(), {
			tasks: false,
			world: quiet,
			clicks: [undefined, undefined, undefined, undefined],
			at: (step) => NOW + [0, 0, 30_000, 5 * MINUTE, 10 * MINUTE][step]!,
			act: async (_step, { harness, core }) => {
				await runsEnded(harness);
				const before = readsIn(home).length;
				await core.lookWatch(harness, "banda-142");
				counts.push(readsIn(home).length - before);
			},
		});
		expect(counts).toEqual([4, 4, 4, 1]);
	}, 60_000);

	it("a guarded read that fails at the look where updated_at moved is read again at the next: the approval wakes", async () => {
		// quiet, confirmed at +5m; at +10m carol approves (`updated_at` moves) and GitHub refuses the reviews read once
		const home = await tempHome();
		const approved = (step: number): World => {
			const at = quietWorld(1) as { get: { [key: string]: Json }; get_reviews: Json[] };
			if (step >= 3) {
				at.get.updated_at = "2026-11-02T09:10:00Z";
				at.get_reviews = [{ id: 2, user: { login: "carol" }, state: "APPROVED" }];
			}
			return at as unknown as World;
		};
		const perLook: string[][] = [];
		const summary = await watchScenario(home, new Faults(), {
			tasks: false,
			world: approved,
			answer: (tool, args, step) =>
				step === 3 && args.method === "get_reviews"
					? failure("GitHub is having a moment")
					: byMethod(approved)(tool, args, step),
			clicks: [undefined, undefined, undefined, undefined, undefined],
			at: (step) => NOW + (step - 1) * 5 * MINUTE,
			act: async (_step, { harness, core }) => {
				await runsEnded(harness);
				const before = readsIn(home).length;
				await core.lookWatch(harness, "banda-142");
				perLook.push(readsIn(home).slice(before));
			},
		});
		// step 3 asked for the reviews and was refused: the old answer stands, nothing changes, and the failed read is
		// not taken as made; step 4 reads them again though `updated_at` is as kept, and carol's approval is seen
		expect(perLook[2]).toContain("get_reviews");
		expect(perLook[3]).toContain("get_reviews");
		expect(summary.wakes.map((wake) => [wake.at, wake.changes])).toEqual([[NOW + 20 * MINUTE, ["carol approved"]]]);
		expect(summary.tells).toEqual([]);
		expect(watchInvariants(summary)).toEqual([]);
	}, 60_000);

	it("a guarded read refused at two looks running is never taken as made: the approval wakes once GitHub answers", async () => {
		// quiet, confirmed at +5m; at +10m carol approves (`updated_at` moves) and GitHub refuses the reviews read at +10m
		// and again at +15m, when `updated_at` is as kept and the reading before had it. A read refused is not made, so
		// it is not sure and its old answer (from before the approval) is never carried: +20m reads it and carol wakes.
		// (A look that took a read as made before making it, or whatever came of it, would carry the stale answer here.)
		const home = await tempHome();
		const approved = (step: number): World => {
			const at = quietWorld(1) as { get: { [key: string]: Json }; get_reviews: Json[] };
			if (step >= 3) {
				at.get.updated_at = "2026-11-02T09:10:00Z";
				at.get_reviews = [{ id: 2, user: { login: "carol" }, state: "APPROVED" }];
			}
			return at as unknown as World;
		};
		const perLook: string[][] = [];
		const summary = await watchScenario(home, new Faults(), {
			tasks: false,
			world: approved,
			answer: (tool, args, step) =>
				(step === 3 || step === 4) && args.method === "get_reviews"
					? failure("GitHub is having a moment")
					: byMethod(approved)(tool, args, step),
			clicks: [undefined, undefined, undefined, undefined, undefined, undefined],
			at: (step) => NOW + (step - 1) * 5 * MINUTE,
			act: async (_step, { harness, core }) => {
				await runsEnded(harness);
				const before = readsIn(home).length;
				await core.lookWatch(harness, "banda-142");
				perLook.push(readsIn(home).slice(before));
			},
		});
		expect(perLook.slice(2, 5).map((each) => each.includes("get_reviews"))).toEqual([true, true, true]);
		expect(summary.wakes.map((wake) => [wake.at, wake.changes])).toEqual([[NOW + 25 * MINUTE, ["carol approved"]]]);
		expect(watchInvariants(summary)).toEqual([]);
	}, 60_000);

	it("the first look after a resume reads everything", async () => {
		const home = await tempHome();
		const counts: number[] = [];
		await watchScenario(home, new Faults(), {
			tasks: false,
			world: quiet,
			clicks: [undefined, undefined, undefined, undefined],
			at: (step) => NOW + (step - 1) * 5 * MINUTE,
			act: async (step, { harness, core, now }) => {
				await runsEnded(harness);
				const reconcile = (h: Harness) => core.reconcile(h);
				if (step === 4) {
					await pause(harness, reconcile, "banda-142", true, now);
					await pause(harness, reconcile, "banda-142", false, now);
				}
				const before = readsIn(home).length;
				await core.lookWatch(harness, "banda-142");
				counts.push(readsIn(home).length - before);
			},
		});
		// the baseline, its confirmation, a quiet look (one read), and the look after the resume: every read again
		expect(counts.slice(0, 3)).toEqual([4, 4, 1]);
		expect(counts[3]).toBe(4);
	}, 60_000);

	it("a look that carried answers keeps nothing when another watch's look replaced the reading meanwhile", async () => {
		// Mara looks at the baseline, confirms at +5m and carries at +10m. At +15m lint fails on the same head (nothing on
		// the pull request moves); while Mara's look reads the pull request, Otto's first look reads everything and keeps
		// a newer reading. Mara's look carried the checks from the older one: it keeps nothing ("raced"), never a reading
		// that says lint went back to passing. Her next look diffs Otto's reading (held for the kind's
		// settling minute) and the one after wakes once.
		const home = await tempHome();
		const failing = (step: number): World => {
			const at = quietWorld(1) as { get_check_runs: { check_runs: { [key: string]: Json }[] } };
			if (step >= 4) Object.assign(at.get_check_runs.check_runs[1] as object, { conclusion: "failure" });
			return at as unknown as World;
		};
		let scene: Scene | undefined;
		let armed = false;
		const outcomes: string[] = [];
		const summary = await watchScenario(home, new Faults(), {
			second: true,
			tasks: false,
			world: failing,
			answer: async (tool, args, step) => {
				if (armed && args.method === "get" && scene !== undefined) {
					armed = false;
					outcomes.push(`otto:${(await scene.core.lookWatch(scene.harness, "banda-142-otto")).outcome}`);
				}
				return byMethod(failing)(tool, args, step);
			},
			clicks: [undefined, undefined, undefined, undefined, undefined, undefined],
			at: (step) => NOW + (step - 1) * 5 * MINUTE,
			act: async (step, current) => {
				scene = current;
				await runsEnded(current.harness);
				armed = step === 4;
				outcomes.push(`mara:${(await current.core.lookWatch(current.harness, "banda-142")).outcome}`);
			},
		});
		expect(outcomes.slice(3)).toEqual(["otto:baseline", "mara:raced", "mara:held", "mara:looked"]);
		const said = summary.wakes.map((wake) => [wake.watch, wake.changes]);
		expect(said).toEqual([["banda-142", ["lint failed"]]]);
		expect(summary.tells).toEqual([]);
		expect(watchInvariants(summary)).toEqual([]);
	}, 60_000);
});
