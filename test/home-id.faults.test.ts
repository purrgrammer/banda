/**
 * A home's installation id under kills and thrown faults (principle 10): the id every keychain item is named by, made
 * in a fresh home and a wallet's item written under it, with one kill at every boundary of the id's making and at the
 * item's write, and kills and thrown faults generated. Whatever was killed and when: the id's file is missing or whole,
 * an item once written is under the home's id for good, the id made is never replaced by another, and no temporary
 * file a killed process left stays once the id is made again.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { walletAccount } from "../src/wallet/home-id.ts";
import { addressOf } from "../src/wallet/sign.ts";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { KEY } from "./fault/home-id-worker.ts";
import { PAST, pool, runWorker, unlanded } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

type Summary = {
	id: string;
	items: string[];
	temporaries: string[];
	violations: unknown[];
	points: { [point: string]: number };
};

const POINTS: FaultPoint[] = ["home:id:written", "home:id:linked", "keychain:write"];

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const home = await tempHome();
	const { last, kills } = await runWorker("test/fault/home-id-worker.ts", [home], schedules);
	return { ...(last as Summary), kills };
};

function check(summary: Summary) {
	expect(summary.violations).toEqual([]);
	expect(summary.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	expect(summary.items).toEqual([walletAccount(summary.id, addressOf(KEY))]);
	expect(summary.temporaries).toEqual([]);
}

describe("a home's installation id under faults", () => {
	it("sweep: one kill at every boundary of the id's making and at the item's write", async () => {
		const clean = await run([]);
		check(clean);
		for (const point of POINTS) expect(clean.points[point]).toBeGreaterThan(0);
		const faults: Fault[] = [];
		for (const point of POINTS)
			for (let hit = 1; hit <= (clean.points[point] ?? 0) + PAST; hit++) faults.push({ point, hit, kind: "kill" });
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
	}, 600_000);

	it("holds under thrown faults and kills mixed across processes, generated", async () => {
		const fault = fc.record({
			point: fc.constantFrom<FaultPoint>(...POINTS),
			hit: fc.integer({ min: 1, max: 4 }),
			kind: fc.constantFrom("kill" as const, "error" as const),
		});
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.array(fault, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 }),
				async (schedules) => {
					check(await run(schedules));
				},
			),
			{ numRuns: pbtFaultRuns(6) },
		);
	}, 600_000);
});
