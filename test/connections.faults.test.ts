/**
 * Connections under kills (principle 10): a connection proposed, allowed, signed in to with OAuth, then read and
 * written, with one kill at every commit and at each new effect boundary (the accept, the callback's steps, the
 * listing, each call to the server, before and after it answered). Whatever was killed and when, the connection ends
 * allowed and connected, the Turn ends with nothing parked or open, the write reaches the server at most once and only
 * as approved, and no credential is in the store. The same again signing in by code, as a file's named client, with a
 * kill once the code was given, once the owner's tokens came, and once they were kept.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { type FakeMcp, startFakeMcp } from "./fixtures/mcp-server.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	outcome: { status: string; result?: unknown };
	parked: unknown[];
	accepted: boolean;
	connected: boolean;
	followed: boolean;
	answers: string[];
	open: number;
	commits: number;
};

/** One scenario, against a fake server of its own, which outlives the processes killed. */
const run = async (
	schedules: readonly (readonly Fault[])[],
	mode: "callback" | "code" | "shipped" | "followed" | "rule" | "address" | "mcp" = "callback",
) => {
	const home = await tempHome();
	const fake = await startFakeMcp(
		mode === "callback" || mode === "rule" || mode === "address" || mode === "mcp"
			? { auth: "oauth" }
			: { auth: "oauth", registeredClient: "banda-app", device: true },
	);
	try {
		const { last, kills } = await runWorker("test/fault/connection-worker.ts", [home, fake.url, mode], schedules);
		return { ...(last as Summary), kills, home, creates: count(fake, "create_event"), tokens: [...fake.tokens] };
	} finally {
		await fake.close();
	}
};

const count = (fake: FakeMcp, tool: string) => fake.calls.filter((call) => call.tool === tool).length;

/** The store's files, as text, for a credential that must not be there. */
function storeText(home: string): string {
	return readdirSync(home)
		.filter((name) => name.startsWith("durable.db"))
		.map((name) => join(home, name))
		.filter((path) => statSync(path).isFile())
		.map((path) => readFileSync(path).toString("latin1"))
		.join("\n");
}

function check(summary: Awaited<ReturnType<typeof run>>) {
	expect(summary.outcome.status).toBe("completed");
	expect(summary.parked).toEqual([]);
	expect(summary.open).toBe(0);
	expect(summary.accepted).toBe(true);
	expect(summary.connected).toBe(true);
	// once, as approved; never again after an interruption, which the owner declined
	expect(summary.creates).toBeLessThanOrEqual(1);
	expect(summary.answers.filter((a) => a === "approve").length).toBeGreaterThanOrEqual(summary.creates);
	if (!summary.answers.includes("no-again")) expect(summary.creates).toBe(1);
	const text = storeText(summary.home);
	for (const token of summary.tokens) expect(text.includes(token)).toBe(false);
}

