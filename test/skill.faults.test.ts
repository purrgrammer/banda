import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

type State = { loads: number; owner: number; order: string[]; context: string[]; commits: number; writes: number };
const worker = "test/fault/skill-worker.ts";
async function run(text: string, faults: readonly Fault[] = []) {
	const { last, kills } = await runWorker(worker, [await tempHome(), text], [faults]);
	return { state: last as State, kills };
}
function invariant(state: State, loaded = true) {
	expect(state.loads).toBe(loaded ? 1 : 0);
	expect(state.owner).toBe(1);
	if (loaded) {
		expect(state.order.indexOf("banda.skill-load")).toBeLessThan(state.order.indexOf("banda.inbound"));
		expect(state.context.slice(1, 4)).toEqual(["assistant", "toolResult", "user"]);
	} else expect(state.context.slice(1, 2)).toEqual(["user"]);
}

describe("skill admission fault boundaries", () => {
	it("generated quoted, unknown, escaped and explicit invocations never load unaccepted text", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(
					"Use /research",
					"Try (/research).",
					"Use /unknown",
					"Use `/research`",
					"Use '/research'",
					"Use \\/research",
				),
				async (text) => invariant((await run(text)).state, text === "Use /research" || text === "Try (/research)."),
			),
			{ numRuns: pbtFaultRuns(6) },
		);
	}, 60_000);
	for (const kind of ["error", "kill"] as const)
		it(`${kind}: every skill write and store commit cut resumes with one complete load`, async () => {
			const clean = await run("Use /research");
			invariant(clean.state);
			const faults: Fault[] = [
				{ point: "skill:write:before", hit: 1, kind },
				{ point: "skill:write:after", hit: 1, kind },
			];
			for (let hit = 1; hit <= clean.state.commits; hit++)
				for (const point of ["commit:before", "commit:after"] as const) faults.push({ point, hit, kind });
			await pool(
				2,
				faults.map((fault) => async () => {
					const result = await run("Use /research", [fault]);
					expect(result.kills).toBe(kind === "kill" ? 1 : 0);
					invariant(result.state);
				}),
			);
		}, 300_000);
});
