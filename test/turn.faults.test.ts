import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Inbound } from "../src/core/gateway.ts";
import { afterArb, faultsArb, messagesArb, ORIGINS } from "./fault/arbitraries.ts";
import { drive } from "./fault/drive.ts";
import { type Fault, type FaultPoint, Faults } from "./fault/faults.ts";
import { checkTurnInvariants } from "./fault/invariants.ts";
import { pool, runKilled } from "./fault/kill.ts";
import { REACT, SAY } from "./fixtures/models.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const POINTS: readonly FaultPoint[] = ["commit:before", "commit:after", "send:before", "send:after", "model"];
const crashedWhileSending = (reason: string) => /the daemon stopped while sending/.test(reason);

describe("Turn under faults", () => {
	it("property: thrown faults at every effect boundary, with redeliveries and restarts", async () => {
		await fc.assert(
			fc.asyncProperty(
				messagesArb().chain((messages) =>
					fc.tuple(
						fc.constant(messages),
						afterArb(messages.length),
						faultsArb(POINTS, "error", { maxHit: 40, maxFaults: 4 }),
					),
				),
				async ([messages, after, schedule]) => {
					const home = await tempHome();
					const { sent, summary } = await drive(home, messages, after, new Faults(schedule));
					checkTurnInvariants(messages, sent, summary);
				},
			),
			{ numRuns: pbtFaultRuns(25) },
		);
	}, 300_000);

	it("reports a failed nudge as failure, rather than requiring the reply that model request could not make", async () => {
		const messages: Inbound[] = [{ id: "owner", origin: { gateway: "fake", peer: "owner" }, text: `${SAY}hello` }];
		const { sent, summary } = await drive(
			await tempHome(),
			messages,
			["none"],
			new Faults([{ point: "model", hit: 2, kind: "error" }]),
		);
		expect(summary.nudges.owner).toEqual([{ status: "completed", result: { failed: "model_error: model #2" } }]);
		checkTurnInvariants(messages, sent, summary);
		// Removing that exact failure notice still violates delivery: an unrelated notice cannot satisfy it.
		expect(() =>
			checkTurnInvariants(
				messages,
				sent.filter((s) => !s.out.text.startsWith("The run failed:")),
				summary,
			),
		).toThrow();
	});

	it("property: processes killed at any effect boundary, several times over", async () => {
		await fc.assert(
			fc.asyncProperty(
				messagesArb(4),
				fc.array(faultsArb(POINTS, "kill", { maxHit: 30, maxFaults: 1 }), { minLength: 1, maxLength: 3 }),
				async (messages, schedules) => {
					const home = await tempHome();
					const { sent, summary } = await runKilled(home, messages, schedules);
					checkTurnInvariants(messages, sent, summary, crashedWhileSending);
				},
			),
			{ numRuns: pbtFaultRuns(6) },
		);
	}, 300_000);

	it("sweep: one kill at every commit, send and model request of a run, before and after each", async () => {
		// the third is refused, so the sweep reaches the notice to the owner too; the fourth is answered with a reaction,
		// and the last, the owner's, in the final text alone
		const messages: Inbound[] = [ORIGINS[0]!, ORIGINS[1]!, ORIGINS[3]!, ORIGINS[0]!, ORIGINS[4]!].map((origin, i) => ({
			id: `m${i}`,
			origin,
			text: `${i === 3 ? REACT : i === 4 ? SAY : ""}t${i}`,
		}));
		const clean = await runKilled(await tempHome(), messages, []);
		const faults: Fault[] = [];
		for (let hit = 1; hit <= clean.commits; hit++) {
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		}
		// one send per message, the notice, and a nudge's request and its answer
		for (let hit = 1; hit <= messages.length + 3; hit++) {
			for (const point of ["send:before", "send:after", "model"] as const) faults.push({ point, hit, kind: "kill" });
		}
		await pool(
			8,
			faults.map((fault) => async () => {
				const run = await runKilled(await tempHome(), messages, [[fault]]);
				try {
					checkTurnInvariants(messages, run.sent, run.summary, crashedWhileSending);
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 900_000);
});
