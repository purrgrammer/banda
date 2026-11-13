import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { SIGNIN_POINTS, type SigninScenario, SigninSummary, signinProblems } from "./fault/signin-invariants.ts";
import { startFakeMcp } from "./fixtures/mcp-server.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

async function run(scenario: SigninScenario, fault?: Fault) {
	const home = await tempHome();
	const fake = await startFakeMcp({ auth: "oauth" });
	fake.user = "ana";
	try {
		const result = await runWorker(
			"test/fault/signin-worker.ts",
			[home, fake.url, JSON.stringify(scenario)],
			fault === undefined ? [] : [[fault]],
		);
		if (!Value.Check(SigninSummary, result.last)) throw new Error("invalid sign-in worker summary");
		expect(signinProblems(result.last)).toEqual([]);
		expect(
			fake.calls.filter((call) => call.tool === "create_event" && JSON.stringify(call.args).includes("Old tea")),
		).toEqual([]);
		const writes = fake.calls.filter((call) => call.tool === "create_event");
		expect(writes.filter((call) => JSON.stringify(call.args).includes("Fresh tea")).length).toBeLessThanOrEqual(1);
		expect(writes.filter((call) => JSON.stringify(call.args).includes("Fresh proof"))).toEqual([
			{ tool: "create_event", args: { title: "Fresh proof", day: "mon" } },
		]);
		for (const write of writes)
			expect(write.args).toEqual({ title: expect.stringMatching(/^Fresh (tea|proof)$/), day: "mon" });
		const store = (
			await Promise.all(
				(await readdir(home)).filter((name) => name.startsWith("durable.db")).map((name) => readFile(join(home, name))),
			)
		)
			.map((bytes) => bytes.toString("latin1"))
			.join("\n");
		for (const token of fake.tokens) expect(store.includes(token)).toBe(false);
		return { ...result.last, kills: result.kills };
	} finally {
		await fake.close();
	}
}

describe("replacement sign-in authority under faults", () => {
	it("generated throws and kills never let a replacement authorize the old draft", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({ grant: fc.boolean() }),
				fc.constantFrom(...SIGNIN_POINTS, "commit:before" as const, "commit:after" as const),
				fc.constantFrom("error" as const, "kill" as const),
				async (scenario, point, kind) => {
					const result = await run(scenario, { point, hit: 1, kind });
					if (kind === "kill") expect(result.kills).toBe(1);
					else expect(result.points[point], point).toBeGreaterThan(0);
				},
			),
			{ numRuns: pbtFaultRuns(12) },
		);
	}, 180_000);

	it("sweeps one kill at every replacement, approval, call and commit boundary", async () => {
		const scenario = { grant: true };
		const clean = await run(scenario);
		const faults: Fault[] = [];
		for (const point of SIGNIN_POINTS) {
			expect(clean.points[point], point).toBeGreaterThan(0);
			for (let hit = 1; hit <= (clean.points[point] ?? 0); hit++) faults.push({ point, hit, kind: "kill" });
		}
		expect(clean.commits).toBeGreaterThan(0);
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

	it("refuses old work after a thrown credential publication before the account commit", async () => {
		const result = await run({ grant: false }, { point: "oauth:kept", hit: 1, kind: "error" });
		expect(result.sawUncommittedCredentials).toBe(true);
	});
});
