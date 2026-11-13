import { describe, expect, it } from "vitest";
import { AGENT_PUBLICATION_POINTS, type AgentPublicationPoint } from "../src/server/agent-publication.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

const worker = "test/fault/proposal-agent-worker.ts";
type State = {
	state: string;
	accepted: string;
	box: string;
	results: number;
	decided: number;
	commits: number;
	points: Record<AgentPublicationPoint, number>;
};
const run = async (faults: readonly Fault[]) => {
	const { last, kills } = await runWorker(worker, [await tempHome()], [faults]);
	return { state: last as State, kills };
};
const expectAccepted = ({ state }: Awaited<ReturnType<typeof run>>) => {
	expect(state.state).toBe("accepted");
	expect(state.accepted).toContain("Read carefully and verify claims.");
	expect(state.box).toBe(state.accepted);
	expect(state.results).toBe(1);
	expect(state.decided).toBe(1);
};

describe("accepting an existing-agent proposal across box and store faults", () => {
	it("control: the accepted definition, workspace file and card converge", async () => {
		const clean = await run([]);
		expectAccepted(clean);
		expect(clean.state.commits).toBeGreaterThan(0);
		for (const point of AGENT_PUBLICATION_POINTS) expect(clean.state.points[point]).toBeGreaterThan(0);
	});

	for (const kind of ["error", "kill"] as const) {
		it(`${kind}: every commit and publication boundary recovers as one accepted change`, async () => {
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
					expectAccepted(result);
				}),
			);
		}, 300_000);
	}
});
