import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Row } from "../src/core/search.ts";
import type { Item, MemoryView } from "../src/server/api.ts";
import { view } from "../web/src/lib/chat.ts";
import { memoryWords } from "../web/src/lib/segments/memory.ts";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

const FACTS = ["Prefers aisle seats", "Never flies before 9am", "Likes small hotels"];

type Summary = {
	outcomes: ({ status: string; result?: unknown } | undefined)[];
	transcripts: Item[][];
	memory: MemoryView;
	lines: string[];
	rows: Row[];
	rebuilt: Row[];
	parked: unknown[];
	commits: number;
	models: number;
	writes: number;
	indexes: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/memory-worker.ts", [await tempHome()], schedules);
	return { ...(last as Summary), kills };
};

/**
 * The memory invariants: every fact the owner asked for is in its file exactly once, whatever was killed and when (a
 * rerun of `remember` finds the line it wrote); every Turn ends; nothing is parked; and the index, caught up after the
 * kills, is the index rebuilt from scratch.
 */
function check(summary: Summary) {
	for (const outcome of summary.outcomes) expect(outcome?.status, "a Turn").toBe("completed");
	for (const fact of FACTS)
		expect(
			summary.lines.filter((line) => line.startsWith(`- ${fact} <!--`)),
			fact,
		).toHaveLength(1);
	expect(summary.lines).toHaveLength(FACTS.length);
	expect(
		summary.memory.facts.map((fact) => ({
			text: fact.text,
			scope: fact.scope,
			agent: fact.scope === "agent" ? fact.agent : null,
		})),
	).toEqual(
		expect.arrayContaining([
			{ text: FACTS[0], scope: "global", agent: null },
			{ text: FACTS[1], scope: "agent", agent: "sancho" },
			{ text: FACTS[2], scope: "agent", agent: "sancho" },
		]),
	);
	expect(summary.rows).toEqual(summary.rebuilt);
	expect(
		summary.rows
			.filter((row) => row.kind === "fact")
			.map((row) => row.text)
			.sort(),
	).toEqual([...FACTS].sort());
	expect(summary.parked).toEqual([]);
	feedFollowsMemory(summary);
}

/**
 * The chat's feed, as the app derives it from the items and memory the daemon reports after the kills: a line reads
 * "Remembered" only for a fact memory holds and its file has, and every fact the owner asked for has its line.
 */
function feedFollowsMemory(summary: Summary) {
	const done: string[] = [];
	for (const transcript of summary.transcripts)
		for (const segment of view(
			transcript,
			[],
			{ busy: false, running: [], thinking: false },
			{ memory: summary.memory },
		))
			if (segment.kind === "memory") {
				const words = memoryWords(segment);
				if (segment.state !== "done") {
					expect(words, "a line not done").not.toMatch(/^Remembered/);
					continue;
				}
				const id = segment.fact?.id;
				expect(
					summary.memory.facts.some((fact) => fact.id === id),
					`${words}: its fact is in memory`,
				).toBe(true);
				expect(
					summary.lines.some((line) => line.startsWith(`- ${segment.fact?.text} <!--`)),
					`${words}: its file has it`,
				).toBe(true);
				done.push(words);
			}
	for (const fact of FACTS) expect(done, fact).toContain(`Remembered: ${fact}`);
}

const POINTS: FaultPoint[] = ["commit:before", "commit:after", "model", "memory:before", "memory:after", "index"];

describe("memory under faults", () => {
	it("sweep: one kill at every commit, model request, memory write and index catch-up; each fact once", async () => {
		const clean = await run([]);
		check(clean);
		const faults: Fault[] = [];
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.models; hit++) faults.push({ point: "model", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.writes; hit++)
			faults.push({ point: "memory:before", hit, kind: "kill" }, { point: "memory:after", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.indexes; hit++) faults.push({ point: "index", hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const killed = await run([[fault]]);
				try {
					expect(killed.kills).toBe(1);
					check(killed);
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 900_000);

	it("thrown writes before or after adds and a correction recover without losing or duplicating facts", async () => {
		await pool(
			2,
			[1, 2, 3, 4].flatMap((hit) =>
				(["memory:before", "memory:after"] as const).map((point) => async () => {
					check(await run([[{ point, hit, kind: "error" }]]));
				}),
			),
		);
	}, 120_000);

	it("an index catch-up that fails rolls back whole, and the next one catches up", async () => {
		check(await run([[{ point: "index", hit: 1, kind: "error" }], [{ point: "index", hit: 2, kind: "error" }]]));
	}, 120_000);

	it("property: under any few kills, each fact is kept once and the index equals a rebuild", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						point: fc.constantFrom(...POINTS),
						hit: fc.integer({ min: 1, max: 40 }),
						kind: fc.constant("kill" as const),
					}),
					{ minLength: 1, maxLength: 3 },
				),
				async (kills) => {
					check(await run(kills.map((kill) => [kill])));
				},
			),
			{ numRuns: pbtFaultRuns(3) },
		);
	}, 600_000);
});
