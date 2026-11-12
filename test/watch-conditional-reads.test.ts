import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Item, type Json, madeNow, mayCarry, parseUnless, SURE_AFTER } from "../src/core/follow.ts";
import { Faults } from "./fault/faults.ts";
import {
	GITHUB,
	NOW,
	QUIET_READS,
	quietWorld,
	runsEnded,
	SCENARIOS,
	type ScenarioConnection,
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
			every: "30m",
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
		// an answer is sure when the reading before its look already had the value, a minute or more before
		expect(madeNow(unless, answers, { answers: kept, at: t - SURE_AFTER }, t)).toEqual(sure);
		expect(madeNow(unless, answers, { answers: kept, at: t - SURE_AFTER + 1 }, t)).toEqual({ at: t });
		expect(madeNow(unless, { pr: { updated_at: "y" } }, { answers: kept, at: t - MINUTE }, t)).toEqual({ at: t });
		expect(madeNow(unless, answers, undefined, t)).toEqual({ at: t });
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

	it("a quiet pull request is one request a look: 48 an hour before, 14 now, 15 on average over two hours", async () => {
		// a look every five minutes: the baseline, the look that confirms it, then two hours of looks
		const looks = 2 + 24;
		const after = await looked(quiet, looks, 5 * MINUTE);
		const before = await looked(quiet, looks, 5 * MINUTE, EVERY_READ);
		const hour = (each: string[][]) => sum(each.slice(2, 14));
		expect(hour(before.perLook)).toBe(48);
		// the pull request every look, the checks every half hour for a re-run on the same head
		expect(hour(after.perLook)).toBe(14);
		expect(after.perLook.slice(2, 14).filter((each) => each.length === 1)).toHaveLength(10);
		// over two hours the reviews and comments are read once each, as their two hours have passed
		expect(sum(after.perLook.slice(2))).toBe(30);
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

	it("a check run again on the same head moves nothing on the pull request: it is seen within the checks' half hour", async () => {
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
		// read at the baseline, its confirmation, then half an hour after that (+35m, step 8)
		expect(checked).toEqual([1, 2, 8]);
		// seen at +35m, held for the kind's settling minute, woken at the look after
		expect(summary.wakes.map((wake) => [wake.at, wake.changes])).toEqual([[NOW + 40 * MINUTE, ["lint failed"]]]);
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
		// read at the look that saw `updated_at` move and at the next (the deploy check ran, and that answer was not yet
		// sure); that one finds it failed, done on a value already kept, so the look after carries it
		expect(checked).toEqual([1, 2, 3, 4]);
		expect(summary.wakes.map((wake) => [wake.at, wake.changes])).toEqual([
			[NOW + 20 * MINUTE, ["deploy failed", "checks finished"]],
		]);
		expect(watchInvariants(summary)).toEqual([]);
	}, 60_000);

	it("the owner's Check now reads everything, as they asked", async () => {
		// the last step's click looks after the act's look of that step: the act's carries, the click reads every read
		const { perLook, home } = await looked(quiet, 4, 5 * MINUTE, GITHUB, [undefined, undefined, undefined, "k4"]);
		expect(perLook.map((each) => each.length)).toEqual([4, 4, 1, 1]);
		expect(readsIn(home).slice(sum(perLook))).toEqual(["get", "get_check_runs", "get_reviews", "get_comments"]);
	}, 60_000);
});
