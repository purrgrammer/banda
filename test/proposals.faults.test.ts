import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

const worker = "test/fault/proposals-worker.ts";
type State = { state: string; rooms: number; room: number; proposals: number; results: number; commits: number };
const run = async (faults: readonly Fault[]) => {
	const { last, kills } = await runWorker(worker, [await tempHome()], [faults]);
	return { state: last as State, kills };
};
const expectAcceptedOnce = ({ state }: Awaited<ReturnType<typeof run>>) => {
	expect(state.state).toBe("accepted");
	expect(state.rooms).toBe(1);
	expect(state.room).toBeGreaterThan(0);
	expect(state.proposals).toBe(1);
	expect(state.results).toBe(1);
};

describe("accepting a group proposal under faults", () => {
	it("control: makes one room and records one accepted result", async () => {
		const clean = await run([]);
		expectAcceptedOnce(clean);
		expect(clean.state.commits).toBeGreaterThan(0);
	});

	for (const kind of ["error", "kill"] as const) {
		it(`${kind}: retries every acceptance commit without a duplicate group or result`, async () => {
			const clean = await run([]);
			const faults: Fault[] = [];
			for (let hit = 1; hit <= clean.state.commits; hit++)
				for (const point of ["commit:before", "commit:after"] as const) faults.push({ point, hit, kind });
			await pool(
				2,
				faults.map((fault) => async () => {
					const result = await run([fault]);
					expect(result.kills).toBe(kind === "kill" ? 1 : 0);
					expectAcceptedOnce(result);
				}),
			);
		}, 300_000);
	}
});
