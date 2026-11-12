/**
 * #100 (tail reads) with #102 (conditional reads), together: a read that has both a `tail` and an `unless` is carried
 * forward only after a complete tail read, never after one that is `behind` (its end past the pages a look reads) or
 * refused. Here a pull request whose `updated_at` never moves has a thousand reviews, ten pages: the baseline and the
 * looks after must go on catching up three pages a look, each asking GitHub, until one reaches the end; only then may a
 * look carry the reviews.
 */
import { describe, expect, it } from "vitest";
import type { Item } from "../src/core/follow.ts";
import { Faults } from "./fault/faults.ts";
import { type Answer, failure, NOW, runsEnded, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

const MINUTE = 60_000;
const reviews = (n: number, first = 10_001): Item[] =>
	Array.from({ length: n }, (_, i) => ({ id: first + i, user: { login: `r${first + i}` }, state: "COMMENTED" }));

/** GitHub as #100's tests fake it, its pull request's `updated_at` constant: the pages each look asked, by method. */
const constant =
	(
		all: Item[] | ((step: number) => Item[]),
		asked: { [method: string]: number[] }[],
		updated = (_step: number) => "2026-11-02T08:00:00Z",
	): Answer =>
	(tool, args, step) => {
		if (tool !== "pull_request_read") return failure("not that");
		const method = String(args.method);
		const look = asked.at(-1) as { [method: string]: number[] };
		const n = Number(args.page ?? 1);
		look[method] = [...(look[method] ?? []), n];
		if (method === "get") {
			const pr: Item = {
				number: 142,
				title: "Keep objects as data",
				state: "open",
				draft: false,
				merged: false,
				user: { login: "ana" },
				head: { ref: "objects", sha: "a1" },
				updated_at: updated(step),
				html_url: "https://github.com/acme/banda/pull/142",
			};
			return pr;
		}
		if (method === "get_check_runs") {
			const checks: Item = {
				total_count: 1,
				check_runs: [{ id: 1, name: "unit", status: "completed", conclusion: "success" }],
			};
			return checks;
		}
		const size = Number(args.perPage ?? 30);
		if (method === "get_reviews") return (typeof all === "function" ? all(step) : all).slice((n - 1) * size, n * size);
		if (method === "get_comments") return [];
		return failure(`no ${method}`);
	};

describe("a tail read with an unless", () => {
	it("a thousand reviews and updated_at never moving: every look catches up three pages until the end, then carries", async () => {
		const asked: { [method: string]: number[] }[] = [];
		const behind: boolean[] = [];
		const looks = 8;
		const summary = await watchScenario(await tempHome(), new Faults(), {
			tasks: false,
			answer: constant(reviews(1000), asked),
			clicks: Array.from({ length: looks }, () => undefined),
			at: (step) => NOW + (step - 1) * 5 * MINUTE,
			act: async (_step, { harness, core }) => {
				await runsEnded(harness);
				asked.push({});
				await core.lookWatch(harness, "banda-142");
				const { Watches } = await import("../src/core/watches.ts");
				const { context } = await import("../src/core/store.ts");
				behind.push((await harness.snapshot(Watches, context))?.watches["banda-142"]?.behind !== undefined);
			},
		});
		const pages = asked.map((look) => look.get_reviews ?? []);
		// the baseline and the four looks after it catch up three pages a look, asking GitHub at every one (none carried
		// while behind, though `updated_at` is as kept and the reading before had it); the fifth reaches the end, a
		// complete read, and is made
		expect(pages.slice(0, 5)).toEqual([
			[1, 2, 3],
			[3, 4, 5],
			[5, 6, 7],
			[7, 8, 9],
			[9, 10, 11],
		]);
		expect(pages.slice(0, 5).every((each) => each.length > 0)).toBe(true);
		// once a look reached the end, a later look with `updated_at` as kept carries the reviews, asking nothing
		expect(pages.slice(5).some((each) => each.length === 0)).toBe(true);
		// (the row's "behind" stays until a wake without a gap, as before either PR: this world never wakes)
		console.log(`PAGES ${JSON.stringify(pages)} BEHIND ${JSON.stringify(behind)}`);
		expect(summary.wakes).toEqual([]);
		expect(summary.tells).toEqual([]);
		expect(watchInvariants(summary)).toEqual([]);
	}, 60_000);
	it("reused reviews, then a burst past a look's pages with updated_at moving once: every look catches up, none reuses the old list", async () => {
		// 150 reviews, read whole, confirmed and carried; at step 4, 700 more arrive and `updated_at` moves once, then
		// stays. A look's three pages do not reach the end: it is behind, its list stands as last read (the old 150).
		// Were a behind read taken as made, the next look would find it sure (the reading before had the same
		// `updated_at`) and carry the old 150 for up to the read's period, the 700 unseen. Made only when whole, every
		// look catches up until one reaches the end, and the new reviews wake.
		const asked: { [method: string]: number[] }[] = [];
		const looks = 9;
		const summary = await watchScenario(await tempHome(), new Faults(), {
			tasks: false,
			answer: constant(
				(step) => (step >= 4 ? reviews(850) : reviews(150)),
				asked,
				(step) => (step >= 4 ? "2026-11-02T09:15:00Z" : "2026-11-02T08:00:00Z"),
			),
			clicks: Array.from({ length: looks }, () => undefined),
			at: (step) => NOW + (step - 1) * 5 * MINUTE,
			act: async (_step, { harness, core }) => {
				await runsEnded(harness);
				asked.push({});
				await core.lookWatch(harness, "banda-142");
			},
		});
		const pages = asked.map((look) => look.get_reviews ?? []);
		console.log(`PAGES ${JSON.stringify(pages)}`);
		// the baseline and its confirmation read the 150 whole; the third look carries them
		expect(pages.slice(0, 3).map((each) => each.length > 0)).toEqual([true, true, false]);
		// from the burst until a look reaches the end of the 850, every look asks GitHub for reviews
		const reached = pages.findIndex((each, i) => i >= 3 && each.includes(9));
		expect(reached).toBeGreaterThan(3);
		expect(pages.slice(3, reached + 1).every((each) => each.length > 0)).toBe(true);
		// and once whole, a look with `updated_at` as kept carries them again
		expect(pages.slice(reached + 1).some((each) => each.length === 0)).toBe(true);
		// the new reviews woke the agent
		expect(summary.wakes.length).toBeGreaterThan(0);
		expect(watchInvariants(summary)).toEqual([]);
	}, 60_000);
});
