import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { WakeData } from "../src/core/routines.ts";
import { localTime } from "../src/core/schedule.ts";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const MINUTE = 60_000;
const START = new Date(2026, 10, 2, 8, 0).getTime();
const MINUTES = 4;

type Summary = {
	wakes: WakeData[];
	turns: ({ status: string; result?: unknown } | undefined)[];

	sent: string[];

	live: (string | undefined)[];
	parked: unknown[];
	commits: number;
	models: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/routine-timer-worker.ts", [await tempHome()], schedules);
	return { ...(last as Summary), kills };
};

const dues = (...minutes: number[]) => minutes.map((m) => START + m * MINUTE);

/**
 * The routine invariants: each routine fires once per due time, none missed and none twice, whatever was killed; every wake's
 * run ends; what each run says reaches the owner (at least once); every routine still has
 * its task, and nothing is parked.
 */
function check(summary: Summary) {
	const of = (routine: string) =>
		summary.wakes
			.filter((wake) => wake.routine === routine)
			.map((wake) => wake.due)
			.sort((a, b) => a - b);
	expect(of("tick"), "tick's wakes").toEqual(dues(1, 2, 3, 4));
	expect(of("price"), "price's wakes").toEqual(dues(1, 2, 3, 4));
	for (const turn of summary.turns) expect(turn?.status, "a wake's Turn").toBe("completed");
	for (const due of dues(1, 2, 3, 4))
		expect(
			summary.sent.some((text) => text.startsWith(`re: Your routine "tick" was due at ${localTime(due)}`)),
			`tick's answer for ${localTime(due)} sent`,
		).toBe(true);
	for (const due of dues(1, 2, 3, 4))
		expect(
			summary.sent.some((text) => text.startsWith(`re: Your routine "price" was due at ${localTime(due)}`)),
			`price's answer for ${localTime(due)} sent`,
		).toBe(true);

	expect(summary.live.every((state) => state !== "none" && state !== "terminal" && state !== undefined)).toBe(true);
	expect(summary.parked).toEqual([]);
}

const POINTS: FaultPoint[] = ["commit:before", "commit:after", "model", "send:before", "send:after"];

describe("Routines under faults", () => {
	it("sweep: one kill at every commit, model request and send; each routine fires once per due time", async () => {
		const clean = await run([]);
		check(clean);
		const faults: Fault[] = [];
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.models; hit++) faults.push({ point: "model", hit, kind: "kill" });

		for (let hit = 1; hit <= MINUTES; hit++)
			faults.push({ point: "send:before", hit, kind: "kill" }, { point: "send:after", hit, kind: "kill" });
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
	}, 900_000);

	it("property: under any few kills, each routine fires once per due time", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						point: fc.constantFrom(...POINTS),
						hit: fc.integer({ min: 1, max: 60 }),
						kind: fc.constant("kill" as const),
					}),
					{ minLength: 1, maxLength: 3 },
				),
				async (kills) => {
					check(await run(kills.map((kill) => [kill])));
				},
			),
			{ numRuns: pbtFaultRuns(3) },
		);
	}, 600_000);
});
