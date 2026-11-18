import fc from "fast-check";
import type { Static } from "typebox";
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
const baseline: Scenario = { body: "retained request", old: true, routine: false, archive: "never", answer: "approve" };

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
	const archived = summary.scenario.archive !== "never";
	expect(summary.archived).toBe(archived);
	expect(summary.released).toEqual(archived ? [] : [TICKET]);
	expect(summary.permissions).toBe(archived ? 0 : 1);
	if (archived) {
		expect(summary.modelRequests).toBe(0);
		expect(summary.sends.length).toBeLessThanOrEqual(summary.scenario.archive === "sent" ? 1 : 0);
	}
	expect(summary.activity.filter((what) => what.startsWith("Ran without asking"))).toEqual([]);
	const initial = summary.waits.filter((wait) => wait.ask.interrupted !== true);
	expect(initial).toHaveLength(1);
	for (const wait of summary.waits) {
		expect(wait.ask.args._ticket).toBe(TICKET);
		expect(wait.ask.permission).toBeUndefined();
		expect(wait.ask.host).toBeUndefined();
		expect(wait.permitted).toBeUndefined();
		expect(wait.ask.scopes ?? []).toEqual([]);
		if (archived) expect(["answered", "cancelled"]).toContain(wait.outcome);
		else expect(wait.outcome).toBe("answered");
		if (summary.scenario.archive !== "waiting") {
			expect(wait.answer).toBe(summary.scenario.answer);
			expect(wait.by?.gateway).toBe("web");
		}
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
	it.each([false, true])(
		"recovers without a command and asks once despite an existing route permission (routine: %s)",
		async (routine) => {
			const clean = await run({ ...baseline, routine });
			check(clean);
			expect(clean.sends).toHaveLength(1);
			for (const point of RECEIPT_POINTS) {
				if (point === (routine ? "release:told" : "release:submitted")) continue;
				expect(clean.points[point], point).toBeGreaterThan(0);
			}
		},
		60_000,
	);

	it("property: generated receipts and thrown faults converge without another command or unapproved replay", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc
					.record({
						body: fc.string({ maxLength: 64 }),
						old: fc.boolean(),
						routine: fc.boolean(),
						archive: fc.constantFrom("never" as const, "waiting" as const, "sent" as const),
						answer: fc.constantFrom("approve" as const, "deny" as const),
					})
					.map((scenario) =>
						scenario.archive === "never" ? scenario : { ...scenario, routine: true, answer: "approve" as const },
					),
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

	it.each([false, true])(
		"sweeps one SIGKILL at every observed transfer, approval, send, model and commit boundary (routine: %s)",
		async (routine) => {
			const scenario = { ...baseline, routine };
			const clean = await run(scenario);
			check(clean);
			const faults: Fault[] = [];
			for (const point of RECEIPT_POINTS)
				for (let hit = 1; hit <= (clean.points[point] ?? 0); hit++) faults.push({ point, hit, kind: "kill" });
			for (const point of ["commit:before", "commit:after"] as const)
				for (let hit = 1; hit <= clean.commits; hit++) faults.push({ point, hit, kind: "kill" });
			await pool(
				2,
				faults.map((fault) => async () => {
					const recovered = await run(scenario, [[fault]]);
					expect(recovered.kills, JSON.stringify(fault)).toBe(1);
					check(recovered);
				}),
			);
		},
		1_800_000,
	);

	it.each(["waiting", "sent"] as const)(
		"an archived completed routine stays cancelled across thrown faults and every observed kill boundary (%s)",
		async (archive) => {
			const scenario = { ...baseline, routine: true, archive };
			const clean = await run(scenario);
			check(clean);
			expect(clean.sends).toHaveLength(archive === "sent" ? 1 : 0);
			const boundaries = [...RECEIPT_POINTS, "commit:before", "commit:after"] as const;
			const faults: Fault[] = [];
			for (const point of boundaries)
				for (let hit = 1; hit <= (point.startsWith("commit:") ? clean.commits : (clean.points[point] ?? 0)); hit++)
					for (const kind of ["error", "kill"] as const) faults.push({ point, hit, kind });
			await pool(
				2,
				faults.map((fault) => async () => {
					const recovered = await run(scenario, [[fault]]);
					expect(recovered.kills, JSON.stringify(fault)).toBe(fault.kind === "kill" ? 1 : 0);
					check(recovered);
				}),
			);
		},
		1_800_000,
	);
});
