import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const effects = [
	"object:attachment:read",
	"object:attachment:received",
	"object:attachment:stored",
	"object:attachment:kept",
] as const;
type Summary = {
	shown: string;
	file?: { sha: string; name: string; size: number };
	bytes?: string;
	hold?: { from: string; connection?: string; account?: string };
	manifest?: string;
	commits: number;
	points: Record<(typeof effects)[number], number>;
};
async function run(faults: readonly Fault[] = []) {
	const result = await runWorker("test/fault/gmail-attachment-worker.ts", [await tempHome()], [faults]);
	const summary = result.last as Summary;
	expect(summary.shown).toBe("card");
	expect(summary.file).toMatchObject({ name: "notes.txt", size: 5 });
	expect(summary.file?.sha).toMatch(/^[0-9a-f]{64}$/);
	expect(summary.bytes).toBe("notes");
	expect(summary.hold).toMatchObject({ from: "connection", connection: "gmail", account: "alice" });
	expect(summary.manifest).toContain(summary.file?.sha);
	return { ...summary, kills: result.kills };
}

describe("Gmail attachment durability", () => {
	it("recovers from generated thrown faults and process kills at each attachment effect", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...effects),
				fc.constantFrom("error" as const, "kill" as const),
				async (point, kind) => {
					const result = await run([{ point, hit: 1, kind }]);
					expect(result.kills).toBe(kind === "kill" ? 1 : 0);
				},
			),
			{ numRuns: pbtFaultRuns(8) },
		);
	}, 120_000);

	it("sweeps SIGKILL across every attachment effect and commit with the same durable invariant", async () => {
		const clean = await run();
		const faults: Fault[] = effects.map((point) => ({ point, hit: 1, kind: "kill" }));
		for (const point of ["commit:before", "commit:after"] as const satisfies readonly FaultPoint[])
			for (let hit = 1; hit <= clean.commits; hit++) faults.push({ point, hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const recovered = await run([fault]);
				expect(recovered.kills, JSON.stringify(fault)).toBe(1);
			}),
		);
	}, 600_000);
});
