/**
 * The indexer under kills and thrown faults (principle 10, H-212, C22): two wallets read 100 blocks a commit, with one
 * kill at every commit and at every range read before its commit, the commit that reads a stored gap into its row among
 * them, and thrown faults there generated. Whatever was killed and when: no row the chain does not show, no cursor
 * ahead of its rows or its gap, and the rows, cursors and gaps end as a run without faults leaves them.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { PAST, pool, runWorker, unlanded } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

type Summary = {
	rows: { [key: string]: unknown };
	expected: { [key: string]: unknown };
	cursors: { [network: string]: number };
	read: { [wallet: string]: number };
	gaps: { [wallet: string]: unknown[] };
	violations: unknown[];
	points: { [point: string]: number };
	commits: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/wallet-indexer-worker.ts", [await tempHome()], schedules);
	return { ...(last as Summary), kills };
};

const RANGE: FaultPoint = "wallet:incoming";

describe("the indexer under faults", () => {
	it("sweep: one kill at every commit and at every range read", async () => {
		const clean = await run([]);
		expect(clean.violations).toEqual([]);
		expect(clean.rows).toEqual(clean.expected);
		expect(clean.points[RANGE]).toBeGreaterThan(1);
		// the spend learned after the first pass reads the stored gap at a commit of its own
		expect(clean.gaps).toEqual({});
		const check = (killed: Summary) => {
			expect(killed.violations).toEqual([]);
			expect(killed.rows).toEqual(clean.rows);
			expect(killed.cursors).toEqual(clean.cursors);
			expect(killed.read).toEqual(clean.read);
			expect(killed.gaps).toEqual(clean.gaps);
		};
		const faults: Fault[] = [];
		for (let hit = 1; hit <= (clean.points[RANGE] ?? 0) + PAST; hit++) faults.push({ point: RANGE, hit, kind: "kill" });
		for (let hit = 1; hit <= clean.commits + PAST; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const killed = await run([[fault]]);
				try {
					const missed = unlanded(fault, { kills: killed.kills, reached: killed.points });
					if (missed !== undefined) throw new Error(missed);
					check(killed);
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 1_800_000);

	it("holds under thrown faults at its range reads and restarts, generated", async () => {
		const clean = await run([]);
		await fc.assert(
			fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 10 }), { maxLength: 4 }), async (hits) => {
				const thrown = await run([hits.map((hit) => ({ point: RANGE, hit, kind: "error" as const }))]);
				expect(thrown.violations).toEqual([]);
				expect(thrown.rows).toEqual(clean.rows);
				expect(thrown.cursors).toEqual(clean.cursors);
				expect(thrown.read).toEqual(clean.read);
				expect(thrown.gaps).toEqual(clean.gaps);
			}),
			{ numRuns: pbtFaultRuns(6) },
		);
	}, 600_000);
});
