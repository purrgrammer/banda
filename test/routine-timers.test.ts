import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, type Harness, type SetTimer } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ActivityLog } from "../src/core/activity.ts";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { pause, pauseRoutine, resume } from "../src/core/control.ts";
import { OWNER } from "../src/core/gateway.ts";
import { Control, parseRoutine, Routines, routinePath, TROUBLE, type TroubleData, WAKE } from "../src/core/routines.ts";
import { hostZone, nextDue, parseAt, parseCron, whenWords } from "../src/core/schedule.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, Routes } from "../src/core/turn.ts";
import { chats } from "../src/server/transcript.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const MINUTE = 60_000;
const START = new Date(2026, 10, 2, 8, 0).getTime();

describe("Routine files", () => {
	it("parses a timer, a one-time routine and a cron schedule", () => {
		const every = parseRoutine("tea", "---\ndescription: Tea time\nevery: 2h\n---\nRemind me to drink tea.\n");
		expect(every).toEqual({
			routine: {
				name: "tea",
				description: "Tea time",
				when: { every: 2 * 60 * MINUTE },
				runsADay: 24,
				ask: "Remind me to drink tea.",
			},
		});
		const once = parseRoutine("call", "---\ndescription: Call\nat: 2026-11-03 09:30\n---\nCall mum.");
		expect("routine" in once && once.routine.when).toEqual({
			at: new Date(2026, 10, 3, 9, 30).getTime(),
			zone: hostZone(),
		});
		const cron = parseRoutine(
			"standup",
			"---\ndescription: Standup\ncron: 0 9 * * 1-5\nruns_a_day: 2\n---\nPrep notes.",
		);
		expect("routine" in cron && cron.routine).toMatchObject({ when: { cron: "0 9 * * 1-5" }, runsADay: 2 });
	});

	it("says what is wrong, each problem with what to write instead", () => {
		const errors = (text: string) => {
			const parsed = parseRoutine("x", text);
			return "errors" in parsed ? parsed.errors.join("\n") : "";
		};
		expect(errors("no frontmatter")).toMatch(/starts with its frontmatter/);
		expect(errors("---\nevery: 1d\n---\nask")).toMatch(/description/);
		expect(errors("---\ndescription: d\n---\nask")).toMatch(/say when it runs/);
		expect(errors("---\ndescription: d\nevery: 1d\nat: 2026-11-03 09:00\n---\nask")).toMatch(/one of/);
		expect(errors("---\ndescription: d\nevery: 10s\n---\nask")).toMatch(/not a period/);
		expect(errors("---\ndescription: d\ncron: 61 * * * *\n---\nask")).toMatch(/not a schedule/);
		expect(errors("---\ndescription: d\nevery: 1d\n---\n")).toMatch(/what to do/);
		expect(errors("---\ndescription: d\nevery: 1d\nruns_a_day: 0\n---\nask")).toMatch(/runs_a_day/);
		expect(errors("---\ndescription: d\nevery: 1d\nbudget: 5\n---\nask")).toMatch(/"budget" is not a field/);
		expect(errors("---\ndescription: d\nevery: 1d\nwatch: ls\n---\nask")).toMatch(/"watch" is not a field/);
		expect(errors("---\ndescription: d\nevery: 1d\nmodel: x\n---\nask")).toMatch(/not a field/);
	});

	it("says its schedule in words", () => {
		expect(whenWords({ every: 30 * MINUTE })).toBe("Every 30 minutes");
		expect(whenWords({ every: 24 * 60 * MINUTE })).toBe("Every day");
		expect(whenWords({ cron: "30 8 * * 1-5" })).toBe("Weekdays at 08:30");
		expect(whenWords({ cron: "0 9 * * *" })).toBe("Every day at 09:00");
		expect(whenWords({ cron: "0 18 * * 5" })).toBe("Every Friday at 18:00");
		expect(whenWords({ cron: "*/15 * * * *" })).toBe("Every 15 minutes");
		expect(whenWords({ cron: "0 9 1,15 * *" })).toBe("On its own schedule");
	});
});

