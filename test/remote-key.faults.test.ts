import fc from "fast-check";
import { expect, it } from "vitest";
import type { KeyPoint } from "../src/server/remote.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const points: KeyPoint[] = ["key:written", "key:synced", "key:renamed", "key:directory"];
const check = (value: unknown) => {
	const result = value as { ids: string[]; bytes: number; unchanged: boolean };
	expect(result.bytes).toBe(32);
	expect(result.unchanged).toBe(true);
	expect(new Set(result.ids).size).toBe(1);
};
const run = async (schedules: Fault[][]) => {
	const home = await tempHome();
	const result = await runWorker("test/fault/remote-key-worker.ts", [home], schedules);
	check(result.last);
	// Once advertised, the same identity survives every later start too.
	check((await runWorker("test/fault/remote-key-worker.ts", [home], [])).last);
	return result;
};

it("sweeps a kill at every key publication boundary without losing an advertised identity", async () => {
	await pool(
		2,
		points.map((point) => async () => expect((await run([[{ point, hit: 1, kind: "kill" }]])).kills).toBe(1)),
	);
});

it("keeps the identity across generated thrown faults and restarts", async () => {
	await fc.assert(
		fc.asyncProperty(fc.array(fc.constantFrom(...points), { maxLength: 5 }), async (cuts) => {
			await run(cuts.map((point) => [{ point, hit: 1, kind: "error" }]));
		}),
		{ numRuns: pbtFaultRuns(15) },
	);
}, 120_000);
