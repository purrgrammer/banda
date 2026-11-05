/**
 * Accounts under kills (principle 10): signing in as one account for an agent (its file rewritten to name the
 * connection), another for no agent then switched on, and signing the first out, with one kill at every commit and at
 * each new effect boundary (whom the sign-in is for read, its credentials kept, the account added, the agent's file
 * written, the switch, the sign-out). Whatever was killed and when, the store ends with the second account alone, on
 * for the agent, the agent's file naming the connection in the box as accepted, credentials only for the account the
 * store names, and no token in the store.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { startFakeMcp } from "./fixtures/mcp-server.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	accounts: string[];
	on: string[];
	named: string[];
	box: boolean;
	credentials: string[];
	commits: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const home = await tempHome();
	const fake = await startFakeMcp({ auth: "oauth" });
	try {
		const { last, kills } = await runWorker("test/fault/account-worker.ts", [home, fake.url], schedules);
		return { ...(last as Summary), kills, home, tokens: [...fake.tokens] };
	} finally {
		await fake.close();
	}
};

function storeText(home: string): string {
	return readdirSync(home)
		.filter((name) => name.startsWith("durable.db"))
		.map((name) => join(home, name))
		.filter((path) => statSync(path).isFile())
		.map((path) => readFileSync(path).toString("latin1"))
		.join("\n");
}

function check(summary: Awaited<ReturnType<typeof run>>) {
	expect(summary.accounts).toEqual(["bea"]);
	expect(summary.on).toEqual(["bea"]);
	expect(summary.named).toEqual(["cal"]);
	expect(summary.box).toBe(true);
	expect(summary.credentials).toEqual(["bea"]);
	const text = storeText(summary.home);
	for (const token of summary.tokens) expect(text.includes(token)).toBe(false);
}

describe("accounts under faults", () => {
	it("sweep: one kill at every commit, and at each step of signing in, switching and signing out", async () => {
		const clean = await run([]);
		check(clean);
		const points: [FaultPoint, number][] = [
			["oauth:exchanged", 1],
			["account:read", 1],
			["oauth:kept", 1],
			["account:added", 1],
			["account:file", 1],
			["account:switched", 1],
			["oauth:exchanged", 2],
			["account:read", 2],
			["oauth:kept", 2],
			["account:added", 2],
			["account:switched", 2],
			["account:switched", 3],
			["account:signed-out", 1],
		];
		const faults: Fault[] = points.map(([point, hit]) => ({ point, hit, kind: "kill" }));
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			2,
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
});
