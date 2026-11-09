/**
 * Drive changes under kills (principle 10): Google Drive added as shipped, signed in to with its changes, then one
 * approved change (a Doc created, cells of a Sheet written, or rows added to a tab), with one kill at every commit
 * and at each effect boundary of the change (the call before it goes, and once Google answered, before banda recorded
 * it), the owner's answer and each model request. A created Doc and written cells are idempotent: whatever was killed
 * and when, exactly one file exists, the cells hold what was approved, the owner was asked once and never again, and
 * the Turn ends with nothing parked or open. Appending rows is not: a run a kill cut short is not repeated by banda,
 * the owner is asked again and skips it, and the rows are never there twice. Thrown faults at the same boundaries
 * never make a second file or a second row either.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const effects = ["connection:call", "connection:answered", "answer", "model"] as const;
type Mode = "create" | "update" | "append" | "doc" | "reply";
type Summary = {
	outcome: { status: string };
	parked: unknown[];
	answers: string[];
	open: number;
	files: { id: string; name: string; text: string; trashed: boolean }[];
	sheet?: { [tab: string]: string[][] };
	doc?: string;
	comment?: { resolved: boolean; replies: { content: string }[] };
	commits: number;
	points: Record<(typeof effects)[number], number>;
};

async function run(mode: Mode, schedules: readonly (readonly Fault[])[] = []) {
	const { last, kills } = await runWorker("test/fault/drive-write-worker.ts", [await tempHome(), mode], schedules);
	const summary = last as Summary;
	expect(summary.outcome.status).toBe("completed");
	expect(summary.parked).toEqual([]);
	expect(summary.open).toBe(0);
	if (mode === "create") {
		expect(summary.files.length).toBeLessThanOrEqual(1);
		for (const file of summary.files)
			expect(file).toMatchObject({ name: "Q1 plan", text: "# Plan\n\n- one", trashed: false });
	} else expect(summary.files.map((file) => file.id)).toEqual(["s1", "d1"]);
	// never asked again: an idempotent change is the same when run again with its key
	if (mode !== "append") expect(summary.answers.filter((answer) => answer === "asked-again")).toEqual([]);
	// the budget tab is as it was, but for the one cell written
	if (mode === "append")
		expect(summary.sheet?.["🏠"]).toEqual([
			["ingresos", "", "gastos"],
			["6385", "", "30"],
		]);
	if (mode === "update") expect(summary.sheet?.["2027"]).toEqual([]);
	expect((summary.sheet?.["2027"] ?? []).length).toBeLessThanOrEqual(1);
	// the text is there at most once, the reply too
	expect((summary.doc ?? "").split("Decisions").length).toBeLessThanOrEqual(2);
	expect((summary.comment?.replies ?? []).length).toBeLessThanOrEqual(1);
	return { ...summary, kills };
}

describe.each(["create", "update", "append", "doc", "reply"] as const)("Drive %s under faults", (mode) => {
	/** What a finished, unfaulted or idempotent change leaves. */
	const done = (result: Awaited<ReturnType<typeof run>>) => {
		if (mode === "create") expect(result.files).toHaveLength(1);
		if (mode === "update")
			expect(result.sheet?.["🏠"]).toEqual([
				["ingresos", "", "gastos"],
				["6385", "", "95"],
			]);
		if (mode === "append") expect(result.sheet?.["2027"]).toEqual([["a", "b"]]);
		if (mode === "doc") expect(result.doc).toBe("# Q1 plan\nPlatform moves first\nDecisions\nPayments next");
		if (mode === "reply")
			expect(result.comment).toMatchObject({ resolved: true, replies: [{ content: "Added them." }] });
	};

	it("recovers from generated thrown faults and kills at the change's boundaries without a second file", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(
					fc.constantFrom(...effects).map((point) => [point, "kill"] as const),
					// the owner's answer is the worker's own step: thrown there, it fails the worker, not banda
					fc.constantFrom("connection:call", "connection:answered", "model").map((point) => [point, "error"] as const),
				),
				async ([point, kind]) => {
					const result = await run(mode, [[{ point, hit: 1, kind }]]);
					expect(result.kills).toBe(kind === "kill" ? 1 : 0);
					// a kill never loses an approved idempotent change; a thrown fault before the request may stop it
					if (kind === "kill" && mode !== "append") done(result);
				},
			),
			{ numRuns: pbtFaultRuns(mode === "create" ? 8 : 4) },
		);
	}, 300_000);

	it("sweeps one SIGKILL across every commit and every boundary: the change once, asked once", async () => {
		const clean = await run(mode);
		done(clean);
		expect(clean.answers).toEqual(["approve"]);
		const faults: Fault[] = [];
		for (const point of effects)
			for (let hit = 1; hit <= clean.points[point]; hit++) faults.push({ point, hit, kind: "kill" });
		for (const point of ["commit:before", "commit:after"] as const satisfies readonly FaultPoint[])
			for (let hit = 1; hit <= clean.commits; hit++) faults.push({ point, hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const recovered = await run(mode, [[fault]]);
				expect(recovered.kills, JSON.stringify(fault)).toBe(1);
				if (mode !== "append") done(recovered);
			}),
		);
	}, 1_800_000);
});