describe("schedules", () => {
	it("every: counts from when it was allowed", () => {
		expect(nextDue({ every: 10 * MINUTE }, START, START)).toBe(START + 10 * MINUTE);
		expect(nextDue({ every: 10 * MINUTE }, START + 25 * MINUTE, START)).toBe(START + 30 * MINUTE);
	});

	it("at: once, then never", () => {
		const at = parseAt("2026-11-02 09:00") ?? 0;
		expect(nextDue({ at }, START, START)).toBe(at);
		expect(nextDue({ at }, at, START)).toBeUndefined();
		expect(parseAt("2026-02-30 09:00")).toBeUndefined();
	});

	it("cron: weekdays at 09:00 skip the weekend", () => {
		// Friday 6 Nov 2026, 10:00: next is Monday 9 Nov, 09:00
		const friday = new Date(2026, 10, 6, 10, 0).getTime();
		expect(nextDue({ cron: "0 9 * * 1-5" }, friday, START)).toBe(new Date(2026, 10, 9, 9, 0).getTime());
		expect(parseCron("0 9 * *")).toBeUndefined();
	});

	it("property: the next due time is after the given time, matches the schedule, and none comes between", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("*/7 * * * *", "0 9 * * 1-5", "15,45 8-10 * * *", "0 0 1 * *", "30 12 * * 0"),
				fc.integer({ min: 0, max: 400 * 24 * 60 }),
				(cron, minutes) => {
					const after = START + minutes * MINUTE;
					const due = nextDue({ cron }, after, START);
					expect(due).toBeDefined();
					expect(due).toBeGreaterThan(after);
					const step = nextDue({ cron }, (due ?? 0) - MINUTE, START);
					expect(step).toBe(due);
				},
			),
			{ numRuns: pbtRuns(100) },
		);
	});
});

/** A clock tests move by hand, and timers that look at it often, so a sleep ends soon after the clock passes it. */
function testClock(start = START) {
	const clock = { now: start };
	const setTimer: SetTimer = (callback, delay, { background }) => {
		const timer = setTimeout(callback, Math.max(0, Math.min(delay, 5)));
		if (background) timer.unref();
		return () => clearTimeout(timer);
	};
	return { clock, now: () => clock.now, setTimer };
}

function setup(home: string, models: ReturnType<typeof createModels> = echoModels().models) {
	const gateway = new FakeGateway();
	const time = testClock();
	const core = defineCore({
		blobs: blobStore(),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
		now: time.now,
		agentOrigin: (agent) => ({ gateway: "fake", peer: OWNER, thread: `agent:${agent}` }),
	});
	const open = async () => {
		const registry = createRegistry();
		registry.install(core.extension);
		// a failed request fails its run at once
		const harness = await openStore(home, {
			models,
			registry,
			now: time.now,
			setTimer: time.setTimer,
			settings: { retry: { maxRetries: 0 } },
		});
		harness.resume();
		await core.reconcile(harness);
		return harness;
	};
	/** Accept `text` as routine `name`, as the owner would, and let its task follow. */
	const allow = async (harness: Harness, name: string, text: string) => {
		await harness.commit(async (tx) => {
			(await tx.doc(Accepted)).files[routinePath(name)] = { sha: shaOf(text), text, at: time.now() };
		}, context);
		await core.reconcile(harness);
	};
	return { gateway, core, open, allow, clock: time.clock };
}

const wakes = async (harness: Harness) => {
	const routes: Record<string, { chat: number }> = (await harness.snapshot(Routes, context))?.routes ?? {};
	const found: { routine: string; due: number }[] = [];
	for (const { chat } of Object.values(routes)) {
		const page = await (await harness.conversation(chat as never, context))!.entries(
			{ order: "ascending" },
			1000,
			undefined,
			context,
		);
		for (const entry of page.items) if (entry.kind === WAKE) found.push(entry.data as { routine: string; due: number });
	}
	return found;
};

/** Every routine's trouble its chats were told, with the chat it went to. */
const troubles = async (harness: Harness) => {
	const routes: Record<string, { chat: number }> = (await harness.snapshot(Routes, context))?.routes ?? {};
	const found: (TroubleData & { chat: number })[] = [];
	for (const { chat } of Object.values(routes)) {
		const page = await (await harness.conversation(chat as never, context))!.entries(
			{ order: "ascending" },
			1000,
			undefined,
			context,
		);
		for (const entry of page.items)
			if (entry.kind === TROUBLE) found.push({ ...(entry.data as unknown as TroubleData), chat });
	}
	return found;
};

const activity = async (harness: Harness, routine: string) =>
	((await harness.snapshot(ActivityLog, context))?.events ?? [])
		.filter((event) => event.routine === routine)
		.map((e) => e.what);

const idle = (harness: Harness) =>
	until(async () => {
		const graph = await harness.taskGraph(context);
		const busy = Object.values(graph.value.tasks).some((task) => task.kind !== "banda.routine");
		graph.dispose();
		return !busy;
	});

