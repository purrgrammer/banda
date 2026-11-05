import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

const worker = "test/fault/meta-message-worker.ts";
type State = { deliveries: number; commits: number };
const run = async (faults: readonly Fault[]) => {
	const { last, kills } = await runWorker(worker, [await tempHome()], [faults]);
	return { state: last as State, kills };
};
const expectOneDelivery = ({ state }: Awaited<ReturnType<typeof run>>) => {
	expect(state.deliveries).toBe(1);
};

describe("agent-to-agent message delivery under faults", () => {
	it("control: delivers once and completes the recipient's turn", async () => {
		const clean = await run([]);
		expectOneDelivery(clean);
		expect(clean.state.commits).toBeGreaterThan(0);
	});

	for (const kind of ["error", "kill"] as const) {
		it(`${kind}: retrying the owner input at every delivery commit leaves one attributed message`, async () => {
			const clean = await run([]);
			const faults: Fault[] = [];
			for (let hit = 1; hit <= clean.state.commits; hit++)
				for (const point of ["commit:before", "commit:after"] as const) faults.push({ point, hit, kind });
			await pool(
				2,
				faults.map((fault) => async () => {
					const result = await run([fault]);
					expect(result.kills).toBe(kind === "kill" ? 1 : 0);
					expectOneDelivery(result);
				}),
			);
		}, 300_000);
	}
});
