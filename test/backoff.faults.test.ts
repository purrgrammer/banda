import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

type Seen = { asked: number; status: string };
type Summary = {
	delay: number | null;
	before?: Seen;
	restarted?: Seen;
	after: { asked: number };
	outcome: string;
	answers: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/backoff-worker.ts", [await tempHome()], schedules);
	return { ...(last as Summary), kills };
};

/**
 * pi-durable 1.5 does not send again a model request the host died during: it is a failed attempt, retried after the
 * backoff on the Harness clock. The fault workers whose clocks stand still retry at once (`baseDelayMs: 0`); this is
 * where the backoff itself is held to: not before its end, through a restart, and then once.
 */
describe("a request the host died during, under the retry backoff", () => {
	it("is retried when the backoff ends on the Harness clock, not before, also after a clean restart", async () => {
		// what a run asks and answers when nothing cuts it off: the retried one does the same, from its retry on
		const clean = await run([]);
		const seen = await run([[{ point: "model", hit: 1, kind: "kill" }]]);
		expect(seen.kills).toBe(1);
		// attempt 1: the base delay, from the clock when the next process found it cut off
		expect(seen.delay).toBe(2000);
		expect(seen.before).toEqual({ asked: 0, status: "sleeping" });
		expect(seen.restarted).toEqual({ asked: 0, status: "sleeping" });
		expect(seen.after.asked).toBe(clean.after.asked);
		expect(seen.outcome).toBe("completed");
		expect(seen.answers).toBe(clean.answers);
	}, 120_000);

	it("without a kill, never waits on a retry and answers", async () => {
		const seen = await run([]);
		expect(seen.delay).toBeNull();
		expect(seen.after.asked).toBeGreaterThan(0);
		expect(seen.outcome).toBe("completed");
		expect(seen.answers).toBeGreaterThan(0);
	}, 60_000);
});