describe("Routines", () => {
	it("fires at its due time into its agent's one chat, and what its run says is sent", async () => {
		const home = await tempHome();
		const s = setup(home);
		const harness = await s.open();
		await s.allow(harness, "tea", "---\ndescription: Tea time\nevery: 10m\n---\nRemind me to drink tea.");
		await new Promise((r) => setTimeout(r, 50));
		expect(await wakes(harness)).toEqual([]);
		s.clock.now += 10 * MINUTE;
		await until(async () => (await wakes(harness)).length === 1);
		await idle(harness);
		expect(await wakes(harness)).toEqual([{ routine: "tea", due: START + 10 * MINUTE, description: "Tea time" }]);
		await until(() => s.gateway.sent.length === 1);
		expect(s.gateway.sent[0]?.out.text).toMatch(/^re: Your routine "tea" was due at/);
		// one chat, the lead's, at its home: never one of the routine's own
		const routes = (await harness.snapshot(Routes, context))?.routes ?? {};
		expect(Object.keys(routes)).toEqual([JSON.stringify(["fake", OWNER, "agent:sancho"])]);
		await harness.close(context);
	});

	it.each(["runs_a_day"])("a routine that ran its most times a day (%s) pauses alone and says so", async (key) => {
		const home = await tempHome();
		const s = setup(home);
		const harness = await s.open();
		await s.allow(harness, "often", `---\ndescription: Often\nevery: 1m\n${key}: 2\n---\nGo.`);
		await s.allow(harness, "other", "---\ndescription: Other\nevery: 1d\n---\nGo.");
		for (let i = 1; i <= 2; i++) {
			s.clock.now += MINUTE;
			await until(async () => (await wakes(harness)).length === i);
			await idle(harness);
		}
		s.clock.now += MINUTE;
		await until(async () => (await harness.snapshot(Routines, context))?.routines.often?.paused === "limit");
		expect(await activity(harness, "often")).toContain("paused: it ran the most times a day it may");
		// its chat is told, once, and that counts as unread; its quiet runs did not
		expect((await troubles(harness)).map(({ routine, trouble }) => [routine, trouble])).toEqual([["often", "limit"]]);
		expect((await troubles(harness))[0]).toMatchObject({ runsADay: 2, description: "Often", at: s.clock.now });
		const { routines } = (await harness.snapshot(Routines, context))!;
		expect(routines.often?.task).toBeUndefined();
		expect(routines.other?.task).toBeDefined();
		// the owner resumes it, and it runs again
		await pauseRoutine(harness, s.core.reconcile, "often", false, s.clock.now);
		s.clock.now += MINUTE;
		await until(async () => (await wakes(harness)).length === 3);
		await harness.close(context);
	});

	it("a run that fails, and a due time skipped while the last run still goes, each tell its chat once", async () => {
		const home = await tempHome();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		faux.setResponses(
			Array.from({ length: 50 }, () => async (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
				const last = JSON.stringify(ctx.messages.at(-1)?.content ?? "");
				if (last.includes("FAIL")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
				if (last.includes("HANG")) await held;
				// a quiet run: nothing worth saying
				return fauxAssistantMessage("nothing to say");
			}),
		);
		const s = setup(home, models);
		const harness = await s.open();
		// one chat answers one run at a time: the failing routine first, alone
		await s.allow(harness, "flaky", "---\ndescription: Flaky check\nevery: 10m\n---\nFAIL now.");
		s.clock.now += 10 * MINUTE;
		await until(async () => (await troubles(harness)).some((each) => each.trouble === "failed"));
		await idle(harness);
		await harness.commit(async (tx) => {
			delete (await tx.doc(Accepted)).files[routinePath("flaky")];
		}, context);
		await s.core.reconcile(harness);
		await s.allow(harness, "slow", "---\ndescription: Slow check\nevery: 10m\n---\nHANG a while.");
		s.clock.now += 10 * MINUTE;
		await until(async () => (await wakes(harness)).some((each) => each.routine === "slow"));
		// its first run still goes at its next due time: that one is skipped, and said
		s.clock.now += 10 * MINUTE;
		await until(async () => (await troubles(harness)).some((each) => each.trouble === "stalled"));
		s.clock.now += 10 * MINUTE;
		await new Promise((r) => setTimeout(r, 100));
		// skipped, never fired beside the run still going
		expect((await wakes(harness)).filter((each) => each.routine === "slow")).toHaveLength(1);
		release();
		await idle(harness);
		const told = await troubles(harness);
		expect(told.filter((each) => each.routine === "slow")).toEqual([
			expect.objectContaining({ trouble: "stalled", due: START + 30 * MINUTE, description: "Slow check" }),
		]);
		expect(told.filter((each) => each.routine === "flaky").map((each) => each.trouble)).toEqual(
			expect.arrayContaining(["failed"]),
		);
		expect(told.find((each) => each.routine === "flaky")).toMatchObject({ why: expect.stringMatching(/overloaded/) });
		expect((await harness.snapshot(Routines, context))?.routines.flaky?.failed).toBeDefined();
		// both woke the lead's one chat, whose unread is its trouble alone: the quiet runs left none
		const [row, ...others] = await chats(harness, context);
		expect(others).toEqual([]);
		expect(row?.unread).toBe(told.length);
		expect(row?.excerpt).toMatch(/^Routine "(Slow|Flaky) check"/);
		await harness.close(context);
	});

	it("Pause stops every run and every routine; on resume, the due times missed come as one wake", async () => {
		const home = await tempHome();
		const s = setup(home);
		const harness = await s.open();
		await s.allow(harness, "tea", "---\ndescription: Tea\nevery: 10m\n---\nGo.");
		await pause(harness, s.core.reconcile, s.clock.now);
		expect((await harness.snapshot(Control, context))?.paused).toBe(START);
		s.clock.now += 35 * MINUTE;
		await new Promise((r) => setTimeout(r, 100));
		expect(await wakes(harness)).toEqual([]);
		const graph = await harness.taskGraph(context);
		expect(Object.values(graph.value.tasks).filter((task) => task.kind === "banda.routine")).toEqual([]);
		graph.dispose();
		await resume(harness, s.core.reconcile, s.clock.now);
		await until(async () => (await wakes(harness)).length === 1);
		await idle(harness);
		await new Promise((r) => setTimeout(r, 100));
		expect(await wakes(harness)).toEqual([{ routine: "tea", due: START + 10 * MINUTE, description: "Tea" }]);
		// and the next due time is the first one still to come
		s.clock.now += 5 * MINUTE;
		await until(async () => (await wakes(harness)).length === 2);
		expect((await wakes(harness))[1]?.due).toBe(START + 40 * MINUTE);
		await harness.close(context);
	});

	it("a removed routine's task goes; a changed one runs on its new schedule", async () => {
		const home = await tempHome();
		const s = setup(home);
		const harness = await s.open();
		await s.allow(harness, "tea", "---\ndescription: Tea\nevery: 1d\n---\nGo.");
		const first = (await harness.snapshot(Routines, context))?.routines.tea?.task;
		await s.allow(harness, "tea", "---\ndescription: Tea\nevery: 5m\n---\nGo.");
		const second = (await harness.snapshot(Routines, context))?.routines.tea?.task;
		expect(second).not.toBe(first);
		expect((await harness.getTask(first as never, context))?.state.status).toBe("terminal");
		s.clock.now += 5 * MINUTE;
		await until(async () => (await wakes(harness)).length === 1);
		await harness.commit(async (tx) => {
			delete (await tx.doc(Accepted)).files[routinePath("tea")];
		}, context);
		await s.core.reconcile(harness);
		expect((await harness.snapshot(Routines, context))?.routines.tea?.task).toBeUndefined();
		await harness.close(context);
	});
});

describe("Pause", () => {
	it("property: while paused nothing runs and no routine fires; on resume each routine fires at most once for what it missed", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 3 }),
				fc.integer({ min: 0, max: 4 }),
				fc.integer({ min: 1, max: 12 }),
				fc.boolean(),
				async (periods, before, during, talking) => {
					const home = await tempHome();
					const s = setup(home);
					const harness = await s.open();
					for (const [i, minutes] of periods.entries())
						await s.allow(harness, `routine-${i}`, `---\ndescription: Routine ${i}\nevery: ${minutes}m\n---\nGo.`);
					for (let step = 0; step < before; step++) {
						s.clock.now += MINUTE;
						await new Promise((r) => setTimeout(r, 20));
						await idle(harness);
					}
					// the owner's message may be at work when they pause
					if (talking)
						await s.core.receive(harness, { id: "m1", origin: { gateway: "fake", peer: OWNER }, text: "hi" });
					await pause(harness, s.core.reconcile, s.clock.now);
					const live = async () => {
						const graph = await harness.taskGraph(context);
						const tasks = Object.values(graph.value.tasks).filter(
							(task) => !task.background || task.kind === "banda.routine",
						);
						graph.dispose();
						return tasks;
					};
					await until(async () => (await live()).length === 0);
					const count = async (routine: string) =>
						(await wakes(harness)).filter((wake) => wake.routine === routine).length;
					const fired = await Promise.all(periods.map((_, i) => count(`routine-${i}`)));
					for (let step = 0; step < during; step++) {
						s.clock.now += MINUTE;
						await new Promise((r) => setTimeout(r, 10));
						expect(await live()).toEqual([]);
					}
					expect(await Promise.all(periods.map((_, i) => count(`routine-${i}`)))).toEqual(fired);
					await resume(harness, s.core.reconcile, s.clock.now);
					await new Promise((r) => setTimeout(r, 50));
					await idle(harness);
					for (const [i] of periods.entries())
						expect(
							(await count(`routine-${i}`)) - (fired[i] ?? 0),
							`routine-${i}'s wakes after the resume`,
						).toBeLessThanOrEqual(1);
					const { routines } = (await harness.snapshot(Routines, context)) ?? { routines: {} };
					expect(Object.values(routines).every((record) => record.task !== undefined)).toBe(true);
					await harness.close(context);
				},
			),
			{ numRuns: pbtRuns(8) },
		);
	}, 120_000);
});
