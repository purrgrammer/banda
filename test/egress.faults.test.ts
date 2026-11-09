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
	/** The tickets the agent was woken about, one each. */
	released: string[];
	/** Releases and Turns still live when the worker stopped. */
	live: number;
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
	expect(summary.live).toBe(0);
	const within = (ticket: string) => (ticket === SECOND ? unasked.length : 0);
	for (const ticket of summary.tickets) {
		const firsts = summary.waits.filter(
			(w) => w.ask.type === "approval" && w.ask.args._ticket === ticket && w.ask.interrupted !== true,
		);
		// no ticket without its ask or permission: the store never holds one nobody was asked about
		expect(firsts.length, `asks of ${ticket}`).toBeLessThanOrEqual(1);
		expect(firsts.length + within(ticket), `${ticket} was neither asked nor allowed`).toBeGreaterThanOrEqual(1);
		// and however it ended, the agent is told, once
		expect(
			summary.released.filter((t) => t === ticket),
			`told of ${ticket}`,
		).toHaveLength(1);
	}
	// no approval, and no word to the agent, about a request the store does not hold
	for (const w of summary.waits) if (w.ask.type === "approval") expect(summary.tickets).toContain(w.ask.args._ticket);
	for (const ticket of summary.released) expect(summary.tickets).toContain(ticket);
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

/** With no fault: one ask, one send each, the second within the permission the first gave, the agent told of both. */
async function cleanRun() {
	const clean = await run([]);
	check(clean);
	expect(clean.sends).toEqual([FIRST, SECOND]);
	expect(clean.tickets).toEqual([FIRST, SECOND]);
	expect(clean.released).toEqual([FIRST, SECOND]);
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
	return clean;
}

describe("egress under faults", () => {
	it("with no fault, a held write asks once, is sent once, and the agent goes on", async () => {
		await cleanRun();
	}, 60_000);

	it("sweep: one kill at every commit, at ticket intake, at a direct send taken, at each send and at the answer", async () => {
		const clean = await cleanRun();
		const faults: Fault[] = [];
		for (const point of [
			"intake",
			"intake:stored",
			"release:run",
			"replay",
			"replay:sent",
			"release:ran",
			"release:told",
		] as const)
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

	it("a kill or a throw at each boundary of a release: nothing sent twice unasked, no ticket orphaned, the agent told once", async () => {
		const faults: Fault[] = [];
		for (const kind of ["kill", "error"] as const)
			for (const point of [
				"intake",
				"intake:stored",
				"release:run",
				"replay",
				"replay:sent",
				"release:ran",
				"release:told",
			] as const)
				faults.push({ point, hit: 1, kind });
		faults.push({ point: "answer", hit: 1, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const hit = await run([[fault]]);
				try {
					if (fault.kind === "kill") expect(hit.kills).toBe(1);
					check(hit);
				} catch (error) {
					throw new Error(`${fault.kind} at ${fault.point}: ${(error as Error).message}`);
				}
			}),
		);
	}, 300_000);
});
