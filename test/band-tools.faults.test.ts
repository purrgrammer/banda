import { describe, expect, it } from "vitest";
import { AGENT_PUBLICATION_POINTS, type AgentPublicationPoint } from "../src/server/agent-publication.ts";
import { allowed, LEAKED, NOT_WRITTEN, withoutNote } from "./fault/band-tools-answers.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

/** The skill the worker writes (test/fault/band-tools-worker.ts). */
const SKILL = "---\nname: notes\ndescription: How the owner likes notes.\n---\nKeep notes short.\n";

const worker = "test/fault/band-tools-worker.ts";
type State = {
	accepted: string;
	box: string;
	skill: string;
	skillBox: string;
	rooms: number;
	receipts: string[];
	results: { tool: string; error: boolean; receipt: boolean; text: string }[];
	commits: number;
	points: Record<AgentPublicationPoint, number>;
};
const run = async (faults: readonly Fault[]) => {
	const { last, kills } = await runWorker(worker, [await tempHome()], [faults]);
	return { state: last as State, kills };
};
/** Each tool the owner's message calls; every one answers with success exactly once, however it was cut. */
const TOOLS = ["create_agent", "update_agent", "write", "create_group"] as const;
/**
 * The run converged: the agent in effect with its update and its box file the same bytes, the skill in effect with
 * its box file the same bytes, one group, the receipts agent, agent, group, every tool answered with success exactly
 * once, any error one a cut may leave, and no injected fault in any answer. Without a fault, no error at all.
 */
const expectConverged = ({ state }: Awaited<ReturnType<typeof run>>, fault?: Fault) => {
	const why = JSON.stringify({ fault: fault ?? null, results: state.results });
	expect(state.accepted, why).toContain("name: Writer");
	expect(state.accepted, why).toContain("description: Writes and edits drafts");
	expect(state.box, why).toBe(state.accepted);
	expect(state.skill, why).toBe(SKILL);
	expect(state.skillBox, why).toBe(SKILL);
	expect(state.rooms, why).toBe(1);
	expect(state.receipts, why).toEqual(["agent", "agent", "group"]);
	for (const tool of TOOLS)
		expect(state.results.filter((result) => result.tool === tool && !result.error).length, `${tool}: ${why}`).toBe(1);
	// the note is set aside only where it is exactly this fault's, at most once; anything else is a leak, and so is the
	// note anywhere else. It is not required: a fault that fired in recovery, outside any call, leaves no answer to carry it.
	const words = state.results.map((result) => withoutNote(result, fault));
	expect(words.filter((text, i) => text !== state.results[i]?.text).length, why).toBeLessThanOrEqual(1);
	for (const text of words) {
		expect(LEAKED.test(text), why).toBe(false);
		expect(text.includes(NOT_WRITTEN), why).toBe(false);
	}
	const errors = state.results.filter((result) => result.error);
	if (fault === undefined) expect(errors, why).toEqual([]);
	else for (const result of errors) expect(allowed(result, fault), why).toBe(true);
};

describe("create_agent, update_agent, a skill's write and create_group across store and box faults", () => {
	it("control: one answer each, all successes, and the agent, its box file, the skill and the group converge", async () => {
		const clean = await run([]);
		expectConverged(clean);
		// four answers, one per call: no retry happened, and nothing answered twice
		expect(clean.state.results.map(({ tool }) => tool).sort()).toEqual([...TOOLS].sort());
		expect(clean.state.commits).toBeGreaterThan(0);
		for (const point of AGENT_PUBLICATION_POINTS) expect(clean.state.points[point]).toBeGreaterThan(0);
	});

	for (const kind of ["error", "kill"] as const) {
		it(`${kind}: every commit and publication boundary converges once the owner asks again`, async () => {
			const clean = await run([]);
			const faults: Fault[] = [];
			for (const point of AGENT_PUBLICATION_POINTS)
				for (let hit = 1; hit <= clean.state.points[point]; hit++) faults.push({ point, hit, kind });
			for (let hit = 1; hit <= clean.state.commits; hit++)
				for (const point of ["commit:before", "commit:after"] as const) faults.push({ point, hit, kind });
			await pool(
				2,
				faults.map((fault) => async () => {
					const result = await run([fault]);
					expect(result.kills, JSON.stringify(fault)).toBe(kind === "kill" ? 1 : 0);
					expectConverged(result, fault);
				}),
			);
		}, 300_000);
	}
});
