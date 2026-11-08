/**
 * A Slack post under kills (principle 10): Slack added as shipped and signed in with "Send messages as you", then one
 * approved reply in a thread, with one kill at every commit and at each effect boundary of the post (the call before
 * it goes, and once Slack answered, before banda recorded it), the owner's answer and each model request.
 *
 * A post is unsafe: Slack takes no idempotency key. Whatever was killed and when, the message is posted at most once;
 * a run a kill cut short is never repeated unasked, the owner is asked again (and skips it here); the Turn ends with
 * nothing parked or open. A kill before the post went leaves it unsent or asked again, never sent twice.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { ROOT_TS } from "./fixtures/slack.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const effects = ["connection:call", "connection:answered", "answer", "model"] as const;
type Summary = {
	outcome: { status: string };
	parked: unknown[];
	answers: string[];
	open: number;
	posts: { channel: string; text: string; thread_ts?: string }[];
	commits: number;
	points: Record<(typeof effects)[number], number>;
};

async function run(schedules: readonly (readonly Fault[])[] = []) {
	const { last, kills } = await runWorker("test/fault/slack-post-worker.ts", [await tempHome()], schedules);
	const summary = last as Summary;
	expect(summary.outcome.status).toBe("completed");
	expect(summary.parked).toEqual([]);
	expect(summary.open).toBe(0);
	// sent once or asked again, never twice
	expect(summary.posts.length).toBeLessThanOrEqual(1);
	for (const post of summary.posts)
		expect(post).toMatchObject({ channel: "C0GENERAL", text: "I'll look", thread_ts: ROOT_TS });
	// the owner approves once; only a run a kill may have cut short asks again
	expect(summary.answers.filter((answer) => answer === "approve").length).toBeLessThanOrEqual(1);
	return { ...summary, kills };
}

describe("a Slack post under faults", () => {
	it("recovers from generated thrown faults and kills at the post's boundaries", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(
					fc.constantFrom(...effects).map((point) => [point, "kill"] as const),
					// the owner's answer is the worker's own step: thrown there, it fails the worker, not banda
					fc.constantFrom("connection:call", "connection:answered", "model").map((point) => [point, "error"] as const),
				),
				async ([point, kind]) => {
					const result = await run([[{ point, hit: 1, kind }]]);
					expect(result.kills).toBe(kind === "kill" ? 1 : 0);
				},
			),
			{ numRuns: pbtFaultRuns(4) },
		);
	}, 300_000);

	it("sweeps one SIGKILL across every commit and every boundary", async () => {
		const clean = await run();
		expect(clean.posts).toHaveLength(1);
		expect(clean.answers).toEqual(["approve"]);
		const faults: Fault[] = [];
		for (const point of effects)
			for (let hit = 1; hit <= clean.points[point]; hit++) faults.push({ point, hit, kind: "kill" });
		for (const point of ["commit:before", "commit:after"] as const satisfies readonly FaultPoint[])
			for (let hit = 1; hit <= clean.commits; hit++) faults.push({ point, hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const recovered = await run([[fault]]);
				expect(recovered.kills, JSON.stringify(fault)).toBe(1);
			}),
		);
	}, 1_800_000);
});
