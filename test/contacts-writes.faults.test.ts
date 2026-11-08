/**
 * Contacts changes under kills (principle 10): Google Contacts added as shipped, its changes allowed and signed in to,
 * then one approved change, with one kill at every commit and at each effect boundary of the change (the call before
 * it goes, and once Google answered, before banda recorded it), the owner's answer and each model request. The
 * boundaries are the daemon's own connection:call and connection:answered, which every connection's call passes.
 *
 * An update or a deletion is idempotent: whatever was killed and when, the person ends changed (or gone) as approved,
 * the owner was asked once and never again, and the Turn ends with nothing parked or open. An addition is not: a run a
 * kill cut short is not repeated by banda, the owner is asked again and skips it, and there is never a second person.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const effects = ["connection:call", "connection:answered", "answer", "model"] as const;
type Mode = "update" | "delete" | "create";
type Summary = {
	outcome: { status: string };
	parked: unknown[];
	answers: string[];
	open: number;
	people: { resourceName: string; names?: unknown[]; organizations?: { title?: string }[] }[];
	commits: number;
	points: Record<(typeof effects)[number], number>;
};

async function run(mode: Mode, schedules: readonly (readonly Fault[])[] = []) {
	const { last, kills } = await runWorker("test/fault/contacts-write-worker.ts", [await tempHome(), mode], schedules);
	const summary = last as Summary;
	expect(summary.outcome.status).toBe("completed");
	expect(summary.parked).toEqual([]);
	expect(summary.open).toBe(0);
	const added = summary.people.filter((person) => person.resourceName !== "people/c111");
	if (mode === "create") expect(added.length).toBeLessThanOrEqual(1);
	// an idempotent change is never asked again
	else expect(summary.answers.filter((answer) => answer === "asked-again")).toEqual([]);
	return { ...summary, added, kills };
}

describe.each(["update", "delete", "create"] as const)("Contacts %s under faults", (mode) => {
	const done = (result: Awaited<ReturnType<typeof run>>) => {
		if (mode === "delete") expect(result.people).toEqual([]);
		if (mode === "update")
			expect(result.people).toMatchObject([
				{ resourceName: "people/c111", organizations: [{ title: "Head of Design" }] },
			]);
	};

	it("recovers from generated thrown faults and kills at the change's boundaries", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(
					fc.constantFrom(...effects).map((point) => [point, "kill"] as const),
					// the owner's answer is the worker's own step: thrown there, it fails the worker, not banda
					fc.constantFrom("connection:call", "connection:answered", "model").map((point) => [point, "error"] as const),
				),
				async ([point, kind]) => {
					const result = await run(mode, [[{ point, hit: 1, kind }]]);
					expect(result.kills).toBe(kind === "kill" ? 1 : 0);
					// a kill never loses an approved idempotent change
					if (kind === "kill" && mode !== "create") done(result);
				},
			),
			{ numRuns: pbtFaultRuns(4) },
		);
	}, 300_000);

	it("sweeps one SIGKILL across every commit and every boundary", async () => {
		const clean = await run(mode);
		done(clean);
		if (mode === "create") expect(clean.added).toHaveLength(1);
		expect(clean.answers).toEqual(["approve"]);
		const faults: Fault[] = [];
		for (const point of effects)
			for (let hit = 1; hit <= clean.points[point]; hit++) faults.push({ point, hit, kind: "kill" });
		for (const point of ["commit:before", "commit:after"] as const satisfies readonly FaultPoint[])
			for (let hit = 1; hit <= clean.commits; hit++) faults.push({ point, hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const recovered = await run(mode, [[fault]]);
				expect(recovered.kills, JSON.stringify(fault)).toBe(1);
				if (mode !== "create") done(recovered);
			}),
		);
	}, 1_800_000);
});
