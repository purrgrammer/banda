/**
 * What a look decides, on its own: the baseline, nothing new, a hold within the settling time or while the last run
 * goes, the day's limit, and what is said as a wake, a tell, or quietly. The pull request kind banda ships, over the
 * scenario's world, so the words are the ones the chat shows.
 */
import { describe, expect, it } from "vitest";
import { GITHUB_OBJECTS } from "../scripts/github-objects.ts";
import { BUSY_EVERY, type Follow, type Item, reading } from "../src/core/follow.ts";
import { parseObjects } from "../src/core/objects.ts";
import { CHANGES_SAID, DEFAULT_WAKES_A_DAY, decide, type FollowedReading } from "../src/core/watches.ts";
import { NOW, world } from "./fault/watch-scenario.ts";

const PR: Follow = (() => {
	const parsed = parseObjects(GITHUB_OBJECTS, () => true);
	if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
	const follow = parsed.objects.pull_request?.follow;
	if (follow === undefined) throw new Error("the pull request kind is not followed");
	return follow;
})();

const MINUTE = 60_000;
/** The world at `step`, read as the kind's reads name it, its derived conditions beside. */
const at = (step: number, before?: Item): Item => {
	const w = world(step);
	return reading(PR, { pr: w.get, checks: w.get_check_runs, reviews: w.get_reviews, comments: w.get_comments }, before);
};
/** The newest reading `version`, with the ones before it kept: step 0 as version 1, step 1 as version 2, and so on. */
const kept = (steps: readonly number[]): FollowedReading => {
	const readings = steps.map((step, i) => ({
		version: i + 1,
		answers: at(step, i === 0 ? undefined : at(steps[i - 1] ?? 0)),
	}));
	const newest = readings[readings.length - 1] ?? { version: 1, answers: at(0) };
	return { answers: newest.answers, at: NOW, source: "s", version: newest.version, earlier: readings.slice(0, -1) };
};
const look = (over: Partial<Parameters<typeof decide>[0]> = {}) =>
	decide({
		seen: 1,
		record: {},
		kept: kept([0, 1]),
		after: at(1, at(0)),
		same: true,
		version: 2,
		follow: PR,
		// the account's own comment at step 1 is nothing; ana's review and lint's failure wake
		me: "bandarra",
		until: undefined,
		wakesADay: undefined,
		now: NOW,
		click: false,
		running: false,
		every: 5 * MINUTE,
		...over,
	});

