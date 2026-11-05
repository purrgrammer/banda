import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	state: string;
	woke: string[];
	prompts: number;
	loaded: number;
	orphans: number;
	parked: unknown[];
	commits: number;
};

let n = 0;
const run = async (schedules: readonly (readonly Fault[])[], mode?: "continue") => {
	// a mark no other run shares, so a command that outlived its process is this run's
	const mark = `banda-harness-fault-${process.pid}-${n++}`;
	const { last, kills } = await runWorker(
		"test/fault/harness-worker.ts",
		[await tempHome(), mark, ...(mode === undefined ? [] : [mode])],
		schedules,
	);
	return { ...(last as Summary), kills };
};

/**
 * A harness session under kills: its ask reaches the harness at most once, and exactly once when it finished; it ends
 * once (done, interrupted past the ask, failed before it), waking its agent once; nothing its harness started outlives
 * the process that started it; nothing is parked.
 */
function check(summary: Summary) {
	expect(["done", "interrupted", "failed"]).toContain(summary.state);
	expect(summary.woke).toHaveLength(1);
	expect(summary.prompts).toBeLessThanOrEqual(1);
	if (summary.state === "done") expect(summary.prompts).toBe(1);
	expect(summary.orphans).toBe(0);
	expect(summary.parked).toEqual([]);
}

/** One kill at every harness boundary and every commit of a clean run, and errors at the boundaries that may throw. */
function sweep(commits: number): Fault[] {
	const faults: Fault[] = [
		{ point: "harness:spawn", hit: 1, kind: "kill" },
		{ point: "harness:prompted", hit: 1, kind: "kill" },
		{ point: "harness:update", hit: 1, kind: "kill" },
		{ point: "harness:ask", hit: 1, kind: "kill" },
		{ point: "harness:spawn", hit: 1, kind: "error" },
		{ point: "harness:ask", hit: 1, kind: "error" },
	];
	for (let hit = 1; hit <= commits; hit++)
		faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
	return faults;
}

describe("a harness session under faults", () => {
	it("sweep: one kill at every commit and at every harness boundary", async () => {
		const clean = await run([]);
		check(clean);
		expect(clean.state).toBe("done");
		await pool(
			2,
			sweep(clean.commits).map((fault) => async () => {
				const killed = await run([[fault]]);
				try {
					if (fault.kind === "kill") expect(killed.kills).toBe(1);
					check(killed);
					// past the ask, a restart never sends it again
					if (fault.point === "harness:ask" && fault.kind === "kill") expect(killed.state).toBe("interrupted");
				} catch (error) {
					throw new Error(`${fault.kind} at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 600_000);

	it("sweep, following up on an ended session: it reopens that one, the follow-up sent alone, at most once", async () => {
		const clean = await run([], "continue");
		check(clean);
		expect(clean.state).toBe("done");
		expect(clean.loaded).toBe(1);
		await pool(
			2,
			sweep(clean.commits).map((fault) => async () => {
				const killed = await run([[fault]], "continue");
				try {
					if (fault.kind === "kill") expect(killed.kills).toBe(1);
					check(killed);
					// a follow-up that was sent went to the reopened session
					if (killed.prompts === 1) expect(killed.loaded).toBeGreaterThanOrEqual(1);
				} catch (error) {
					throw new Error(`${fault.kind} at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 600_000);
});
