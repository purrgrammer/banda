/**
 * The companion's name under faults: thrown faults before and after every commit of a scenario of renames interleaved
 * with chat starts, the store reopened after each, as a supervisor restarting the daemon would. Invariants:
 * the stored name is always one that was written (the last acknowledged, or an attempt since whose commit was stored
 * before its fault), never a mix; and each chat's instructions name what was stored when it started.
 */

import { AgentDoc, type ConversationId, createRegistry, type Harness, SessionFailed } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LEAD_TEXT, parseAgent } from "../src/core/agents.ts";
import { DEFAULT_NAME } from "../src/core/choices.ts";
import { Companion, nameLine, setCompanion } from "../src/core/companion.ts";
import { OWNER } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { type Fault, Faults, InjectedFault } from "./fault/faults.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

type Step = { readonly rename: string } | { readonly start: true };

const lead = (parseAgent("sancho", LEAD_TEXT) as { agent: { instructions: string } }).agent.instructions;
const expected = (name: string | undefined) => `${nameLine(name ?? DEFAULT_NAME)}\n\n${lead}`;

/** Run `steps` against a store whose commits pass `faults`; resolves with what the invariants need. */
async function drive(steps: readonly Step[], faults: Faults) {
	const home = await tempHome();
	const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
	let harness: Harness | undefined;
	const reopen = async () => {
		await harness?.close(context).catch(() => undefined);
		harness = undefined;
		for (;;) {
			try {
				const registry = createRegistry();
				registry.install(core.extension);
				// never resumed: the Turns wait, as only the chats' starts are under test
				harness = await openStore(home, {
					models: echoModels().models,
					registry,
					wrapStorage: (s) => faults.storage(s),
				});
				return;
			} catch (error) {
				if (!(error instanceof InjectedFault)) throw error;
			}
		}
	};
	const faulted = (error: unknown) => error instanceof InjectedFault || error instanceof SessionFailed;
	/** Run `step` until it gets through, reopening the store after each fault. */
	const through = async <T>(step: (h: Harness) => Promise<T>): Promise<T> => {
		for (;;) {
			try {
				return await step(harness!);
			} catch (error) {
				if (!faulted(error)) throw error;
				await reopen();
			}
		}
	};
	const stored = () => through(async (h) => (await h.snapshot(Companion, context))?.name);
	await reopen();
	let acknowledged: string | undefined;
	let attempts: string[] = [];
	const started: { chat: number; name: string | undefined }[] = [];
	for (const [i, step] of steps.entries()) {
		if ("rename" in step) {
			attempts.push(step.rename);
			try {
				await setCompanion(harness!, { name: step.rename });
				acknowledged = step.rename;
				attempts = [];
			} catch (error) {
				if (!faulted(error)) throw error;
				await reopen();
			}
			const now = await stored();
			// one that was written, whole: the last acknowledged, or an attempt since that was stored before its fault
			expect([acknowledged, ...attempts], `the name after step ${i}`).toContain(now);
			if (now !== acknowledged) {
				acknowledged = now;
				attempts = [];
			}
		} else {
			const name = await stored();
			const got = await through((h) =>
				core.receive(h, { id: `m${i}`, origin: { gateway: "fake", peer: OWNER, thread: `t${i}` }, text: "hi" }),
			);
			if (!("turn" in got)) throw new Error(JSON.stringify(got));
			started.push({ chat: got.chat, name });
		}
	}
	for (const { chat, name } of started) {
		const instructions = await through((h) =>
			h.commit(async (tx) => (await tx.doc(AgentDoc, chat as ConversationId)).instructions, context),
		);
		expect(instructions, `chat ${chat}`).toBe(expected(name));
	}
	await harness!.close(context);
}

const NAMES = ["Rocinante", "Dapple", "Ana María", "名前", "x".repeat(40)];
const stepsArb = fc.array(
	fc.oneof(
		fc.constantFrom(...NAMES).map((rename): Step => ({ rename })),
		fc.constant<Step>({ start: true }),
	),
	{ minLength: 1, maxLength: 8 },
);

const SCENARIO: readonly Step[] = [
	{ start: true },
	{ rename: "Rocinante" },
	{ start: true },
	{ rename: "Dapple" },
	{ start: true },
];

describe("the companion's name under faults", () => {
	it("property: thrown faults before and after any commit, renames interleaved with starts", async () => {
		await fc.assert(
			fc.asyncProperty(
				stepsArb,
				fc.array(
					fc.record({
						point: fc.constantFrom("commit:before" as const, "commit:after" as const),
						hit: fc.integer({ min: 1, max: 20 }),
						kind: fc.constant("error" as const),
					}),
					{ maxLength: 4 },
				),
				async (steps, schedule) => drive(steps, new Faults(schedule)),
			),
			{ numRuns: pbtFaultRuns(40) },
		);
	}, 300_000);

	it("sweep: one fault before and after every commit of a scenario", async () => {
		const clean = new Faults();
		await drive(SCENARIO, clean);
		const commits = clean.hits("commit:before");
		expect(commits).toBeGreaterThanOrEqual(SCENARIO.length);
		const faults: Fault[] = [];
		for (let hit = 1; hit <= commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "error" }, { point: "commit:after", hit, kind: "error" });
		for (const fault of faults) {
			try {
				await drive(SCENARIO, new Faults([fault]));
			} catch (error) {
				throw new Error(`faulted at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
			}
		}
	}, 300_000);
});
