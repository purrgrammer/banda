import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { WaitEnded } from "../src/core/wait.ts";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

type Summary = {
	outcome: { status: string };
	waits: WaitEnded[];
	open: number;
	parked: unknown[];
	commits: number;
};
const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/question-worker.ts", [await tempHome()], schedules);
	return { ...(last as Summary), kills };
};
const check = (summary: Summary) => {
	expect(summary.outcome.status).toBe("completed");
	expect(summary.open).toBe(0);
	expect(summary.parked).toEqual([]);
	expect(summary.waits).toHaveLength(1);
	expect(summary.waits[0]).toMatchObject({ outcome: "dismissed" });
	expect(summary.waits[0]).not.toHaveProperty("answer");
};

describe("dismissed questions under faults", () => {
	it("survives a kill at every commit, the answer and model boundary", async () => {
		const clean = await run([]);
		check(clean);
		const points: Fault[] = [
			{ point: "answer", hit: 1, kind: "kill" },
			{ point: "model", hit: 1, kind: "kill" },
			{ point: "model", hit: 2, kind: "kill" },
		];
		for (let hit = 1; hit <= clean.commits; hit++)
			points.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			6,
			points.map((fault) => async () => {
				try {
					const killed = await run([[fault]]);
					expect(killed.kills).toBe(1);
					check(killed);
				} catch (error) {
					throw new Error(`${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 180_000);

	it("generated restart points never turn dismissal into an answer", async () => {
		const points: readonly FaultPoint[] = ["answer", "model", "commit:before", "commit:after"];
		await fc.assert(
			fc.asyncProperty(fc.constantFrom(...points), fc.integer({ min: 1, max: 3 }), async (point, hit) => {
				const summary = await run([[{ point, hit: point === "answer" ? 1 : hit, kind: "kill" }]]);
				check(summary);
			}),
			{ numRuns: pbtRuns(4) },
		);
	}, 120_000);
});
