import { describe, expect, it } from "vitest";
import type { WaitEnded } from "../src/core/wait.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	waits: WaitEnded[];
	sends: string[];
	results: number;
	tickets: string[];
	sent: string[];
	chat: number;
	permissions: number;
	activity: string[];
	parked: unknown[];
	open: number;
	commits: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/egress-worker.ts", [await tempHome()], schedules);
	return { ...(last as Summary), kills };
};

const FIRST = "t0000000010";
const SECOND = "t0000000020";

/**
 * Whatever was killed: nothing is sent but as an approved draft or within the permission the first approval gave, and
 * a held request is sent again only when a kill interrupted its send and the owner said to run it again. Only the
 * second request, of the route the owner allowed, runs within the permission, once at most, and only once it was
 * given. A request is stored once, by its ticket, before the proxy forgets it. No ask stays open and nothing is parked.
 */
function check(summary: Summary) {
	const approvals = (ticket: string) =>
		summary.waits.filter(
			(w) =>
				w.ask.type === "approval" &&
				w.ask.args._ticket === ticket &&
				w.outcome === "answered" &&
				w.answer === "approve",
		).length;
	const unasked = summary.activity.filter((what) => what.startsWith("Ran without asking"));
	expect(summary.open).toBe(0);
	expect(summary.parked).toEqual([]);
	expect(unasked.length).toBeLessThanOrEqual(1);
	for (const what of unasked) expect(what).toContain("/v1/issues/2/comments");
	if (unasked.length > 0) expect(summary.permissions).toBe(1);
	for (const ticket of [FIRST, SECOND]) {
		const sent = summary.sends.filter((t) => t === ticket).length;
		const within = ticket === SECOND ? unasked.length : 0;
		expect(sent, `sends of ${ticket}`).toBeLessThanOrEqual(approvals(ticket) + within);
	}
	expect(summary.sends.every((t) => t === FIRST || t === SECOND)).toBe(true);
	// every ticket the proxy handed over is in the store; none twice
	expect(new Set(summary.tickets).size).toBe(summary.tickets.length);
	// a write the proxy sent straight through is logged at most once, and only in the commit that keeps it
	const direct = summary.activity.filter((what) => what.includes("under your permission"));
	expect(direct.length).toBeLessThanOrEqual(1);
	expect(direct.length).toBe(summary.sent.length);
}

describe("egress under faults", () => {
	it("sweep: one kill at every commit, at ticket intake, at a direct send taken, at each send and at the answer", async () => {
		const clean = await run([]);
		check(clean);
		expect(clean.sends).toEqual([FIRST, SECOND]);
		expect(clean.tickets).toEqual([FIRST, SECOND]);
		expect(clean.sent).toEqual(["s0000000001"]);
		expect(clean.activity).toContain(
			"Sent POST git.example.com/me/repo.git/git-receive-pack under your permission (HTTP 200)",
		);
		// the chat read from outside, and still the first ask offered every scope; the route allowed always, the second
		// request ran within it, unasked
		const asked = clean.waits.filter((w) => w.ask.type === "approval");
		expect(
			asked.map((w) => (w.ask.type === "approval" ? w.ask.scopes?.map((offered) => offered.scope) : undefined)),
		).toEqual([["task", "hour", "today", "always", "host"]]);
		expect(clean.permissions).toBe(1);
		expect(clean.activity.filter((what) => what.startsWith("Ran without asking"))).toHaveLength(1);
		const faults: Fault[] = [];
		for (const point of ["intake", "intake:stored", "replay", "replay:sent"] as const)
			faults.push({ point, hit: 1, kind: "kill" }, { point, hit: 2, kind: "kill" });
		// the owner is asked once: the second request runs within the permission
		faults.push({ point: "answer", hit: 1, kind: "kill" });
		// the one direct send is taken once, so its point is hit once
		faults.push({ point: "intake:sent", hit: 1, kind: "kill" });
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			8,
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
	}, 600_000);
});
