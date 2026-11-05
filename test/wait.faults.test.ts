import { describe, expect, it } from "vitest";
import type { WaitEnded } from "../src/core/wait.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	outcome: { status: string };
	results: string[];
	waits: WaitEnded[];
	runs: string[];
	parked: unknown[];
	open: number;
	commits: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/wait-worker.ts", [await tempHome()], schedules);
	return { ...(last as Summary), kills };
};

/**
 * The effect runs only once approved, at most once per approval to run it (the first, then one per interruption the
 * owner chose to run again); every Wait ends answered, none stays open or parked, and the tool answers the model once.
 */
function check(summary: Summary) {
	expect(summary.outcome.status).toBe("completed");
	expect(summary.results).toHaveLength(1);
	expect(summary.open).toBe(0);
	expect(summary.parked).toEqual([]);
	for (const wait of summary.waits) expect(wait).toMatchObject({ outcome: "answered", answer: "approve" });
	const approvals = summary.waits.filter((w) => w.ask.type === "approval" && !w.ask.interrupted);
	const again = summary.waits.filter((w) => w.ask.type === "approval" && w.ask.interrupted);
	expect(approvals).toHaveLength(1);
	expect(summary.runs.length).toBeGreaterThanOrEqual(1);
	expect(summary.runs.length).toBeLessThanOrEqual(1 + again.length);
}

describe("Wait under faults", () => {
	it("sweep: one kill at every commit of an approved effect, before and after each, and in the effect", async () => {
		const clean = await run([]);
		check(clean);
		expect(clean.runs).toHaveLength(1);
		const faults: Fault[] = [{ point: "effect", hit: 1, kind: "kill" }];
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			8,
			faults.map((fault) => async () => {
				const killed = await run([[fault]]);
				try {
					expect(killed.kills).toBe(1);
					check(killed);
					if (fault.point === "effect") expect(killed.runs).toHaveLength(2);
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 300_000);

	it("a Wait killed six times over while it waits is never parked", async () => {
		const killed = await run(Array.from({ length: 6 }, () => [{ point: "answer", hit: 1, kind: "kill" } as const]));
		expect(killed.kills).toBe(6);
		check(killed);
		expect(killed.runs).toHaveLength(1);
	}, 120_000);
});