describe("what a look decides", () => {
	it("the first look is the baseline; a reading the same as the one seen is nothing", () => {
		expect(look({ seen: undefined })).toEqual({ does: "baseline" });
		expect(look({ kept: undefined })).toEqual({ does: "nothing" });
		expect(look({ seen: 2 })).toEqual({ does: "nothing" });
	});

	it("a change that wakes is held for the settling time, then said once with what joined it", () => {
		const held = look();
		expect(held).toMatchObject({ does: "hold", burst: NOW, next: NOW + MINUTE });
		if (held.does !== "hold") throw new Error("not held");
		expect(JSON.stringify([...held.held.wake].sort())).toBe(JSON.stringify(["ana approved", "lint failed"]));
		expect(JSON.stringify(held.held.tell)).toBe(JSON.stringify(["checks finished"]));
		const said = look({
			record: {
				burst: NOW - MINUTE,
				held: { wake: [...held.held.wake], tell: [...held.held.tell], ids: [...held.held.ids] },
			},
		});
		expect(said).toMatchObject({ does: "wake", burst: NOW - MINUTE, gap: false });
		if (said.does !== "wake") throw new Error("not a wake");
		expect(JSON.stringify([...said.changes].sort())).toBe(
			JSON.stringify(["ana approved", "checks finished", "lint failed"]),
		);
		expect(said.ids).toHaveLength(2);
	});

	it("while the last wake's run still goes, the hold looks again at the busy cadence", () => {
		expect(look({ running: true, record: { burst: NOW - 10 * MINUTE } })).toMatchObject({
			does: "hold",
			burst: NOW - 10 * MINUTE,
			next: NOW + Math.min(5 * MINUTE, BUSY_EVERY),
		});
	});

	it("the owner's Check now wakes at once, neither held nor limited", () => {
		expect(look({ click: true })).toMatchObject({ does: "wake" });
		const today = Array.from({ length: DEFAULT_WAKES_A_DAY }, () => NOW - MINUTE);
		expect(look({ click: true, record: { wakes: today } })).toMatchObject({ does: "wake" });
	});

	it("past its wakes a day it pauses itself, unless what it sees ends it", () => {
		const today = Array.from({ length: DEFAULT_WAKES_A_DAY }, () => NOW - MINUTE);
		expect(look({ record: { wakes: today, burst: NOW - MINUTE } })).toMatchObject({
			does: "limit",
			limit: DEFAULT_WAKES_A_DAY,
		});
		expect(look({ record: { wakes: today.slice(1), burst: NOW - MINUTE } })).toMatchObject({ does: "wake" });
		expect(look({ record: { wakes: today, burst: NOW - MINUTE }, wakesADay: 30 })).toMatchObject({ does: "wake" });
		const yesterday = Array.from({ length: DEFAULT_WAKES_A_DAY }, () => NOW - 25 * 60 * MINUTE);
		expect(look({ record: { wakes: yesterday, burst: NOW - MINUTE } })).toMatchObject({ does: "wake" });
		const merged = look({
			record: { wakes: today, burst: NOW - MINUTE },
			kept: kept([0, 1, 3]),
			after: at(3, at(1)),
			version: 3,
		});
		expect(merged).toMatchObject({ does: "wake", ended: "merged" });
	});

	it("an end alone is said as the end; a change the kind ignores moves the cursor quietly", () => {
		const closed = world(0);
		const pr = { ...(closed.get as Item), state: "closed" };
		const after = reading(
			PR,
			{ pr, checks: closed.get_check_runs, reviews: closed.get_reviews, comments: closed.get_comments },
			at(0),
		);
		// an end is held for the settling time like a wake: here the time has passed
		const ended = look({
			record: { burst: NOW - MINUTE },
			kept: { ...kept([0]), version: 2, earlier: [{ version: 1, answers: at(0) }], answers: after },
			after,
			version: 2,
		});
		expect(ended).toMatchObject({ does: "wake", ended: "closed" });
		if (ended.does !== "wake") throw new Error("not a wake");
		expect(ended.changes).toContain("closed");
		const touched = reading(
			PR,
			{
				...world(0),
				pr: { ...(world(0).get as Item), updated_at: "later" },
				checks: world(0).get_check_runs,
				reviews: world(0).get_reviews,
				comments: world(0).get_comments,
			},
			at(0),
		);
		const quiet = look({
			kept: { ...kept([0]), version: 2, earlier: [{ version: 1, answers: at(0) }], answers: touched },
			after: touched,
			version: 2,
		});
		expect(quiet).toMatchObject({ does: "quiet", changes: [] });
	});

	it("a cursor that fell off the readings kept says changes may be missing", () => {
		expect(look({ seen: 0, record: { burst: NOW - MINUTE } })).toMatchObject({ does: "wake", gap: true });
	});

	it("however much changed, a bounded few are named and the rest counted", () => {
		const many = Array.from({ length: CHANGES_SAID + 5 }, (_, i) => `change ${i}`);
		const said = look({ record: { burst: NOW - MINUTE, held: { wake: many, tell: [], ids: many } } });
		if (said.does !== "wake") throw new Error("not a wake");
		expect(said.changes).toHaveLength(CHANGES_SAID + 1);
		expect(said.changes[CHANGES_SAID]).toMatch(/^and \d+ more$/);
	});
});
