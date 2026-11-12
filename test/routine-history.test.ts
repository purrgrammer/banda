/**
 * A routine's history: each run the store records, from the commit that fired it to the one that ended it,
 * read back newest first a page at a time, with what it said read from its chat as the feed reads it, and its line
 * there only when the chat draws one.
 */
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Harness, type SetTimer } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { OWNER } from "../src/core/gateway.ts";
import { addRun, type RoutineRecord, Routines, RUNS_KEPT, routinePath, WAKE } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, Routes } from "../src/core/turn.ts";
import type { Item, RoutineRunView } from "../src/server/api.ts";
import { RUNS_PAGE, routineRuns, runSaid } from "../src/server/routines.ts";
import { runRows, runTime, runWords } from "../web/src/lib/routine-runs.ts";
import { FAUX_MODEL } from "./fixtures/models.ts";
import { blobStore, FakeGateway, tempHome, until } from "./helpers.ts";

const START = new Date(2026, 10, 2, 9, 0).getTime();
const MINUTE = 60_000;

describe("what a run left in its chat", () => {
	const spoke = (id: number, call: string, args: object, error = false): Item[] => [
		{ id, role: "assistant", text: "", calls: [{ id: call, name: "message_user", args: args as never }] },
		{ id: id + 1, role: "tool", call, name: "message_user", text: error ? "Not sent" : "Sent.", error },
	];

	it("says the first line of the first message that went through, and draws its line", () => {
		expect(runSaid(spoke(2, "a", { text: "  2 PRs need you\n#34 has red checks" }))).toEqual({
			said: "2 PRs need you",
			shown: true,
		});
		expect(runSaid([...spoke(2, "a", { text: "first" }), ...spoke(4, "b", { text: "second" })]).said).toBe("first");
		// a message that never reached the owner said nothing
		expect(runSaid(spoke(2, "a", { text: "lost" }, true))).toEqual({ shown: false });
		// a reaction alone says itself
		expect(runSaid(spoke(2, "a", { reaction: "👍" })).said).toBe("👍");
		// a long line is cut
		expect(runSaid(spoke(2, "a", { text: "x".repeat(300) })).said).toHaveLength(140);
	});

	it("a quiet run draws no line; a failed one draws its trouble", () => {
		expect(runSaid([{ id: 2, role: "assistant", text: "nothing to say" }])).toEqual({ shown: false });
		expect(runSaid([])).toEqual({ shown: false });
		expect(runSaid([{ id: 2, role: "assistant", text: "", error: "overloaded" }])).toEqual({ shown: true });
	});

	it("keeps a routine's newest runs, at most RUNS_KEPT", () => {
		const record: RoutineRecord = {};
		for (let i = 0; i < RUNS_KEPT + 7; i++) addRun(record, { at: i, skipped: "running" });
		expect(record.runs).toHaveLength(RUNS_KEPT);
		expect(record.runs?.[0]?.at).toBe(7);
		expect(record.runs?.at(-1)?.at).toBe(RUNS_KEPT + 6);
	});
});

