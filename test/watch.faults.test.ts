import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { type WatchSummary, watchProblems } from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/watch-worker.ts", [await tempHome()], schedules);
	return { ...(last as WatchSummary), kills };
};

const POINTS: FaultPoint[] = ["commit:before", "commit:after", "model", "watch:read", "send:before", "send:after"];

describe("a watch on a pull request under faults", () => {
	it("sweep: one kill at every commit, read, model request and send; each change wakes once, the merge ends it", async () => {
		const clean = await run([]);
		expect(clean.kills).toBe(0);
		expect(watchProblems(clean)).toEqual([]);
		const faults: Fault[] = [
			{ point: "send:before", hit: 1, kind: "kill" },
			{ point: "send:after", hit: 1, kind: "kill" },
		];
		for (let hit = 1; hit <= clean.looks; hit++) faults.push({ point: "watch:read", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.models; hit++) faults.push({ point: "model", hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const killed = await run([[fault]]);
				try {
					expect(killed.kills).toBe(1);
					expect(watchProblems(killed)).toEqual([]);
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 900_000);

	it("property: under any few kills, each change wakes once and the merge ends the watch", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						point: fc.constantFrom(...POINTS),
						hit: fc.integer({ min: 1, max: 40 }),
						kind: fc.constant("kill" as const),
					}),
					{ minLength: 1, maxLength: 3 },
				),
				async (kills) => {
					expect(watchProblems(await run(kills.map((kill) => [kill])))).toEqual([]);
				},
			),
			{ numRuns: pbtFaultRuns(3) },
		);
	}, 600_000);
});