describe("connections under faults", () => {
	it("sweep: one kill at every commit, at the accept, at each step of signing in and at each call", async () => {
		{
			const clean = await run([]);
			check(clean);
			expect(clean.creates).toBe(1);
			expect(clean.answers).toEqual(["approve"]);
			const points: [FaultPoint, number][] = [
				["accept:before", 1],
				["accept:after", 1],
				["oauth:taken", 1],
				["oauth:exchanged", 1],
				["oauth:kept", 1],
				["connect:listed", 1],
				["connection:call", 1],
				["connection:answered", 1],
				["connection:call", 2],
				["connection:answered", 2],
				["answer", 1],
				["model", 1],
				["model", 2],
				["model", 3],
			];
			const faults: Fault[] = points.map(([point, hit]) => ({ point, hit, kind: "kill" }));
			for (let hit = 1; hit <= clean.commits; hit++)
				faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
			await pool(
				6,
				faults.map((fault) => async () => {
					const killed = await run([[fault]]);
					try {
						expect(killed.kills).toBe(1);
						check(killed);
						if (fault.point === "connection:answered" && fault.hit === 2) {
							// it reached the server, then the process died: asked again, declined, not sent twice
							expect(killed.creates).toBe(1);
							expect(killed.answers).toEqual(["approve", "no-again"]);
						}
						if (fault.point === "connection:call" && fault.hit === 2) expect(killed.creates).toBe(0);
					} catch (error) {
						throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
					}
				}),
			);
		}
	}, 600_000);

	it("sweep, signing in by code: one kill once the code was given, once the tokens came and once they were kept", async () => {
		const clean = await run([], "code");
		check(clean);
		expect(clean.creates).toBe(1);
		const points: FaultPoint[] = ["oauth:device", "oauth:exchanged", "oauth:kept", "connect:listed"];
		await pool(
			2,
			points.map((point) => async () => {
				const killed = await run([[{ point, hit: 1, kind: "kill" }]], "code");
				try {
					expect(killed.kills).toBe(1);
					check(killed);
					expect(killed.creates).toBe(1);
				} catch (error) {
					throw new Error(`killed at ${point}: ${(error as Error).message}`);
				}
			}),
		);
	}, 300_000);

	it("sweep, adding what banda ships: one kill once its file was written, and once it was allowed", async () => {
		const clean = await run([], "shipped");
		check(clean);
		expect(clean.creates).toBe(1);
		const points: FaultPoint[] = ["shipped:written", "accept:before", "accept:after"];
		await pool(
			2,
			points.map((point) => async () => {
				const killed = await run([[{ point, hit: 1, kind: "kill" }]], "shipped");
				try {
					expect(killed.kills).toBe(1);
					check(killed);
					expect(killed.creates).toBe(1);
				} catch (error) {
					throw new Error(`killed at ${point}: ${(error as Error).message}`);
				}
			}),
		);
	}, 300_000);

	it("sweep, following banda's next version: one kill once its file was written, and once it was allowed", async () => {
		const clean = await run([], "followed");
		check(clean);
		expect(clean.followed).toBe(true);
		const points: [FaultPoint, number][] = [
			["shipped:followed", 1],
			["accept:before", 2],
			["accept:after", 2],
		];
		await pool(
			2,
			points.map(([point, hit]) => async () => {
				const killed = await run([[{ point, hit, kind: "kill" }]], "followed");
				try {
					expect(killed.kills).toBe(1);
					check(killed);
					expect(killed.followed).toBe(true);
					expect(killed.creates).toBe(1);
				} catch (error) {
					throw new Error(`killed at ${point} #${hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 300_000);

	it("sweep, its read through a rule: one kill at each call and answer, on the read path and the draft's", async () => {
		const clean = await run([], "rule");
		check(clean);
		expect(clean.creates).toBe(1);
		const points: [FaultPoint, number][] = [
			["connection:call", 1],
			["connection:answered", 1],
			["connection:call", 2],
			["connection:answered", 2],
		];
		await pool(
			2,
			points.map(([point, hit]) => async () => {
				const killed = await run([[{ point, hit, kind: "kill" }]], "rule");
				try {
					expect(killed.kills).toBe(1);
					check(killed);
				} catch (error) {
					throw new Error(`killed at ${point} #${hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 300_000);

	it("sweep, set up as an MCP server from Connections: one kill at each step, and setting it up again resumes it", async () => {
		const clean = await run([], "mcp");
		check(clean);
		expect(clean.creates).toBe(1);
		const points: FaultPoint[] = ["address:written", "accept:after", "oauth:kept", "review:written", "connect:listed"];
		await pool(
			2,
			points.map((point) => async () => {
				const killed = await run([[{ point, hit: 1, kind: "kill" }]], "mcp");
				try {
					expect(killed.kills).toBe(1);
					check(killed);
				} catch (error) {
					throw new Error(`killed at ${point}: ${(error as Error).message}`);
				}
			}),
		);
	}, 300_000);

	it("sweep, added by its address and its reads trusted: one kill at each step the owner takes", async () => {
		const clean = await run([], "address");
		check(clean);
		expect(clean.creates).toBe(1);
		const points: FaultPoint[] = ["address:written", "accept:after", "oauth:kept", "trust:written", "connect:listed"];
		await pool(
			2,
			points.map((point) => async () => {
				const killed = await run([[{ point, hit: 1, kind: "kill" }]], "address");
				try {
					expect(killed.kills).toBe(1);
					check(killed);
				} catch (error) {
					throw new Error(`killed at ${point}: ${(error as Error).message}`);
				}
			}),
		);
	}, 300_000);
});
