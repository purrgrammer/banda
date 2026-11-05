import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const FIRST = "# Friday\n\n09:10 Porto → Lisbon\n";
const EDITED = "# Friday\n\n09:10 Porto → Lisbon\n19:30 back, the owner's\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Summary = {
	versions: { n: number; by: string; sha: string; box?: string; restored?: number }[];
	blobs: string[];
	box: string;
	beside: string[];
	told: number[];
	parked: unknown[];
	commits: number;
	models: number;
	puts: number;
	writes: number;
	asides: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/artifact-worker.ts", [await tempHome()], schedules);
	return { ...(last as Summary), kills };
};

/**
 * The artifact invariants, whatever was killed and when: the versions are dense and exactly the companion's v1, the
 * owner's edit and the restore of v1, never a second copy of one; every version's blob is on disk with its bytes; each
 * owner's version is written back whole (the box ends holding the restored v1, and nothing beside it) and told to the
 * chat exactly once; and nothing is parked.
 */
function check(summary: Summary) {
	expect(summary.versions).toEqual([
		{ n: 1, by: "companion", sha: sha(FIRST) },
		{ n: 2, by: "owner", sha: sha(EDITED), box: "written" },
		{ n: 3, by: "owner", sha: sha(FIRST), box: "written", restored: 1 },
	]);
	expect(summary.blobs).toEqual(summary.versions.map((version) => version.sha));
	expect(summary.box).toBe(sha(FIRST));
	expect(summary.beside).toEqual([]);
	expect(summary.told).toEqual([2, 3]);
	expect(summary.parked).toEqual([]);
}

const POINTS: FaultPoint[] = [
	"commit:before",
	"commit:after",
	"model",
	"artifact:blob",
	"artifact:write",
	"artifact:aside",
	"artifact:written",
];

describe("artifacts under faults", () => {
	it("sweep: one kill at every commit, model request, blob write and write-back; each version once, whole", async () => {
		const clean = await run([]);
		check(clean);
		const faults: Fault[] = [];
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.models; hit++) faults.push({ point: "model", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.puts; hit++) faults.push({ point: "artifact:blob", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.writes; hit++)
			faults.push({ point: "artifact:write", hit, kind: "kill" }, { point: "artifact:written", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.asides; hit++) faults.push({ point: "artifact:aside", hit, kind: "kill" });
		await pool(
			8,
			faults.map((fault) => async () => {
				const killed = await run([[fault]]);
				try {
					expect(killed.kills).toBe(1);
					check(killed);
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 900_000);

	it("property: under any few kills, the versions, their blobs, the box and the chat agree", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						point: fc.constantFrom(...POINTS),
						hit: fc.integer({ min: 1, max: 30 }),
						kind: fc.constant("kill" as const),
					}),
					{ minLength: 1, maxLength: 3 },
				),
				async (kills) => {
					check(await run(kills.map((kill) => [kill])));
				},
			),
			{ numRuns: pbtFaultRuns(3) },
		);
	}, 600_000);
});