describe("a routine's history from the store", () => {
	async function setup() {
		const home = await tempHome();
		const clock = { now: START };
		const setTimer: SetTimer = (callback, delay, { background }) => {
			const timer = setTimeout(callback, Math.max(0, Math.min(delay, 5)));
			if (background) timer.unref();
			return () => clearTimeout(timer);
		};
		const gateway = new FakeGateway();
		const core = defineCore({
			blobs: blobStore(),
			gateway: () => gateway,
			model: () => FAUX_MODEL,
			retryDelay: () => 5,
			now: () => clock.now,
			agentOrigin: (agent) => ({ gateway: "fake", peer: OWNER, thread: `agent:${agent}` }),
		});
		// each run does what `mode` says: speaks, stays quiet, fails, or hangs until released
		const state = { mode: "speak" as "speak" | "quiet" | "fail" | "hang", hold: Promise.resolve() };
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(
			Array.from({ length: 200 }, () => async (ctx: { messages: readonly { role: string }[] }) => {
				if (ctx.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("done");
				if (state.mode === "hang") await state.hold;
				if (state.mode === "fail") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
				if (state.mode === "quiet") return fauxAssistantMessage("nothing to say");
				return fauxAssistantMessage([fauxToolCall("message_user", { text: "Tea!\nWith lemon." })], {
					stopReason: "toolUse",
				});
			}) as never,
		);
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(home, {
			models,
			registry,
			now: () => clock.now,
			setTimer,
			settings: { retry: { maxRetries: 0 } },
		});
		harness.resume();
		const text = "---\ndescription: Tea\ncron: 0 16 * * *\n---\nSay tea.\n";
		await harness.commit(async (tx) => {
			(await tx.doc(Accepted)).files[routinePath("tea")] = { sha: shaOf(text), text, at: START };
			(await tx.doc(Routines)).routines.tea = { since: START };
		}, context);
		await core.reconcile(harness);
		/** Run it now as click `key`, a minute after the last, and wait for that run to end. */
		const run = async (key: string, wait = true) => {
			clock.now += MINUTE;
			expect(await core.runRoutine(harness, "tea", key)).toBe("ran");
			if (wait) await ended(harness);
		};
		return { harness, state, run };
	}

	const runsOf = async (harness: Harness) => (await harness.snapshot(Routines, context))?.routines.tea?.runs ?? [];
	const ended = (harness: Harness) =>
		until(async () => {
			const runs = await runsOf(harness);
			return runs.length > 0 && runs.every((run) => run.ended !== undefined || run.skipped !== undefined);
		});
	const wakeEntries = async (harness: Harness) => {
		const routes = (await harness.snapshot(Routes, context))?.routes ?? {};
		const found: { chat: number; entry: number }[] = [];
		for (const { chat } of Object.values(routes)) {
			const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
				{ order: "ascending" },
				1000,
				undefined,
				context,
			);
			for (const entry of page.items) if (entry.kind === WAKE) found.push({ chat, entry: Number(entry.id) });
		}
		return found;
	};

	it("says each run as it stands: running, said, quiet, failed; newest first, each said one opening its wake", async () => {
		const { harness, state, run } = await setup();
		let release = () => {};
		state.mode = "hang";
		state.hold = new Promise((resolve) => {
			release = resolve;
		});
		await run("hang", false);
		const live = await until(async () => (await routineRuns(harness, "tea", undefined))?.runs[0]);
		expect(["waiting", "running"]).toContain(live.state);
		expect(live.owner).toBe(true);
		expect(live.line).toBeUndefined();
		state.mode = "quiet";
		release();
		await ended(harness);

		state.mode = "speak";
		await run("speak");
		state.mode = "quiet";
		await run("quiet");
		state.mode = "fail";
		await run("fail");

		const page = await routineRuns(harness, "tea", undefined);
		const wakes = await wakeEntries(harness);
		expect(wakes).toHaveLength(4);
		expect(page?.earlier).toBeUndefined();
		const runs = page?.runs ?? [];
		expect(runs.map((each) => each.state)).toEqual(["failed", "quiet", "said", "quiet"]);
		expect(runs.map((each) => each.at)).toEqual([...runs.map((each) => each.at)].sort((a, b) => b - a));
		const [failed, quiet, said] = runs as [RoutineRunView, RoutineRunView, RoutineRunView];
		expect(said.said).toBe("Tea!");
		// a run that spoke opens its own wake in the chat; a quiet one opens nothing
		expect(said.line).toEqual(wakes[1]);
		expect(quiet.line).toBeUndefined();
		expect(failed.why).toMatch(/overloaded/);
		expect(failed.line).toEqual(wakes[3]);
		await harness.close(context);
	});

	it("reads back a page at a time, and nothing for a routine that is not there", async () => {
		const { harness } = await setup();
		await harness.commit(async (tx) => {
			const record = (await tx.doc(Routines)).routines.tea as RoutineRecord;
			for (let i = 1; i <= 23; i++) addRun(record, { at: START + i * MINUTE, skipped: i % 2 ? "running" : "limit" });
		}, context);
		const first = await routineRuns(harness, "tea", undefined);
		expect(first?.runs).toHaveLength(RUNS_PAGE);
		expect(first?.runs[0]).toEqual({ at: START + 23 * MINUTE, state: "skipped", skipped: "running" });
		const second = await routineRuns(harness, "tea", first?.earlier);
		expect(second?.runs[0]?.at).toBe(START + 13 * MINUTE);
		const third = await routineRuns(harness, "tea", second?.earlier);
		expect(third?.runs.map((each) => each.at)).toEqual([START + 3 * MINUTE, START + 2 * MINUTE, START + MINUTE]);
		expect(third?.earlier).toBeUndefined();
		expect(await routineRuns(harness, "coffee", undefined)).toBeUndefined();
		await expect(routineRuns(harness, "../x", undefined)).rejects.toThrow(/not a routine's name/);
		await harness.close(context);
	});
});

describe("a routine's runs in its detail", () => {
	const now = new Date(2026, 10, 12, 9, 0).getTime();
	const day = 86_400_000;

	it("each run says what came of it in words, never by colour alone", () => {
		const words = (run: Omit<RoutineRunView, "at">) => runWords({ at: now, ...run }, "Mara").words;
		expect(words({ state: "said", said: "2 PRs need you" })).toBe("Said: 2 PRs need you");
		expect(words({ state: "quiet" })).toBe("Said nothing");
		expect(words({ state: "failed", why: "the run stalled" })).toBe("Failed: the run stalled");
		// a provider's raw error reads as the feed says it
		expect(words({ state: "failed", why: "overloaded" })).toMatch(/^Failed: the model provider is busy/);
		expect(
			words({
				state: "failed",
				why: 'model_error: {"error":{"code":400,"message":"API key not valid. Please pass a valid API key."}}',
			}),
		).toMatch(/^Failed: the model provider refused its key/);
		expect(words({ state: "failed", why: 'model_error: {"error":{"message":"Something odd"}}' })).toBe(
			"Failed: Something odd",
		);
		expect(words({ state: "running" })).toBe("Running now");
		expect(words({ state: "waiting" })).toBe("Waiting its turn in the chat");
		expect(words({ state: "stopped" })).toBe("Stopped before it finished");
		expect(words({ state: "skipped", skipped: "running" })).toBe("Skipped: its last run was still going");
		expect(words({ state: "skipped", skipped: "inactive" })).toBe("Skipped: Mara wasn't active");
		expect(words({ state: "skipped", skipped: "limit" })).toMatch(/^Paused itself/);
	});

	it("only a run whose line is in the chat beside the panel opens it", () => {
		const opened: [number, number][] = [];
		const rows = runRows(
			[
				{ at: now - 60_000, state: "said", said: "hi", line: { chat: 12, entry: 40 } },
				{ at: now - 2 * day, state: "quiet" },
				{ at: now - 3 * day, state: "failed", why: "x", line: { chat: 12, entry: 30 } },
				{ at: now - 4 * day, state: "said", said: "elsewhere", line: { chat: 99, entry: 9 } },
				{ at: now - 8 * day, state: "quiet", owner: true },
			],
			now,
			"Mara",
			12,
			(run, entry) => opened.push([run.at, entry]),
		);
		expect(rows.map((row) => row.onOpen !== undefined)).toEqual([true, false, true, false, false]);
		expect(rows.map((row) => row.tone)).toEqual(["said", "quiet", "trouble", "said", "quiet"]);
		rows[0]?.onOpen?.();
		rows[2]?.onOpen?.();
		expect(opened).toEqual([
			[now - 60_000, 40],
			[now - 3 * day, 30],
		]);
		expect(rows[4]?.when).toMatch(/· you ran it$/);
	});

	it("says when in the owner's words: today, yesterday, a weekday this week, a date before", () => {
		expect(runTime(now - 60 * 60_000, now)).toMatch(/^Today /);
		expect(runTime(now - day, now)).toMatch(/^Yesterday /);
		expect(runTime(now - 3 * day, now)).toBe(
			`${new Date(now - 3 * day).toLocaleDateString([], { weekday: "short" })} ${new Date(now - 3 * day).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
		);
		expect(runTime(now - 10 * day, now)).not.toMatch(/^(Today|Yesterday)/);
	});
});
