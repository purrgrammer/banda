import { describe, expect, it } from "vitest";
import type { WaitEnded } from "../src/core/wait.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	waits: WaitEnded[];
	effects: number;
	runs: string[];
	results: number;
	parked: unknown[];
	activity: string[];
	permissions: string[];
	open: number;
	commits: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/permission-worker.ts", [await tempHome()], schedules);
	return { ...(last as Summary), kills };
};

/**
 * Whatever was killed: the first send runs once approved with a permission, given once; the second runs within the permission,
 * never asked; the third, after the revoke, asks and is denied, and never runs. The fourth and fifth, at once in two
 * chats, are allowed together, one answer each: the first answer's permission covers the other (its open ask answered
 * by it, or its call never asking), so one permission serves both and each runs. A send runs again only when a kill
 * interrupted it and the owner said to run it again. Every tool answered its model once; no ask stays open, nothing is
 * parked, and no permission is left.
 */
function check(summary: Summary) {
	const first = (body: string) =>
		summary.waits.filter((w) => w.ask.type === "approval" && !w.ask.interrupted && w.ask.args.body === body);
	const again = (body: string) =>
		summary.waits.filter((w) => w.ask.type === "approval" && w.ask.interrupted === true && w.ask.args.body === body);
	const runs = (body: string) => summary.runs.filter((ran) => ran === body).length;
	expect(summary.open).toBe(0);
	expect(summary.parked).toEqual([]);
	expect(summary.results).toBe(5);
	expect(first("1")).toHaveLength(1);
	expect(first("1")[0]).toMatchObject({ outcome: "answered", answer: "approve", permitted: { scope: "always" } });
	expect(first("2")).toEqual([]);
	expect(first("3")).toHaveLength(1);
	expect(first("3")[0]).toMatchObject({ outcome: "answered", answer: "deny" });
	for (const body of ["4", "5"]) {
		expect(first(body).length, `asks of ${body}`).toBeLessThanOrEqual(1);
		for (const asked of first(body))
			expect(asked).toMatchObject({ outcome: "answered", answer: "approve", permitted: { scope: "always" } });
	}
	expect(first("4").length + first("5").length).toBeGreaterThanOrEqual(1);
	for (const body of ["1", "2", "4", "5"]) {
		expect(runs(body), `runs of ${body}`).toBeGreaterThanOrEqual(1);
		expect(runs(body), `runs of ${body}`).toBeLessThanOrEqual(1 + again(body).length);
	}
	expect(runs("3")).toBe(0);
	expect(summary.effects).toBeGreaterThanOrEqual(1);
	expect(summary.activity.filter((what) => what.startsWith("You allowed"))).toEqual([
		"You allowed send messages to ana, always",
		"You allowed send messages to ana, always",
	]);
	expect(summary.activity.filter((what) => what.startsWith("You took back"))).toEqual([
		"You took back: send messages to ana",
		"You took back: send messages to ana",
	]);
	expect(summary.permissions).toEqual([]);
}

describe("permissions under faults", () => {
	it("sweep: one kill at every commit, before and after each, in each effect, at each answer and at the revoke", async () => {
		const clean = await run([]);
		check(clean);
		expect([...clean.runs].sort()).toEqual(["1", "2", "4", "5"]);
		const faults: Fault[] = [
			{ point: "revoke", hit: 1, kind: "kill" },
			{ point: "revoke", hit: 2, kind: "kill" },
		];
		// each effect, and each answer: a kill between the answers of an "allow all" among them
		for (let hit = 1; hit <= 4; hit++)
			faults.push({ point: "effect", hit, kind: "kill" }, { point: "answer", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			8,
			faults.map((fault) => async () => {
				const killed = await run([[fault]]);
				try {
					expect(killed.kills).toBe(1);
					check(killed);
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 600_000);
});
