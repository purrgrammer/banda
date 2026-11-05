import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	again: unknown;
	trip: { paused?: string } | null;
	permissions: Record<string, unknown>;
	commits: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/archive-worker.ts", [await tempHome()], schedules);
	return { summary: last as Summary, kills };
};

const check = ({ summary }: Awaited<ReturnType<typeof run>>) => {
	expect(summary.again).toEqual({ refused: "Mara is archived: restore it from Settings to write to it" });
	expect(summary.trip?.paused).toBe("owner");
	expect(summary.permissions).toEqual({});
};

describe("archiving an agent under faults", () => {
	it("sweep: a kill before or after every commit still ends it archived, stopped, paused and revoked", async () => {
		const clean = await run([]);
		check(clean);
		const faults: Fault[] = [];
		for (let hit = 1; hit <= clean.summary.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const ran = await run([[fault]]);
				check(ran);
				expect(ran.kills).toBe(1);
			}),
		);
	}, 300_000);
});
