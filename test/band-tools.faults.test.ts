import { describe, expect, it } from "vitest";
import { AGENT_PUBLICATION_POINTS, type AgentPublicationPoint } from "../src/server/agent-publication.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

const worker = "test/fault/band-tools-worker.ts";
type State = {
	accepted: string;
	box: string;
	rooms: number;
	receipts: string[];
	results: { tool: string; error: boolean; receipt: boolean; text?: string }[];
	commits: number;
	points: Record<AgentPublicationPoint, number>;
};
const run = async (faults: readonly Fault[]) => {
	const { last, kills } = await runWorker(worker, [await tempHome()], [faults]);
	return { state: last as State, kills };
};
/** One agent in effect, its box file the same bytes, one group, one receipt each, and each call answered once. */
const expectMadeOnce = ({ state }: Awaited<ReturnType<typeof run>>) => {
	expect(state.accepted).toContain("name: Writer");
	expect(state.box).toBe(state.accepted);
	expect(state.rooms).toBe(1);
	expect(state.receipts).toEqual(["agent", "group"]);
	const band = state.results.filter((result) => result.tool === "create_agent" || result.tool === "create_group");
	expect(band, JSON.stringify(band)).toEqual([
		{ tool: "create_agent", error: false, receipt: true },
		{ tool: "create_group", error: false, receipt: true },
	]);
};

describe("create_agent and create_group across store and box faults", () => {
	it("control: the agent, its box file, the group and the receipts converge", async () => {
		const clean = await run([]);
		expectMadeOnce(clean);
		expect(clean.state.commits).toBeGreaterThan(0);
		for (const point of AGENT_PUBLICATION_POINTS) expect(clean.state.points[point]).toBeGreaterThan(0);
	});

	for (const kind of ["error", "kill"] as const) {
		it(`${kind}: every commit and publication boundary recovers as one agent and one group`, async () => {
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
					expect(result.kills).toBe(kind === "kill" ? 1 : 0);
					expectMadeOnce(result);
				}),
			);
		}, 300_000);
	}
});
