import { describe, expect, it } from "vitest";
import { AGENT_PUBLICATION_POINTS, type AgentPublicationPoint } from "../src/server/agent-publication.ts";
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
 * The only errors a cut may honestly leave before the owner's "try again", each made good by it:
 * - `update_agent`'s fail-closed refusal while the new agent's box file is still being written, only when the fault
 *   cut that publication (src/core/band-tools.ts);
 * - the box's `write` reported interrupted, which is never run again (src/box/tools.ts; pi-durable's tool.js words).
 */
const PENDING =
	"Not updated: agents/writer.md in the workspace is not the version in effect: a change to it waits for the owner, or is still being written.";
const INTERRUPTED = /^Tool write was interrupted (by a restart )?and may have partially run$/;
/** An injected fault's own words (test/fault/faults.ts): none may reach an answer. */
const LEAKED = /InjectedFault|\b(commit|agent):[a-z:]+ #\d+/;
const allowed = (result: State["results"][number], fault: Fault | undefined) =>
	(result.tool === "update_agent" && result.text === PENDING && fault?.point.startsWith("agent:") === true) ||
	(result.tool === "write" && INTERRUPTED.test(result.text));

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
	for (const result of state.results) expect(LEAKED.test(result.text), why).toBe(false);
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
