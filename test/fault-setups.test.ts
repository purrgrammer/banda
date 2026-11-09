/**
 * The fault workers' setups, with no fault: what each sets up does what its sweep assumes. A fault suite runs at night
 * and a worker stops describing the product without anything saying so; this is the ordinary suite saying so on every
 * push. It kills nothing and checks only the run with no fault; what holds under kills is `test/*.faults.test.ts`'s.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Faults } from "./fault/faults.ts";
import { runWorker } from "./fault/kill.ts";
import { objectProblems, objectScenario } from "./fault/object-scenario.ts";
import { type FakeMcp, startFakeMcp } from "./fixtures/mcp-server.ts";
import { tempHome } from "./helpers.ts";

const fakes: FakeMcp[] = [];
afterEach(async () => {
	for (const fake of fakes.splice(0)) await fake.close();
});

describe("a fault worker's setup, run with no fault", () => {
	for (const scenario of [
		{ count: 2, failed: true, revoke: true },
		{ count: 2, failed: false, revoke: false },
	])
		it(`the object readings are kept: ${JSON.stringify(scenario)}`, async () => {
			const summary = await objectScenario(await tempHome(), scenario, new Faults());
			expect(objectProblems(summary, scenario)).toEqual([]);
			expect(summary.calls.length).toBeGreaterThan(0);
		});

	for (const mode of ["callback", "code", "rule"] as const)
		it(`a connection's run reads and writes as approved: ${mode}`, async () => {
			const fake = await startFakeMcp(
				mode === "code" ? { auth: "oauth", registeredClient: "banda-app", device: true } : { auth: "oauth" },
			);
			fakes.push(fake);
			const { last } = await runWorker("test/fault/connection-worker.ts", [await tempHome(), fake.url, mode], []);
			expect(last).toMatchObject({ outcome: { status: "completed" }, answers: ["approve"], open: 0, parked: [] });
			expect(fake.calls.filter((call) => call.tool === "create_event")).toHaveLength(1);
		});
});
