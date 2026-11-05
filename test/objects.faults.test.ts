import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { type ObjectScenario, type ObjectSummary, objectProblems } from "./fault/object-scenario.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const points = ["object:read", "object:answered", "object:kept"] as const;
async function run(scenario: ObjectScenario, fault?: Fault) {
	const result = await runWorker(
		"test/fault/object-worker.ts",
		[await tempHome(), JSON.stringify(scenario)],
		fault === undefined ? [] : [[fault]],
	);
	const summary = result.last as ObjectSummary;
	expect(objectProblems(summary, scenario)).toEqual([]);
	return { ...summary, kills: result.kills };
}
describe("object readings under faults", () => {
	it("generated errors and kills never mix accounts, publish revoked bytes, or turn reads into writes", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({ count: fc.integer({ min: 1, max: 4 }), failed: fc.boolean(), revoke: fc.boolean() }),
				fc.constantFrom(...points),
				fc.constantFrom("error" as const, "kill" as const),
				async (scenario, point, kind) => {
					await run(scenario, { point, hit: 1, kind });
				},
			),
			{ numRuns: pbtFaultRuns(12) },
		);
	}, 120_000);
	it("sweep: SIGKILL at every reading effect and durable commit, checked by the same invariants", async () => {
		const scenario = { count: 2, failed: true, revoke: true };
		const clean = await run(scenario);
		const faults: Fault[] = [];
		for (const point of points)
			for (let hit = 1; hit <= (clean.points[point] ?? 0); hit++) faults.push({ point, hit, kind: "kill" });
		for (const point of ["commit:before", "commit:after"] as const)
			for (let hit = 1; hit <= clean.commits; hit++) faults.push({ point, hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const result = await run(scenario, fault);
				expect(result.kills, JSON.stringify(fault)).toBe(1);
			}),
		);
	}, 600_000);
	it("thrown faults on both sides of storage reopen without losing an admitted reading", async () => {
		for (const point of ["commit:before", "commit:after"] satisfies FaultPoint[])
			await run({ count: 2, failed: false, revoke: false }, { point, hit: 2, kind: "error" });
	}, 60_000);
});
