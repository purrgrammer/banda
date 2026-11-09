import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chatReadScenario, type Reply } from "./fault/chat-read-scenario.ts";
import { Faults } from "./fault/faults.ts";
import { runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const REPLIES: Reply[] = ["text", "question", "files", "reaction", "view"];
const invariant = (result: { unread?: number; cursor?: number }, replies: readonly Reply[]) => {
	expect(result.unread).toBe(replies.length);
	expect(result.cursor).toBeGreaterThan(0);
};

describe("read cursors under faults", () => {
	it("property: an opening and a delayed stale read never consume later replies after thrown commit faults", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.constantFrom(...REPLIES), { maxLength: 8 }),
				fc.array(
					fc.record({
						point: fc.constantFrom("commit:before" as const, "commit:after" as const),
						hit: fc.integer({ min: 1, max: 8 }),
						kind: fc.constant("error" as const),
					}),
					{ maxLength: 3 },
				),
				async (replies, schedule) =>
					invariant(await chatReadScenario(await tempHome(), new Faults(schedule), replies), replies),
			),
			{ numRuns: pbtFaultRuns(20) },
		);
	}, 120_000);

	it("sweep: SIGKILL at each commit, including a stale read, leaves exactly the later batch unread", async () => {
		const clean = await chatReadScenario(await tempHome(), new Faults(), REPLIES);
		for (const point of ["commit:before", "commit:after"] as const) {
			for (let hit = 1; hit <= clean.commits; hit++) {
				const { last, kills } = await runWorker(
					"test/fault/chat-read-worker.ts",
					[await tempHome(), JSON.stringify(REPLIES)],
					[[{ point, hit, kind: "kill" }]],
				);
				expect(kills).toBe(1);
				invariant(last as typeof clean, REPLIES);
			}
		}
	}, 120_000);
});
