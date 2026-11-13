import type { Static } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { RECEIPT_POINTS, type ReceiptScenario, ReceiptSummary } from "./fault/receipt-worker.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

type Scenario = Static<typeof ReceiptScenario>;
type Summary = Static<typeof ReceiptSummary>;
const TICKET = "t0000000090";
const baseline: Scenario = { body: "retained request", old: true, answer: "approve" };

const run = async (scenario: Scenario, schedules: readonly (readonly Fault[])[] = []) => {
	const result = await runWorker(
		"test/fault/receipt-worker.ts",
		[await tempHome(), JSON.stringify(scenario)],
		schedules,
	);
	expect(Value.Check(ReceiptSummary, result.last), "The worker must produce a typed recovery summary.").toBe(true);
	if (!Value.Check(ReceiptSummary, result.last)) throw new Error("Invalid receipt recovery summary.");
	return { ...result.last, kills: result.kills };
};

/** A retained ticket has one initial ask; every send is covered by an explicit owner approval, never the fixture grant. */
function check(summary: Summary) {
	expect(summary.acked).toBe(true);
	expect(summary.tickets).toEqual([TICKET]);
	expect(summary.reads).toEqual(["read.example.com"]);
	expect(summary.commands).toBe(0);
	expect(summary.ownerInputs).toBe(0);
	expect(summary.open).toBe(0);
	expect(summary.parked).toEqual([]);
	expect(summary.live).toBe(0);
	expect(summary.released).toEqual([TICKET]);
	expect(summary.permissions).toBe(1);
	expect(summary.activity.filter((what) => what.startsWith("Ran without asking"))).toEqual([]);
	const initial = summary.waits.filter((wait) => wait.ask.interrupted !== true);
	expect(initial).toHaveLength(1);
	for (const wait of summary.waits) {
		expect(wait.ask.args._ticket).toBe(TICKET);
		expect(wait.ask.permission).toBeUndefined();
		expect(wait.ask.host).toBeUndefined();
		expect(wait.permitted).toBeUndefined();
		expect(wait.ask.scopes ?? []).toEqual([]);
		expect(wait.outcome).toBe("answered");
		expect(wait.answer).toBe(summary.scenario.answer);
		expect(wait.by?.gateway).toBe("web");
	}
	expect(initial[0]?.ask.errand).toBeUndefined();
	const approvals = summary.waits.filter((wait) => wait.answer === "approve").length;
	expect(summary.sends.length).toBeLessThanOrEqual(approvals);
	if (summary.scenario.answer === "deny") expect(summary.sends).toEqual([]);
	for (const sent of summary.sends) {
		for (const [key, value] of Object.entries(summary.request)) expect(sent).toHaveProperty(key, value);
		expect(sent.body).toBe(Buffer.from(summary.scenario.body).toString("base64"));
	}
}

describe("retained requests under faults", () => {
	it("recovers without a command and asks once despite an existing route permission", async () => {
		const clean = await run(baseline);
		check(clean);
		expect(clean.sends).toHaveLength(1);
		for (const point of RECEIPT_POINTS) expect(clean.points[point], point).toBeGreaterThan(0);
	}, 60_000);

	it("property: generated receipts and thrown faults converge without another command or unapproved replay", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					body: fc.string({ maxLength: 64 }),
					old: fc.boolean(),
					answer: fc.constantFrom("approve" as const, "deny" as const),
				}),
				fc.array(
					fc.record({
						point: fc.constantFrom(...RECEIPT_POINTS, "commit:before" as const, "commit:after" as const),
						hit: fc.integer({ min: 1, max: 3 }),
						kind: fc.constant("error" as const),
					}),
					{ maxLength: 2 },
				),
				async (scenario, schedule) => {
					const recovered = await run(scenario, [schedule]);
					expect(recovered.kills).toBe(0);
					check(recovered);
				},
			),
			{ numRuns: pbtFaultRuns(8) },
		);
	}, 600_000);

	it("sweeps one SIGKILL at every observed transfer, approval, send, model and commit boundary", async () => {
		const clean = await run(baseline);
		check(clean);
		const faults: Fault[] = [];
		for (const point of RECEIPT_POINTS)
			for (let hit = 1; hit <= (clean.points[point] ?? 0); hit++) faults.push({ point, hit, kind: "kill" });
		for (const point of ["commit:before", "commit:after"] as const)
			for (let hit = 1; hit <= clean.commits; hit++) faults.push({ point, hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const recovered = await run(baseline, [[fault]]);
				expect(recovered.kills, JSON.stringify(fault)).toBe(1);
				check(recovered);
			}),
		);
	}, 1_800_000);
});
