import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RoutineRecord, WakeData } from "../src/core/routines.ts";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const NEW = "---\ndescription: Tea time\ncron: 0 8 * * 1-5\nruns_a_day: 5\n---\nRemind the owner to drink tea.\n";
/** The edited routine's first due time: Tuesday 3 November 2026, 08:00 (the worker's clock is Monday 09:00). */
const DUE = new Date(2026, 10, 3, 8, 0).getTime();

type Summary = {
	accepted: string;
	box: string;
	brief: { accepted?: string; box: string; record?: RoutineRecord; names: string[] };
	record: RoutineRecord;
	task?: { status: string; until?: number; checkpoint?: { phase: string; due?: number } };
	wakes: WakeData[];
	turns: ({ status: string } | undefined)[];
	sent: string[];
	parked: unknown[];
	commits: number;
	models: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/routine-worker.ts", [await tempHome()], schedules);
	return { ...(last as Summary), kills };
};

/**
 * The invariants of the owner's actions on a routine: the accepted file ends as the edited one, never a third,
 * and once the owner's edit took the box holds exactly what the store accepted, with only the schedule line changed;
 * the routine's task sleeps until the accepted file's next due time, not the old one's; the click run now ran once,
 * whatever was killed and however often it was sent; its run ended and what it said reached the owner; nothing is
 * parked.
 */
function check(summary: Summary) {
	expect(summary.accepted, "the accepted file").toBe(NEW);
	expect(summary.box, "the box's file").toBe(NEW);
	expect(summary.record.edit, "an edit the box does not hold").toBeUndefined();
	expect(summary.task?.status, "its task").toBe("sleeping");
	expect(summary.task?.checkpoint?.due, "its next due time").toBe(DUE);
	expect(
		summary.wakes.filter((wake) => wake.owner === true),
		"the owner's runs",
	).toHaveLength(1);
	expect(summary.wakes.filter((wake) => wake.owner !== true)).toEqual([]);
	expect(summary.record.ranNow).toEqual(["k1"]);
	for (const turn of summary.turns) expect(turn?.status, "a run").toBe("completed");
	expect(summary.turns).toHaveLength(1);
	expect(summary.sent.some((text) => text.includes('asked your routine \\"tea\\" to run now'))).toBe(true);
	expect(summary.parked).toEqual([]);
	// the owner's own routine: made once, in the store and the box alike, the lead's, scheduled, nothing left to write
	expect(summary.brief.names.sort(), "the routines").toEqual(["routines/brief.md", "routines/tea.md"]);
	expect(summary.brief.box, "the box's copy of the owner's routine").toBe(summary.brief.accepted);
	expect(summary.brief.record?.agent).toBe("sancho");
	expect(summary.brief.record?.edit, "a routine the box does not hold").toBeUndefined();
	expect(summary.brief.record?.task, "its task").toBeDefined();
}

const POINTS: FaultPoint[] = [
	"commit:before",
	"commit:after",
	"model",
	"when:before",
	"when:after",
	"send:before",
	"send:after",
];

describe("the owner's routine actions under faults", () => {
	it("sweep: one kill at every commit, box write, model request and send; the edit lands whole, run now runs once", async () => {
		const clean = await run([]);
		expect(clean.kills).toBe(0);
		check(clean);
		const faults: Fault[] = [
			{ point: "when:before", hit: 1, kind: "kill" },
			{ point: "when:after", hit: 1, kind: "kill" },
			{ point: "send:before", hit: 1, kind: "kill" },
			{ point: "send:after", hit: 1, kind: "kill" },
		];
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.models; hit++) faults.push({ point: "model", hit, kind: "kill" });
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

	it("property: under any few kills, the edit lands whole and run now runs once", async () => {
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
					check(await run(kills.map((kill) => [kill])));
				},
			),
			{ numRuns: pbtFaultRuns(3) },
		);
	}, 600_000);
});
