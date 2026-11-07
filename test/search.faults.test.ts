import fc from "fast-check";
import { expect, it } from "vitest";
import type { Row } from "../src/core/search.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

async function run(count: number, faults: Fault[] = []) {
	const result = await runWorker(
		"test/fault/search-worker.ts",
		[await tempHome(), String(count)],
		faults.map((fault) => [fault]),
	);
	return { ...(result.last as { rows: Row[]; rebuilt: Row[]; indexes: number }), kills: result.kills };
}
function check(result: Awaited<ReturnType<typeof run>>, count: number) {
	expect(result.rows).toEqual(result.rebuilt);
	expect(result.rows).toHaveLength(count);
	expect(result.rows.every((row) => row.kind === "group")).toBe(true);
}
it("search catch-up survives a kill or thrown fault at every group/artifact commit", async () => {
	const clean = await run(4);
	check(clean, 4);
	await pool(
		2,
		Array.from({ length: clean.indexes }, (_, n) => n + 1).flatMap((hit) =>
			(["kill", "error"] as const).map((kind) => async () => {
				const result = await run(4, [{ point: "index", hit, kind }]);
				check(result, 4);
				expect(result.kills).toBe(kind === "kill" ? 1 : 0);
			}),
		),
	);
});
it("property: interrupted search catch-up equals a rebuild", async () => {
	await fc.assert(
		fc.asyncProperty(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 4 }), async (count, hit) => {
			check(await run(count, [{ point: "index", hit, kind: "kill" }]), count);
		}),
		{ numRuns: pbtFaultRuns(3) },
	);
});
