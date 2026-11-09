import { describe, expect, it } from "vitest";
import { EVERY_AGENT } from "../src/core/toolsets.ts";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	agent: string;
	effective: { instructions: string; tools: string[] };
	tools: string[];
	tier: { tier: string; custom?: true };
	commits: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/agent-refresh-worker.ts", [await tempHome()], schedules);
	return { summary: last as Summary, kills };
};

const check = ({ summary }: Awaited<ReturnType<typeof run>>) => {
	expect(summary.agent).toBe("reader");
	expect(summary.effective.instructions).toBe("NEW MARKER");
	expect(summary.effective.tools).toEqual(["t2"]);
	expect(summary.tools).toEqual([...EVERY_AGENT, "t2"]);
	expect(summary.tier).toEqual({ tier: "deep" });
};

describe("accepted agent changes under faults", () => {
	it("sweep: a kill before or after every commit still refreshes once the old run settles", async () => {
		const clean = await run([]);
		check(clean);
		const faults: Fault[] = [];
		for (let hit = 1; hit <= clean.summary.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			6,
			faults.map((fault) => async () => {
				const ran = await run([[fault]]);
				check(ran);
				expect(ran.kills).toBe(1);
			}),
		);
	}, 300_000);
});
