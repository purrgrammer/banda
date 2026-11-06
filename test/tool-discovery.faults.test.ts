import fc from "fast-check";
import { expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

type State = {
	outcome: { state: { status: string; outcome: { status: string; result: { failed?: string } } } };
	loaded: unknown;
	searches: number;
	calls: number;
	secret: boolean;
	commits: number;
	models: number;
};
async function run(faults: readonly Fault[] = []) {
	const result = await runWorker("test/fault/tool-discovery-worker.ts", [await tempHome()], [faults]);
	return { ...result, state: result.last as State };
}
function invariant(state: State) {
	expect(state.outcome.state.status).toBe("terminal");
	expect(state.outcome.state.outcome.status).toBe("completed");
	if (state.outcome.state.outcome.result.failed) {
		expect(state.outcome.state.outcome.result.failed).toMatch(/^model_error:/);
		expect(state.searches).toBeLessThanOrEqual(1);
		expect(state.calls).toBeLessThanOrEqual(state.searches);
		expect(state.loaded).toEqual(state.searches === 1 ? { add: ["lookup"] } : undefined);
	} else {
		expect(state.loaded).toEqual({ add: ["lookup"] });
		expect(state.searches).toBe(1);
		expect(state.calls).toBe(1);
	}
	expect(state.secret).toBe(false);
}
for (const kind of ["error", "kill"] as const)
	it(`${kind}: discovery recovers at every commit and model boundary`, async () => {
		const clean = await run();
		invariant(clean.state);
		const faults: Fault[] = [];
		for (let hit = 1; hit <= clean.state.commits; hit++)
			for (const point of ["commit:before", "commit:after"] as const) faults.push({ point, hit, kind });
		for (let hit = 1; hit <= clean.state.models; hit++) faults.push({ point: "model", hit, kind });
		await pool(
			2,
			faults.map((fault) => async () => {
				const result = await run([fault]);
				expect(result.kills).toBe(kind === "kill" ? 1 : 0);
				invariant(result.state);
			}),
		);
	}, 300_000);
it("generated faults never expose an unavailable tool or lose a completed load", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.record({
					point: fc.constantFrom("commit:before" as const, "commit:after" as const, "model" as const),
					hit: fc.integer({ min: 1, max: 15 }),
					kind: fc.constant("kill" as const),
				}),
				{ minLength: 1, maxLength: 3 },
			),
			async (faults) => invariant((await run(faults)).state),
		),
		{ numRuns: pbtFaultRuns(6) },
	);
}, 120_000);
