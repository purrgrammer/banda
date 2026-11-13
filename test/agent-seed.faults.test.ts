import { Type } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { AGENT_PUBLICATION_POINTS } from "../src/server/agent-publication.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const State = Type.Object({
	restored: Type.Array(Type.Object({ path: Type.String(), expected: Type.String(), actual: Type.String() })),
	seeded: Type.Boolean(),
	changes: Type.Integer(),
	commits: Type.Integer(),
	points: Type.Record(Type.String(), Type.Integer()),
});
async function run(count: number, faults: readonly Fault[] = []) {
	const result = await runWorker("test/fault/agent-seed-worker.ts", [await tempHome(), String(count)], [faults]);
	if (!Value.Check(State, result.last)) throw new Error("invalid seed worker result");
	expect(result.last.seeded).toBe(true);
	expect(result.last.changes).toBe(0);
	expect(result.last.restored).toHaveLength(count + 1);
	for (const file of result.last.restored) expect(file.actual, file.path).toBe(file.expected);
	expect(result.kills).toBe(faults.some((fault) => fault.kind === "kill") ? 1 : 0);
	return result.last;
}

it("restores every accepted file after a kill or thrown fault at every restoration boundary", async () => {
	const clean = await run(2);
	const cases: Fault[] = [];
	for (const kind of ["kill", "error"] as const) {
		for (let hit = 1; hit <= clean.commits; hit++)
			for (const point of ["commit:before", "commit:after"] as const) cases.push({ kind, point, hit });
		for (const point of AGENT_PUBLICATION_POINTS)
			for (let hit = 1; hit <= (clean.points[point] ?? 0); hit++) cases.push({ kind, point, hit });
	}
	await pool(
		2,
		cases.map((fault) => () => run(2, [fault])),
	);
}, 600_000);

it("restores generated bands after an interrupted file publication", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.integer({ min: 1, max: 4 }),
			fc.constantFrom("kill", "error"),
			fc.constantFrom(...AGENT_PUBLICATION_POINTS),
			fc.integer({ min: 1, max: 5 }),
			async (count, kind, point, hit) => {
				await run(count, [{ kind, point, hit: 1 + ((hit - 1) % (count + 1)) }]);
			},
		),
		{ numRuns: pbtFaultRuns(8) },
	);
}, 600_000);
