/**
 * Calendar changes under kills (principle 10): Google Calendar added as shipped, its changes allowed and signed in
 * to, then one approved create_event, with one kill at every commit and at each effect boundary of the change (the
 * call before it goes, and once Google answered, before banda recorded it), the owner's answer and each model
 * request. Whatever was killed and when, exactly one event exists on the fake Google, the owner was asked once and
 * never again, and the Turn ends with nothing parked or open. Thrown faults at the same boundaries never make a second
 * event either.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const effects = ["connection:call", "connection:answered", "answer", "model"] as const;
type Summary = {
	outcome: { status: string };
	parked: unknown[];
	answers: string[];
	open: number;
	events: { id: string; summary: string; status: string }[];
	commits: number;
	points: Record<(typeof effects)[number], number>;
};

async function run(schedules: readonly (readonly Fault[])[] = []) {
	const { last, kills } = await runWorker("test/fault/calendar-write-worker.ts", [await tempHome()], schedules);
	const summary = last as Summary;
	expect(summary.outcome.status).toBe("completed");
	expect(summary.parked).toEqual([]);
	expect(summary.open).toBe(0);
	// never asked again: the change is the same when run again with its key
	expect(summary.answers.filter((answer) => answer === "asked-again")).toEqual([]);
	expect(summary.events.length).toBeLessThanOrEqual(1);
	for (const event of summary.events) {
		expect(event).toMatchObject({ summary: "Tea", status: "confirmed" });
		expect(event.id).toMatch(/^banda[a-v0-9]+$/);
	}
	return { ...summary, kills };
}

describe("Calendar changes under faults", () => {
	it("recovers from generated thrown faults and kills at the change's boundaries without a second event", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(
					fc.constantFrom(...effects).map((point) => [point, "kill"] as const),
					// the owner's answer is the worker's own step: thrown there, it fails the worker, not banda
					fc.constantFrom("connection:call", "connection:answered", "model").map((point) => [point, "error"] as const),
				),
				async ([point, kind]) => {
					const result = await run([[{ point, hit: 1, kind }]]);
					expect(result.kills).toBe(kind === "kill" ? 1 : 0);
					// a kill never loses the approved change; a thrown fault before the request may stop it
					if (kind === "kill") expect(result.events).toHaveLength(1);
				},
			),
			{ numRuns: pbtFaultRuns(8) },
		);
	}, 300_000);

	it("sweeps one SIGKILL across every commit and every boundary: exactly one event, asked once", async () => {
		const clean = await run();
		expect(clean.events).toHaveLength(1);
		expect(clean.answers).toEqual(["approve"]);
		const faults: Fault[] = [];
		for (const point of effects)
			for (let hit = 1; hit <= clean.points[point]; hit++) faults.push({ point, hit, kind: "kill" });
		for (const point of ["commit:before", "commit:after"] as const satisfies readonly FaultPoint[])
			for (let hit = 1; hit <= clean.commits; hit++) faults.push({ point, hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const recovered = await run([[fault]]);
				expect(recovered.kills, JSON.stringify(fault)).toBe(1);
				expect(recovered.events, JSON.stringify(fault)).toHaveLength(1);
			}),
		);
	}, 1_800_000);
});
