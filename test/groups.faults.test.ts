import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	rooms: number;
	log: { author: { owner: true } | { agent: string }; text: string; mentions: string[] }[];
	turns: string[][];
	notices: object[];
	nudges: number;
	commits: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last } = await runWorker("test/fault/groups-worker.ts", [await tempHome()], schedules);
	return last as Summary;
};

/**
 * Whatever restarts come between: one group; the owner's message posted once, asking both; alice's answer posted once,
 * asking bob; bob's two answers (to the owner, to alice) each once, the owner's after exactly one nudge; no notice; and
 * every message admitted its turns once.
 */
function check({ rooms, log, turns, notices, nudges }: Summary) {
	expect(nudges).toBe(1);
	expect(notices).toEqual([]);
	expect(rooms).toBe(1);
	const who = (message: Summary["log"][number]) => ("owner" in message.author ? "owner" : message.author.agent);
	expect(log.filter((message) => who(message) === "owner")).toEqual([
		{ author: { owner: true }, text: "both of you", mentions: ["alice", "bob"] },
	]);
	expect(log.filter((message) => who(message) === "alice")).toEqual([
		{ author: { agent: "alice" }, text: "alice reply", mentions: ["bob"] },
	]);
	expect(log.filter((message) => who(message) === "bob").map((message) => message.text)).toEqual([
		"bob reply",
		"bob reply",
	]);
	// the owner's message started alice's and bob's turns; alice's, bob's; bob's, none
	expect(turns.filter((each) => each.length > 0).sort()).toEqual([["alice", "bob"], ["bob"]]);
}

describe("groups under faults", () => {
	it("sweep: one kill at every commit and model request; each message once, each mention one turn", async () => {
		const clean = await run([]);
		check(clean);
		const faults: Fault[] = [];
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		for (let hit = 1; hit <= 7; hit++) faults.push({ point: "model", hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				try {
					check(await run([[fault]]));
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 600_000);
});
