import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AGENT_PUBLICATION_POINTS } from "../src/server/agent-publication.ts";
import type { Fault } from "./fault/faults.ts";
import { runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const worker = "test/fault/agent-publication-worker.ts";
type State = { accepted: string; box: string; commits: number; points: { [point: string]: number } };

describe("owner agent publication effect boundaries", () => {
	it("the clean control leaves exactly the accepted bytes in the workspace", async () => {
		const { last } = await runWorker(worker, [await tempHome()], []);
		const state = last as State;
		expect(state.box).toBe(state.accepted);
		expect(state.commits).toBeGreaterThan(0);
	});

	for (const kind of ["error", "kill"] as const) {
		it(`${kind}: every save commit and file boundary recovers without an orphan owner publication`, async () => {
			const clean = await runWorker(worker, [await tempHome()], []);
			const state = clean.last as State;
			const schedule: Fault[] = [];
			for (const point of AGENT_PUBLICATION_POINTS)
				for (let hit = 1; hit <= (state.points[point] ?? 0); hit++) schedule.push({ point, hit, kind });
			for (let hit = 1; hit <= (clean.last as State).commits; hit++)
				for (const point of ["commit:before", "commit:after"] as const) schedule.push({ point, hit, kind });
			const orphaned: string[] = [];
			for (const fault of schedule) {
				const { last, kills } = await runWorker(worker, [await tempHome()], [[fault]]);
				expect(kills).toBe(kind === "kill" ? 1 : 0);
				const state = last as State;
				if (state.box !== state.accepted) orphaned.push(`${fault.point} #${fault.hit}`);
			}
			expect(orphaned).toEqual([]);
		}, 120_000);
	}

	it("recovers generated interruptions at publication effects and commits", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom("error", "kill"),
				fc.constantFrom(...AGENT_PUBLICATION_POINTS, "commit:before", "commit:after"),
				async (kind, point) => {
					const { last } = await runWorker(worker, [await tempHome()], [[{ kind, point, hit: 1 }]]);
					const state = last as State;
					expect(state.box).toBe(state.accepted);
				},
			),
			{ numRuns: pbtFaultRuns(8) },
		);
	}, 300_000);
});
