import { type Static, Type } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { AGENT_PUBLICATION_POINTS } from "../src/server/agent-publication.ts";
import type { Fault } from "./fault/faults.ts";
import { runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const worker = "test/fault/agent-publication-conflict-worker.ts";
const State = Type.Object({
	original: Type.String(),
	owner: Type.String(),
	rival: Type.String(),
	accepted: Type.String(),
	live: Type.String(),
	rivalCreated: Type.Boolean(),
	saved: Type.Array(Type.String()),
	retained: Type.Array(Type.String()),
	publication: Type.Union([
		Type.Literal("none"),
		Type.Literal("pending"),
		Type.Literal("published"),
		Type.Literal("conflict"),
		Type.Literal("superseded"),
	]),
	commits: Type.Integer({ minimum: 0 }),
	points: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});

function preserved(state: Static<typeof State>) {
	expect([state.original, state.owner]).toContain(state.accepted);
	if (state.rivalCreated) expect([state.live, ...state.retained]).toContain(state.rival);
	if (state.accepted === state.owner) expect(state.saved).toContain(state.owner);
	expect(state.publication).not.toBe("pending");
}

async function run(faults: readonly Fault[] = []) {
	const result = await runWorker(worker, [await tempHome()], faults.length === 0 ? [] : [faults]);
	if (!Value.Check(State, result.last)) throw new Error("invalid conflict publication result");
	preserved(result.last);
	expect(result.kills).toBe(faults.some((fault) => fault.kind === "kill") ? 1 : 0);
	return result.last;
}

function reachable(state: Static<typeof State>, kind: Fault["kind"]): Fault[] {
	const faults: Fault[] = [];
	for (const point of AGENT_PUBLICATION_POINTS)
		for (let hit = 1; hit <= (state.points[point] ?? 0); hit++) faults.push({ point, hit, kind });
	for (let hit = 1; hit <= state.commits; hit++)
		for (const point of ["commit:before", "commit:after"] as const) faults.push({ point, hit, kind });
	return faults;
}

describe("agent publication conflict restoration", () => {
	it("keeps the rival workspace version and exact accepted owner version in the clean control", async () => {
		const state = await run();
		expect(state.rivalCreated).toBe(true);
		expect(state.live).toBe(state.rival);
		expect(state.accepted).toBe(state.owner);
		expect(state.publication).toBe("conflict");
		expect(state.points["agent:insert:before"]).toBeGreaterThan(0);
		expect(state.points["agent:insert:after"]).toBeGreaterThan(0);
	});

	for (const kind of ["error", "kill"] as const)
		it(`${kind}: preserves both versions at every reachable restoration effect and commit`, async () => {
			const clean = await run();
			for (const fault of reachable(clean, kind)) await run([fault]);
		}, 180_000);

	it("preserves generated interrupted conflict restorations", async () => {
		const clean = await run();
		await fc.assert(
			fc.asyncProperty(fc.constantFrom(...reachable(clean, "error"), ...reachable(clean, "kill")), async (fault) => {
				await run([fault]);
			}),
			{ numRuns: pbtFaultRuns(8) },
		);
	}, 300_000);
});
