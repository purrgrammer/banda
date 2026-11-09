/**
 * The fault workers' setups, with no fault: what each sets up does what its sweep assumes. A fault suite runs at night
 * and a worker stops describing the product without anything saying so; this is the ordinary suite saying so on every
 * push. It kills nothing and checks only the run with no fault; what holds under kills is `test/*.faults.test.ts`'s.
 */
import { describe, expect, it } from "vitest";
import { Faults } from "./fault/faults.ts";
import { objectProblems, objectScenario } from "./fault/object-scenario.ts";
import { tempHome } from "./helpers.ts";

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
});
