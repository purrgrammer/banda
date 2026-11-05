import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	outcome: { status: string };
	results: { error: boolean; text: string }[];
	runs: string[];
	orphans: number;
	parked: unknown[];
	commits: number;
};

let n = 0;
const run = async (schedules: readonly (readonly Fault[])[]) => {
	// a mark no other run shares, so a command that outlived its process is this run's
	const mark = `banda-box-fault-${process.pid}-${n++}`;
	const { last, kills } = await runWorker("test/fault/box-worker.ts", [await tempHome(), mark], schedules);
	return { ...(last as Summary), kills };
};

/**
 * A command in the box runs at most once, whatever was killed and when: a call a crash interrupted is reported to the
 * model, never run again; nothing a killed daemon started keeps running; the Turn ends and nothing is parked.
 */
function check(summary: Summary) {
	expect(summary.outcome.status).toBe("completed");
	expect(summary.results).toHaveLength(1);
	expect(summary.parked).toEqual([]);
	expect(summary.orphans).toBe(0);
	const starts = summary.runs.filter((line) => line === "start").length;
	const dones = summary.runs.filter((line) => line === "done").length;
	expect(starts).toBeLessThanOrEqual(1);
	expect(dones).toBeLessThanOrEqual(starts);
	if (!summary.results[0]?.error) expect([starts, dones]).toEqual([1, 1]);
}

describe("the box under faults", () => {
	it("sweep: one kill at every commit, before a command starts and while it runs", async () => {
		const clean = await run([]);
		check(clean);
		expect(clean.runs).toEqual(["start", "done"]);
		const faults: Fault[] = [
			{ point: "exec:before", hit: 1, kind: "kill" },
			{ point: "exec:output", hit: 1, kind: "kill" },
			{ point: "model", hit: 1, kind: "kill" },
			{ point: "model", hit: 2, kind: "kill" },
		];
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			8,
			faults.map((fault) => async () => {
				const killed = await run([[fault]]);
				try {
					expect(killed.kills).toBe(1);
					check(killed);
					if (fault.point === "exec:output") {
						// killed while it ran: it started, never finished, and the model is told so
						expect(killed.runs).toEqual(["start"]);
						expect(killed.results[0]?.error).toBe(true);
					}
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 300_000);
});
