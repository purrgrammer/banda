/** Known blocker: startup has no durable owner-publication intent to finish a write cut before acceptance. */
import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

const worker = "test/fault/agent-publication-worker.ts";
type State = { accepted: string; box: string; commits: number };

describe("owner agent publication effect boundaries", () => {
	it("the clean control leaves exactly the accepted bytes in the workspace", async () => {
		const { last } = await runWorker(worker, [await tempHome()], []);
		const state = last as State;
		expect(state.box).toBe(state.accepted);
		expect(state.commits).toBe(1);
	});

	for (const kind of ["error", "kill"] as const) {
		it.fails(`${kind}: every save commit and box-write boundary recovers without an orphan owner publication`, async () => {
			const schedule: Fault[] = [
				{ point: "agent:write:before", hit: 1, kind },
				{ point: "agent:write:after", hit: 1, kind },
			];
			for (const hit of [1])
				for (const point of ["commit:before", "commit:after"] as const) schedule.push({ point, hit, kind });
			const orphaned: string[] = [];
			for (const fault of schedule) {
				const { last, kills } = await runWorker(worker, [await tempHome()], [[fault]]);
				expect(kills).toBe(kind === "kill" ? 1 : 0);
				const state = last as State;
				if (state.box !== state.accepted) orphaned.push(`${fault.point} #${fault.hit}`);
			}
			// A store-first outbox may complete the owner's edit; a box-first protocol must recover it or
			// retain it as an identified owner intent, never mislabel it as a new box proposal.
			expect(orphaned).toEqual([]);
		}, 120_000);
	}
});
