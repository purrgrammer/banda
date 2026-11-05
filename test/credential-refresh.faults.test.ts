import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { credentialsOf } from "../src/core/connections.ts";
import { type CredentialScenario, type CredentialSummary, credentialProblems } from "./fault/credential-invariants.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { startGithubObjects } from "./fixtures/github-objects.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const points = ["credential:refresh", "credential:refreshed", "credential:replace", "credential:replaced"] as const;
async function run(scenario: CredentialScenario, fault?: Fault) {
	const fake = await startGithubObjects();
	fake.user = "alice";
	const home = await tempHome();
	try {
		const result = await runWorker(
			"test/fault/credential-worker.ts",
			[home, fake.url, JSON.stringify(scenario)],
			fault === undefined ? [] : [[fault]],
		);
		const summary = result.last as CredentialSummary;
		expect(credentialProblems(summary, scenario)).toEqual([]);
		expect(fake.calls.every((call) => call.tool === "issue_read")).toBe(true);
		const credential = await credentialsOf(home, "github", "alice");
		if (credential !== undefined && "oauth" in credential)
			expect(fake.tokens.has(credential.oauth.tokens.access)).toBe(true);
		return { ...summary, kills: result.kills };
	} finally {
		await fake.close();
	}
}
describe("credential refresh under faults (real OAuth/MCP)", () => {
	it("generated proactive/401 refreshes, errors, kills and subsequent signout preserve credential authority", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({ mode: fc.constantFrom("proactive" as const, "401" as const), revoke: fc.boolean() }),
				fc.constantFrom(...points),
				fc.constantFrom("error" as const, "kill" as const),
				async (scenario, point, kind) => {
					await run(scenario, { point, hit: 1, kind });
				},
			),
			{ numRuns: pbtFaultRuns(12) },
		);
	}, 180_000);
	it("sweep: one kill at every credential effect and store commit", async () => {
		const scenario = { mode: "proactive" as const, revoke: true };
		const clean = await run(scenario);
		const faults: Fault[] = [];
		for (const point of points)
			for (let hit = 1; hit <= (clean.points[point] ?? 0); hit++) faults.push({ point, hit, kind: "kill" });
		for (const point of ["commit:before", "commit:after"] as const)
			for (let hit = 1; hit <= clean.commits; hit++) faults.push({ point, hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const result = await run(scenario, fault);
				expect(result.kills, JSON.stringify(fault)).toBe(1);
			}),
		);
	}, 600_000);
	it("thrown storage faults on either side recover with an explicit owner sign-in when rotation was lost", async () => {
		for (const point of ["commit:before", "commit:after"] as const)
			await run({ mode: "401", revoke: false }, { point, hit: 1, kind: "error" });
	}, 120_000);
});
