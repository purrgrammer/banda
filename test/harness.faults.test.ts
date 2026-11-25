import { describe, expect, it } from "vitest";
import type { Fault } from "./fault/faults.ts";
import { PAST, pool, runWorker, unlanded } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	state: string;
	woke: string[];
	prompts: number;
	loaded: number;
	notes: number;
	orphans: number;
	parked: unknown[];
	commits: number;
};

let n = 0;
const run = async (schedules: readonly (readonly Fault[])[], mode?: "continue" | "note" | "v2" | "v2stop") => {
	// a mark no other run shares, so a command that outlived its process is this run's
	const mark = `banda-harness-fault-${process.pid}-${n++}`;
	const { last, kills } = await runWorker(
		"test/fault/harness-worker.ts",
		[await tempHome(), mark, ...(mode === undefined ? [] : [mode])],
		schedules,
	);
	return { ...(last as Summary), kills };
};

/**
 * A harness session under kills: its ask reaches the harness at most once, and exactly once when it finished; it ends
 * once (closed with its turn, as a v1 harness that reports no background work does; interrupted past the ask; failed
 * before it), waking its agent once; never done, which only a harness that reports its background work can earn;
 * nothing its harness started outlives the process that started it; nothing is parked.
 */
function check(summary: Summary, finished: "closed" | "done" | "stopped" = "closed") {
	// v2stop: a fault that ends the turn before its background command starts leaves nothing to stop: done is right
	const ends = finished === "stopped" ? ["stopped", "done"] : [finished];
	expect([...ends, "interrupted", "failed"]).toContain(summary.state);
	expect(summary.woke).toHaveLength(1);
	expect(summary.prompts).toBeLessThanOrEqual(1);
	if (summary.state === "closed" || summary.state === "done") expect(summary.prompts).toBe(1);
	expect(summary.orphans).toBe(0);
	expect(summary.parked).toEqual([]);
}

/** One kill at every harness boundary and every commit of a clean run, and errors at the boundaries that may throw. */
function sweep(commits: number): Fault[] {
	const faults: Fault[] = [
		{ point: "harness:spawn", hit: 1, kind: "kill" },
		{ point: "harness:prompted", hit: 1, kind: "kill" },
		{ point: "harness:update", hit: 1, kind: "kill" },
		{ point: "harness:ask", hit: 1, kind: "kill" },
		{ point: "harness:spawn", hit: 1, kind: "error" },
		{ point: "harness:update", hit: 1, kind: "error" },
		{ point: "harness:ask", hit: 1, kind: "error" },
	];
	for (let hit = 1; hit <= commits; hit++)
		faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
	return faults;
}

