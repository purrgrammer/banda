/**
 * Connections under kills (principle 10): a connection proposed, allowed, signed in to with OAuth, then read and
 * written, with one kill at every commit and at each new effect boundary (the accept, the callback's steps, the
 * listing, each call to the server, before and after it answered). Whatever was killed and when, the connection ends
 * allowed and connected, the Turn ends with nothing parked or open, the write reaches the server at most once and only
 * as approved, and no credential is in the store. The same again signing in by code, as a file's named client, with a
 * kill once the code was given, once the owner's tokens came, and once they were kept. And a draft waiting across a
 * new build that says its tool only reads: one kill at every commit and at the listing carried and the call found to
 * stay a write, and the owner's answer still decides it, once.
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
	answers: string[];
	due?: boolean;
	open: number;
	commits: number;
	points?: Record<string, number>;
};

/** One scenario, against a fake server of its own, which outlives the processes killed. */
const run = async (
	schedules: readonly (readonly Fault[])[],
	mode: "callback" | "code" | "shipped" | "remove" | "rule" | "address" | "mcp" | "carry" | "carry-deny" = "callback",
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

function check(summary: Awaited<ReturnType<typeof run>>, { denied = false } = {}) {
	expect(summary.outcome.status).toBe("completed");
	expect(summary.parked).toEqual([]);
	expect(summary.open).toBe(0);
	expect(summary.accepted).toBe(true);
	expect(summary.connected).toBe(true);
	// once, as approved; never again after an interruption, which the owner declined
	expect(summary.creates).toBeLessThanOrEqual(1);
	expect(summary.answers.filter((a) => a === "approve").length).toBeGreaterThanOrEqual(summary.creates);
	if (denied) expect(summary.creates).toBe(0);
	else if (!summary.answers.includes("no-again")) expect(summary.creates).toBe(1);
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

	for (const [mode, denied] of [
		["carry", false],
		["carry-deny", true],
	] as const)
		it(`sweep, a draft waiting across a new build (${denied ? "denied" : "approved"}): one kill at every commit, at the listing carried and at the call that stays a write`, async () => {
			const clean = await run([], mode);
			check(clean, { denied });
			expect(clean.creates).toBe(denied ? 0 : 1);
			expect(clean.answers).toEqual([denied ? "deny" : "approve"]);
			expect(clean.due).toBe(false);
			// the guard ran: the call went through the read path of the new build, and on as the write it was
			expect(clean.points?.["connection:stays-write"]).toBeGreaterThan(0);
			const points = [
				"connection:carry",
				"connection:carried",
				"connection:stays-write",
				"connection:call",
				"connection:answered",
				"answer",
			] as const satisfies readonly FaultPoint[];
			const faults: Fault[] = [];
			for (const point of points)
				for (let hit = 1; hit <= (clean.points?.[point] ?? 0); hit++) faults.push({ point, hit, kind: "kill" });
			for (let hit = 1; hit <= clean.commits; hit++)
				faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
			await pool(
				2,
				faults.map((fault) => async () => {
					const killed = await run([[fault]], mode);
					try {
						expect(killed.kills).toBe(1);
						// nothing ran unapproved, and the owner decided this draft once, however the build changed around it
						check(killed, { denied });
						expect(killed.answers.filter((a) => a === (denied ? "deny" : "approve")).length).toBeLessThanOrEqual(1);
						expect(killed.due).toBe(false);
					} catch (error) {
						throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
					}
				}),
			);
		}, 600_000);

	it("sweep, adding what banda ships: one kill before it is on, and once it is", async () => {
		const clean = await run([], "shipped");
		check(clean);
		expect(clean.creates).toBe(1);
		const points: FaultPoint[] = ["shipped:before", "shipped:added"];
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

	it("sweep, removing what banda ships: one kill before it is gone, and once it is, before its credentials go", async () => {
		const removal = async (schedules: readonly (readonly Fault[])[]) => {
			const home = await tempHome();
			const fake = await startFakeMcp({ auth: "oauth", registeredClient: "banda-app", device: true });
			try {
				return await runWorker("test/fault/connection-worker.ts", [home, fake.url, "remove"], schedules);
			} finally {
				await fake.close();
			}
		};
		const gone = { added: false, accounts: [], listed: false, credentials: 0 };
		expect((await removal([])).last).toMatchObject(gone);
		const points: FaultPoint[] = ["shipped:remove", "shipped:removed"];
		await pool(
			2,
			points.map((point) => async () => {
				const killed = await removal([[{ point, hit: 1, kind: "kill" }]]);
				expect(killed.kills, point).toBe(1);
				expect(killed.last, point).toMatchObject(gone);
			}),
		);
	}, 300_000);

	it("sweep, removing a server the owner added: one kill at each step, and it ends gone", async () => {
		const removal = async (schedules: readonly (readonly Fault[])[]) => {
			const home = await tempHome();
			const fake = await startFakeMcp();
			try {
				return await runWorker("test/fault/connection-worker.ts", [home, fake.url, "remove-server"], schedules);
			} finally {
				await fake.close();
			}
		};
		const gone = { record: false, listed: false, reads: false };
		expect((await removal([])).last).toMatchObject(gone);
		const points: FaultPoint[] = ["server:before", "server:added", "server:remove", "server:removed"];
		await pool(
			2,
			points.map((point) => async () => {
				const killed = await removal([[{ point, hit: 1, kind: "kill" }]]);
				expect(killed.kills, point).toBe(1);
				expect(killed.last, point).toMatchObject(gone);
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
		const points: FaultPoint[] = ["server:added", "settings:after", "oauth:kept", "connect:listed"];
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
		const points: FaultPoint[] = ["server:added", "settings:after", "oauth:kept", "connect:listed"];
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
