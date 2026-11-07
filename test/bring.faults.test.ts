import { describe, expect, it } from "vitest";
import { shaOf } from "../src/core/agents.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

type State = {
	accepted: { name: string; sha: string }[];
	agent?: string;
	box: { review?: string; plan?: string; checklist?: string; agent?: string };
	expected: { review: string; plan: string };
	chosen: { bring: boolean; skills: boolean };
	commits: number;
};
const worker = "test/fault/bring-worker.ts";

async function run(faults: readonly Fault[] = []) {
	const { last, kills } = await runWorker(worker, [await tempHome()], [faults]);
	return { state: last as State, kills };
}

/** Whatever was cut, banda ends with exactly what was picked: each accepted as the box holds it, and the step done. */
function invariant(state: State) {
	expect(state.accepted).toEqual([
		{ name: "plan", sha: state.expected.plan },
		{ name: "review", sha: state.expected.review },
	]);
	expect(shaOf(state.box.review ?? "")).toBe(state.expected.review);
	expect(shaOf(state.box.plan ?? "")).toBe(state.expected.plan);
	expect(state.box.checklist).toBe("- bugs\n");
	expect(state.agent).toBeDefined();
	expect(shaOf(state.box.agent ?? "")).toBe(state.agent);
	expect(state.chosen).toEqual({ bring: true, skills: true });
}

describe("bringing from the other harnesses, cut at its boundaries", () => {
	for (const kind of ["kill", "error"] as const)
		it(`${kind}: at each write, accept, agent save and store commit, bringing again ends with exactly the picks`, async () => {
			const clean = await run();
			invariant(clean.state);
			const faults: Fault[] = (["bring:written", "bring:accepted", "bring:agent"] as const).map((point) => ({
				point,
				hit: 1,
				kind,
			}));
			for (let hit = 1; hit <= clean.state.commits; hit++)
				for (const point of ["commit:before", "commit:after"] as const) faults.push({ point, hit, kind });
			await pool(
				2,
				faults.map((fault) => async () => {
					const result = await run([fault]);
					try {
						expect(result.kills).toBe(kind === "kill" ? 1 : 0);
						invariant(result.state);
					} catch (error) {
						throw new Error(`${kind} at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
					}
				}),
			);
		}, 600_000);
});