describe("a harness session under faults", () => {
	it("sweep: one kill at every commit and at every harness boundary", async () => {
		const clean = await run([]);
		check(clean);
		expect(clean.state).toBe("closed");
		await pool(
			2,
			sweep(clean.commits).map((fault) => async () => {
				const killed = await run([[fault]]);
				try {
					if (fault.kind === "kill") expect(killed.kills).toBe(1);
					check(killed);
					// past the ask, a restart never sends it again
					if (fault.point === "harness:ask" && fault.kind === "kill") expect(killed.state).toBe("interrupted");
				} catch (error) {
					throw new Error(`${fault.kind} at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 600_000);

	it("sweep, following up on an ended session: it reopens that one, the follow-up sent alone, at most once", async () => {
		const clean = await run([], "continue");
		check(clean);
		expect(clean.state).toBe("closed");
		expect(clean.loaded).toBe(1);
		await pool(
			2,
			sweep(clean.commits).map((fault) => async () => {
				const killed = await run([[fault]], "continue");
				try {
					if (fault.kind === "kill") expect(killed.kills).toBe(1);
					check(killed);
					// a follow-up that was sent went to the reopened session
					if (killed.prompts === 1) expect(killed.loaded).toBeGreaterThanOrEqual(1);
				} catch (error) {
					throw new Error(`${fault.kind} at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 600_000);
	for (const [mode, finished] of [
		["v2", "done"],
		["v2stop", "stopped"],
	] as const)
		it(`sweep over ACP v2 (${mode}): a turn that ends while reported background work runs ends ${finished}, never earlier`, async () => {
			const clean = await run([], mode);
			check(clean, finished);
			expect(clean.state).toBe(finished);
			const points: Fault[] = [
				...sweep(clean.commits),
				...(mode === "v2stop"
					? ([
							{ point: "harness:cancel-item", hit: 1, kind: "kill" },
							{ point: "harness:cancel-item", hit: 1, kind: "error" },
						] as const)
					: []),
			];
			await pool(
				2,
				points.map((fault) => async () => {
					const killed = await run([[fault]], mode);
					try {
						if (fault.kind === "kill") expect(killed.kills).toBe(1);
						check(killed, finished);
					} catch (error) {
						throw new Error(`${fault.kind} at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
					}
				}),
			);
		}, 600_000);
	it("sweep, a queued note: committed once, sent at most once, cancelled on restart", async () => {
		const clean = await run([], "note");
		check(clean);
		expect(clean.notes).toBe(1);
		const points: Fault[] = [
			...sweep(clean.commits),
			{ point: "harness:note", hit: 1, kind: "kill" },
			{ point: "harness:note", hit: 1, kind: "error" },
		];
		await pool(
			2,
			points.map((fault) => async () => {
				const killed = await run([[fault]], "note");
				check(killed);
				expect(killed.notes).toBeLessThanOrEqual(1);
				if (fault.kind === "kill") expect(killed.kills).toBe(1);
			}),
		);
	}, 600_000);
});

/** The sessions the worker seeds as a dead daemon's leftovers (test/fault/harness-run-worker.ts). */
const LEFT = { first: 999_997, second: 999_998, run: 999_999 };

type RunSummary = {
	run: number;
	chat: number;
	sessions: { [task: string]: { chat: number; state: string; ended: boolean } };
	woke: { [chat: string]: number[] };
	registered: boolean;
	turns: { chat: number; status: string }[];
	prompts: number;
	sent: string[];
	parked: unknown[];
	commits: number;
	models: number;
	reached: { [point: string]: number };
	trace: string[];
};

const runInRun = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/harness-run-worker.ts", [await tempHome()], schedules);
	return { ...(last as RunSummary), kills };
};

/**
 * A coding agent's session begun in a routine's run, and the sessions a dead daemon left, under kills: every session
 * ends once, each waking its agent exactly once in the chat it ran in (a left one as failed; the live one as done,
 * interrupted past its ask, or failed); the live one's ask reaches the harness at most once, and exactly once when it
 * finished; the run is one of its agent's chats only while a turn of it goes, so none at the end; every turn ended
 * completed; what each wake said reached the owner; nothing is parked.
 */
function checkRun(summary: RunSummary) {
	const { run, chat, sessions } = summary;
	const live = Object.keys(sessions)
		.map(Number)
		.filter((task) => !Object.values(LEFT).includes(task));
	expect(live, "the session begun in the run").toHaveLength(1);
	const session = sessions[String(live[0])]!;
	expect(session.chat).toBe(run);
	expect(["done", "interrupted", "failed"]).toContain(session.state);
	for (const task of Object.values(LEFT))
		expect(sessions[String(task)], `left session ${task}`).toMatchObject({ state: "failed", ended: true });
	expect(session.ended).toBe(true);
	expect(summary.prompts).toBeLessThanOrEqual(1);
	if (session.state === "done") expect(summary.prompts).toBe(1);
	// one wake per session, in the chat it ran in, however many processes ended them
	expect([...(summary.woke[String(chat)] ?? [])].sort(), "the agent's chat was told of").toEqual(
		[LEFT.first, LEFT.second].sort(),
	);
	expect([...(summary.woke[String(run)] ?? [])].sort(), "the run was told of").toEqual([LEFT.run, live[0]!].sort());
	expect(summary.registered, "the run among its agent's chats after its last turn").toBe(false);
	for (const turn of summary.turns) expect(turn.status, `a turn of chat ${turn.chat}`).toBe("completed");
	// the run's first turn, and one per wake there; one per wake in the agent's chat
	expect(summary.turns.filter((turn) => turn.chat === run)).toHaveLength(3);
	expect(summary.turns.filter((turn) => turn.chat === chat)).toHaveLength(2);
	// each wake told the owner (a send may repeat after a kill between it and its record: the turn suites own that)
	expect(summary.sent.filter((text) => text.includes("harness-result")).length).toBeGreaterThanOrEqual(4);
	expect(summary.parked).toEqual([]);
}

const told = (fault: Fault, killed: RunSummary & { kills: number }, clean: RunSummary) =>
	[
		`kills ${killed.kills}; the last process reached ${JSON.stringify(killed.reached)}; the run without faults ${JSON.stringify(clean.reached)}`,
		`sessions ${JSON.stringify(killed.sessions)}`,
		`woke ${JSON.stringify(killed.woke)}, registered ${killed.registered}, turns ${JSON.stringify(killed.turns)}`,
		`prompts ${killed.prompts}, parked ${JSON.stringify(killed.parked)}`,
		`scheduled ${fault.kind} at ${fault.point} #${fault.hit}; the last process's commits:`,
		...killed.trace.map((wrote, i) => `  #${i + 1} ${wrote}`),
	].join("\n");

describe("a coding agent's session in a routine's run, and a dead daemon's left sessions, under faults", () => {
	it("sweep: one kill at every commit, model request and harness boundary; every session ends once, waking its agent once", async () => {
		const clean = await runInRun([]);
		expect(clean.kills).toBe(0);
		checkRun(clean);
		expect(
			clean.sessions[
				String(
					Object.keys(clean.sessions)
						.map(Number)
						.find((task) => !Object.values(LEFT).includes(task)),
				)
			]?.state,
		).toBe("done");
		const faults: Fault[] = [
			{ point: "harness:spawn", hit: 1, kind: "kill" },
			{ point: "harness:prompted", hit: 1, kind: "kill" },
			{ point: "harness:update", hit: 1, kind: "kill" },
			{ point: "harness:spawn", hit: 1, kind: "error" },
			{ point: "harness:update", hit: 1, kind: "error" },
		];
		// past the run without faults' counts too: another run of the same scenario is a commit longer (`PAST`)
		for (let hit = 1; hit <= clean.commits + PAST; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		for (let hit = 1; hit <= clean.models + PAST; hit++) faults.push({ point: "model", hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const killed = await runInRun([[fault]]);
				try {
					// the kill landed, or the run ended before its hit and is a run without faults: never passed and not killed
					if (fault.kind === "kill") expect(unlanded(fault, killed)).toBeUndefined();
					checkRun(killed);
					// past the ask, a restart never sends it again
					if (fault.point === "harness:update" && fault.kind === "kill")
						expect(
							killed.sessions[
								String(
									Object.keys(killed.sessions)
										.map(Number)
										.find((task) => !Object.values(LEFT).includes(task)),
								)
							]?.state,
						).toBe("interrupted");
				} catch (error) {
					throw new Error(
						`${fault.kind} at ${fault.point} #${fault.hit}: ${(error as Error).message}\n${told(fault, killed, clean)}`,
					);
				}
			}),
		);
	}, 900_000);
});
