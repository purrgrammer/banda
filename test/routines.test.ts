import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AssistantMessage,
	createModels,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Harness, type SetTimer } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { OWNER } from "../src/core/gateway.ts";
import {
	parseRoutine,
	RoutineRefused,
	Routines,
	routinePath,
	WAKE,
	type WakeData,
	withWhen,
} from "../src/core/routines.ts";
import {
	hostZone,
	localTime,
	nextDue,
	nextRuns,
	parseAt,
	parseSchedule,
	pickOf,
	pickSchedule,
	type SchedulePick,
	scheduleText,
	type When,
	whenWords,
	zoneWords,
} from "../src/core/schedule.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, Routes } from "../src/core/turn.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ChatRow, ControlView, Item } from "../src/server/api.ts";
import { view } from "../web/src/lib/chat.ts";
import { routineWords } from "../web/src/lib/segments/routines.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { FAUX_MODEL } from "./fixtures/models.ts";
import { blobStore, FakeGateway, tempHome, until, whenAsked } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Time zones with and without daylight saving, one with a half-hour shift and one south of the equator. */
const ZONES = ["UTC", "Europe/Lisbon", "America/New_York", "Australia/Lord_Howe", "Asia/Kolkata", "America/Santiago"];
const TZ = process.env.TZ;
afterEach(() => {
	if (TZ === undefined) delete process.env.TZ;
	else process.env.TZ = TZ;
});

/** Any minute from 2026 to 2028, so daylight saving's changes in every zone come up. */
const anyTime = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2028, 11, 31) }).map((ms) => ms - (ms % MINUTE));
const anyClock = fc
	.record({ hour: fc.integer({ min: 0, max: 23 }), minute: fc.integer({ min: 0, max: 59 }) })
	.map(({ hour, minute }) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
const anyPick: fc.Arbitrary<SchedulePick> = fc.oneof(
	anyClock.map((time) => ({ kind: "daily" as const, time })),
	anyClock.map((time) => ({ kind: "weekdays" as const, time })),
	fc
		.record({
			days: fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 }),
			time: anyClock,
		})
		.map(({ days, time }) => ({ kind: "weekly" as const, days: [...days].sort((a, b) => a - b), time })),
	fc.integer({ min: 1, max: 168 }).map((hours) => ({ kind: "hours" as const, hours })),
);

/** The local calendar day of `ms`, as a number that counts days. */
const dayOf = (ms: number) => {
	const d = new Date(ms);
	return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
};

describe("the schedule picker's presets", () => {
	it("each preset says itself in words and comes back as itself", () => {
		expect(pickSchedule({ kind: "daily", time: "08:00" })).toEqual({ text: "cron 0 8 * * *" });
		expect(pickSchedule({ kind: "weekdays", time: "07:30" })).toEqual({ text: "cron 30 7 * * 1-5" });
		expect(pickSchedule({ kind: "weekly", days: [4, 1], time: "18:05" })).toEqual({ text: "cron 5 18 * * 1,4" });
		expect(pickSchedule({ kind: "hours", hours: 4 })).toEqual({ text: "every 4h" });
		expect(pickSchedule({ kind: "once", at: "2026-11-02T09:00" })).toEqual({ text: "at 2026-11-02 09:00" });
		expect(pickSchedule({ kind: "custom", text: "45m" })).toEqual({ text: "every 45m" });
		expect(pickSchedule({ kind: "custom", text: " 0  9 1,15 * * " })).toEqual({ text: "cron 0 9 1,15 * *" });
		expect(pickSchedule({ kind: "daily", time: "8" })).toEqual({ error: "Pick a time, such as 08:00." });
		expect(pickSchedule({ kind: "weekly", days: [], time: "08:00" })).toEqual({ error: "Pick at least one day." });
		expect(pickSchedule({ kind: "custom", text: "soon" })).toMatchObject({ error: expect.stringMatching(/cron|45m/) });
		const words = (pick: SchedulePick) => whenWords(parseSchedule((pickSchedule(pick) as { text: string }).text)!);
		expect(words({ kind: "daily", time: "08:00" })).toBe("Every day at 08:00");
		expect(words({ kind: "weekdays", time: "08:00" })).toBe("Weekdays at 08:00");
		expect(words({ kind: "weekly", days: [1, 4], time: "08:00" })).toBe("Mondays and Thursdays at 08:00");
		expect(words({ kind: "weekly", days: [0, 3, 5], time: "08:00" })).toBe("Sundays, Wednesdays and Fridays at 08:00");
		expect(words({ kind: "hours", hours: 4 })).toBe("Every 4 hours");
	});

	it("property: a preset is said in plain words, and the picker opens on the preset it saved", () => {
		fc.assert(
			fc.property(anyPick, (pick) => {
				const saved = pickSchedule(pick);
				if (!("text" in saved)) throw new Error(saved.error);
				const when = parseSchedule(saved.text);
				expect(when).toBeDefined();
				expect(whenWords(when as When)).not.toBe("On its own schedule");
				expect(scheduleText(when as When)).toBe(saved.text);
				const reopened = pickOf(when as When);
				// it opens on what it saved: the same pick, or (Monday to Friday, every day) the preset that says it shorter
				expect(pickSchedule(reopened)).toEqual(saved);
				const short = pick.kind === "weekly" && (pick.days.length === 7 || pick.days.join(",") === "1,2,3,4,5");
				if (!short) expect(reopened).toEqual(pick);
			}),
			{ numRuns: pbtRuns(200) },
		);
	});
});

describe("next runs", () => {
	it("property: in any time zone, across daylight saving, the next runs come in order and keep to the schedule", () => {
		fc.assert(
			fc.property(fc.constantFrom(...ZONES), anyPick, anyTime, (zone, pick, after) => {
				process.env.TZ = zone;
				const when = parseSchedule((pickSchedule(pick) as { text: string }).text) as When;
				const runs = nextRuns(when, after, after, 8);
				expect(runs).toHaveLength(8);
				for (const [i, run] of runs.entries()) {
					const before = i === 0 ? after : (runs[i - 1] as number);
					expect(run).toBeGreaterThan(before);
					// none comes between: each is the next due time after the one before
					expect(nextDue(when, before, after)).toBe(run);
				}
				if (pick.kind === "hours") {
					// a period counts real hours, whatever the clock on the wall does
					for (const [i, run] of runs.entries())
						expect(run - (i === 0 ? after : (runs[i - 1] as number))).toBe(pick.hours * HOUR);
					return;
				}
				if (pick.kind !== "daily" && pick.kind !== "weekdays" && pick.kind !== "weekly")
					throw new Error("a timed pick");
				const [hour, minute] = pick.time.split(":").map(Number) as [number, number];
				const days =
					pick.kind === "daily" ? [0, 1, 2, 3, 4, 5, 6] : pick.kind === "weekdays" ? [1, 2, 3, 4, 5] : pick.days;
				for (const run of runs) {
					const at = new Date(run);
					expect(days, `${new Date(run).toString()} is on a day it runs`).toContain(at.getDay());
					// at its time, or, on the day the clock skips that time, the moment the clock lands on instead
					const wall = new Date(at.getFullYear(), at.getMonth(), at.getDate(), hour, minute).getTime();
					expect(run).toBe(wall);
				}
				// once a day at most: the clock going back an hour never runs it twice
				expect(new Set(runs.map(dayOf)).size).toBe(runs.length);
				if (pick.kind === "daily")
					// and never skips a day, the clock going forward neither
					for (const [i, run] of runs.slice(1).entries()) expect(dayOf(run) - dayOf(runs[i] as number)).toBe(1);
			}),
			{ numRuns: pbtRuns(300) },
		);
	});

	it("a routine at 01:30 runs once on the night the clock goes back, and on the night it goes forward", () => {
		process.env.TZ = "Europe/Lisbon";
		const when = { cron: "30 1 * * *" };
		// Sunday 25 October 2026, 02:00 back to 01:00; Sunday 29 March 2026, 01:00 forward to 02:00
		const back = nextRuns(when, new Date(2026, 9, 24, 12, 0).getTime(), 0, 3);
		expect(back.map((ms) => new Date(ms).toString().slice(4, 21))).toEqual([
			"Oct 25 2026 01:30",
			"Oct 26 2026 01:30",
			"Oct 27 2026 01:30",
		]);
		const forward = nextRuns(when, new Date(2026, 2, 28, 12, 0).getTime(), 0, 2);
		expect(forward.map((ms) => new Date(ms).toString().slice(4, 21))).toEqual([
			"Mar 29 2026 02:30",
			"Mar 30 2026 01:30",
		]);
	});

	it("a one-time routine has one next run, then none; `until` cuts the week", () => {
		const at = new Date(2026, 10, 3, 9, 0).getTime();
		expect(nextRuns({ at }, at - DAY, 0)).toEqual([at]);
		expect(nextRuns({ at }, at, 0)).toEqual([]);
		const start = new Date(2026, 10, 2, 0, 0).getTime();
		expect(nextRuns({ every: 4 * HOUR }, start, start, 100, start + DAY)).toHaveLength(6);
	});
});

describe("a routine's time zone", () => {
	const weather = (zone?: string) =>
		`---\ndescription: Weather in Lisbon\ncron: 0 8 * * 1-5\n${zone === undefined ? "" : `zone: ${zone}\n`}---\nSay the weather.\n`;

	it("a routine for Lisbon runs at 08:00 in Lisbon, on a computer in Madrid, and says so", () => {
		process.env.TZ = "Europe/Madrid";
		const thursday = Date.UTC(2026, 10, 5, 12, 0);
		const lisbon = parseRoutine("weather", weather("Europe/Lisbon"));
		if (!("routine" in lisbon)) throw new Error(lisbon.errors.join("; "));
		expect(whenWords(lisbon.routine.when)).toBe("Weekdays at 08:00, Lisbon time");
		// Friday 6 November, 08:00 in Lisbon (UTC+0 in winter), 09:00 in Madrid
		expect(nextDue(lisbon.routine.when, thursday, 0)).toBe(Date.UTC(2026, 10, 6, 8, 0));
		// without a zone it keeps the computer's wall, and says whose that is
		const local = parseRoutine("weather", weather());
		if (!("routine" in local)) throw new Error(local.errors.join("; "));
		expect(whenWords(local.routine.when)).toBe("Weekdays at 08:00, Madrid time");
		expect(nextDue(local.routine.when, thursday, 0)).toBe(Date.UTC(2026, 10, 6, 7, 0));
		expect(parseRoutine("weather", weather("Lisbon"))).toEqual({
			errors: ['"zone: Lisbon" is not a time zone: write an IANA name, such as Europe/Lisbon'],
		});
	});

	it("a time once is read on its zone's wall, and one the clock skips is refused", () => {
		process.env.TZ = "Asia/Kolkata";
		expect(parseAt("2026-11-06 08:00", "Europe/Lisbon")).toBe(Date.UTC(2026, 10, 6, 8, 0));
		expect(parseAt("2026-07-06 08:00", "Europe/Lisbon")).toBe(Date.UTC(2026, 6, 6, 7, 0));
		expect(localTime(Date.UTC(2026, 6, 6, 7, 0), "Europe/Lisbon")).toBe("2026-07-06 08:00");
		// Lisbon's clock goes from 01:00 to 02:00 on 29 March 2026
		expect(parseAt("2026-03-29 01:30", "Europe/Lisbon")).toBeUndefined();
		expect(parseAt("2026-02-30 08:00", "Europe/Lisbon")).toBeUndefined();
	});

	it("property: a routine in a zone runs exactly when it would on a computer in that zone, wherever it runs", () => {
		fc.assert(
			fc.property(fc.constantFrom(...ZONES), fc.constantFrom(...ZONES), anyPick, anyTime, (host, zone, pick, after) => {
				const text = (pickSchedule(pick) as { text: string }).text;
				process.env.TZ = zone;
				const there = nextRuns(parseSchedule(text) as When, after, after, 5);
				process.env.TZ = host;
				const zoned = parseSchedule(text, zone) as When;
				expect(nextRuns(zoned, after, after, 5)).toEqual(there);
				expect(scheduleText(zoned)).toBe(text);
			}),
			{ numRuns: pbtRuns(200) },
		);
	});

	it("the agent names the place's zone; the card says it; the owner's edit and the panel keep to a wall", async () => {
		const told = whenAsked(fauxAssistantMessage("Asked them to allow it."));
		const asks = [
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "schedule", limit: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall(
						"schedule",
						{
							name: "weather",
							description: "Weather in Lisbon",
							cron: "0 8 * * 1-5",
							zone: "Europe/Lisbon",
							ask: "Tell the owner the weather in Lisbon.",
						},
						{ id: "c1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			told.response,
		];
		const { home, daemon: started, api, post } = await daemon(asks);
		try {
			await post("/messages", { id: randomUUID(), thread: randomUUID(), text: "Every weekday at 8, the weather" });
			const file = join(home, "workspace", "routines", "weather.md");
			// `schedule` returned: the file is whole
			await told.asked;
			expect(await readFile(file, "utf8")).toContain("cron: 0 8 * * 1-5\nzone: Europe/Lisbon\n");
			const waiting = await until(async () =>
				(await api<ControlView>("/control")).routines.find((each) => each.name === "weather" && each.change),
			);
			// the card says whose wall its time is on
			expect(waiting.change).toMatchObject({
				routine: { when: "Weekdays at 08:00, Lisbon time", zone: "Europe/Lisbon" },
			});
			const sha = (waiting.change as { sha: string }).sha;
			const allowed = await post<ControlView>("/routines/weather/accept", { sha });
			const runs = allowed.routines.find((each) => each.name === "weather")?.nextRuns ?? [];
			expect(runs.map((at) => localTime(at, "Europe/Lisbon").slice(11))).toEqual(["08:00", "08:00", "08:00"]);

			// the owner moves it: its time is still Lisbon's
			const moved = await post<ControlView>("/routines/weather/when", { when: "cron 30 7 * * 1-5", sha });
			const view = moved.routines.find((each) => each.name === "weather");
			expect(view?.accepted?.routine).toMatchObject({ when: "Weekdays at 07:30, Lisbon time", zone: "Europe/Lisbon" });
			expect((view?.nextRuns ?? []).map((at) => localTime(at, "Europe/Lisbon").slice(11))).toEqual([
				"07:30",
				"07:30",
				"07:30",
			]);

			// one the owner makes from the panel is on their browser's wall
			await expect(
				post("/routines", {
					agent: "sancho",
					description: "Brief",
					when: "cron 0 8 * * *",
					ask: "Go.",
					zone: "Lisbon",
				}),
			).rejects.toThrow(/400/);
			const made = await post<{ name: string; control: ControlView }>("/routines", {
				agent: "sancho",
				description: "Night owl",
				when: "cron 0 22 * * *",
				ask: "Say good night.",
				zone: "America/New_York",
			});
			expect(await readFile(join(home, "workspace", "routines", `${made.name}.md`), "utf8")).toContain(
				"cron: 0 22 * * *\nzone: America/New_York\n",
			);
			const owl = made.control.routines.find((each) => each.name === made.name);
			expect(owl?.accepted?.routine?.when).toBe("Every day at 22:00, New York time");
			expect(localTime(owl?.next as number, "America/New_York").slice(11)).toBe("22:00");
		} finally {
			await started.close();
		}
	});
});

describe("the owner's edit of when a routine runs", () => {
	const FIELDS = fc.record({
		description: fc.constantFrom("Tea time", "Price: watch it", "Standup notes"),
		runsADay: fc.option(fc.integer({ min: 1, max: 99 }), { nil: undefined }),
		when: fc.option(fc.constantFrom("every: 2h", "cron: 0 9 * * 1-5", "every: 30m"), { nil: undefined }),
		ask: fc.constantFrom("Remind me.", "Check the price.\n\nTell me if it drops under 250."),
	});

	it("property: only the schedule changes, every other line kept as it was", () => {
		fc.assert(
			fc.property(FIELDS, anyPick, (fields, pick) => {
				const when = fields.when ?? "every: 1d";
				const lines = [
					`description: ${fields.description}`,
					when,
					...(fields.runsADay === undefined ? [] : [`runs_a_day: ${fields.runsADay}`]),
				];
				const text = `---\n${lines.join("\n")}\n---\n${fields.ask}\n`;
				const before = parseRoutine("tea", text);
				if (!("routine" in before)) throw new Error(before.errors.join("; "));
				const line = (pickSchedule(pick) as { text: string }).text;
				const edited = withWhen(text, line);
				expect(edited).toBeDefined();
				const after = parseRoutine("tea", edited as string);
				if (!("routine" in after)) throw new Error(after.errors.join("; "));
				expect(after.routine).toEqual({ ...before.routine, when: parseSchedule(line, hostZone()) });
				const kept = (t: string) => t.split("\n").filter((l) => !/^(every|at|cron):/.test(l));
				expect(kept(edited as string)).toEqual(kept(text));
			}),
			{ numRuns: pbtRuns(200) },
		);
	});
});

/** A clock that only the test moves, and timers that fire at once. */
function testClock(start: number) {
	const clock = { now: start };
	const setTimer: SetTimer = (callback, delay, { background }) => {
		const timer = setTimeout(callback, Math.max(0, Math.min(delay, 5)));
		if (background) timer.unref();
		return () => clearTimeout(timer);
	};
	return { clock, setTimer };
}

/** A model that answers each run's input with a message, held back while `hold` is set. */
function heldModels() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const gate = { hold: undefined as Promise<void> | undefined, prompts: [] as string[] };
	const answer = async (ctx: {
		messages: readonly { role: string; content?: unknown }[];
	}): Promise<AssistantMessage> => {
		gate.prompts.push(JSON.stringify(ctx.messages.at(-1)?.content ?? ""));
		await gate.hold;
		if (ctx.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("done");
		return fauxAssistantMessage([fauxToolCall("message_user", { text: "Tea!" })], { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 1000 }, () => answer as never));
	return { models, gate };
}

describe("run now", () => {
	const START = new Date(2026, 10, 2, 9, 0).getTime();

	async function setup(text: string) {
		const home = await tempHome();
		const time = testClock(START);
		const gateway = new FakeGateway();
		const core = defineCore({
			blobs: blobStore(),
			gateway: () => gateway,
			model: () => FAUX_MODEL,
			retryDelay: () => 5,
			now: () => time.clock.now,
			agentOrigin: (agent) => ({ gateway: "fake", peer: OWNER, thread: `agent:${agent}` }),
		});
		const { models, gate } = heldModels();
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(home, { models, registry, now: () => time.clock.now, setTimer: time.setTimer });
		harness.resume();
		await harness.commit(async (tx) => {
			(await tx.doc(Accepted)).files[routinePath("tea")] = { sha: shaOf(text), text, at: START };
			(await tx.doc(Routines)).routines.tea = { since: START };
		}, context);
		await core.reconcile(harness);
		return { harness, core, gate, gateway, time };
	}

	const wakes = async (harness: Harness) => {
		const routes: Record<string, { chat: number }> = (await harness.snapshot(Routes, context))?.routes ?? {};
		const found: WakeData[] = [];
		for (const { chat } of Object.values(routes)) {
			const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
				{ order: "ascending" },
				1000,
				undefined,
				context,
			);
			for (const entry of page.items) if (entry.kind === WAKE) found.push(entry.data as WakeData);
		}
		return found;
	};

	it("runs once per click, is refused while its run still goes, and leaves the schedule as it was", async () => {
		const { harness, core, gate, gateway } = await setup("---\ndescription: Tea\ncron: 0 16 * * *\n---\nSay tea.\n");
		let release = () => {};
		gate.hold = new Promise((resolve) => {
			release = resolve;
		});
		const fired = (await harness.snapshot(Routines, context))?.routines.tea?.fired;
		expect(await core.runRoutine(harness, "tea", "a")).toBe("ran");
		// the same click sent again: nothing new
		expect(await core.runRoutine(harness, "tea", "a")).toBe("already");
		// another click while the run goes: it waits its turn, as a due time would
		await expect(core.runRoutine(harness, "tea", "b")).rejects.toThrow(RoutineRefused);
		await expect(core.runRoutine(harness, "tea", "b")).rejects.toThrow(/still going/);
		release();
		await until(() => gateway.sent.length === 1);
		await until(async () => {
			try {
				return (await core.runRoutine(harness, "tea", "b")) === "ran";
			} catch (error) {
				if (error instanceof RoutineRefused) return false;
				throw error;
			}
		});
		await until(() => gateway.sent.length === 2);
		const found = await wakes(harness);
		expect(found.map((wake) => [wake.routine, wake.owner])).toEqual([
			["tea", true],
			["tea", true],
		]);
		const record = (await harness.snapshot(Routines, context))?.routines.tea;
		expect(record?.fired).toBe(fired);
		expect(record?.ranNow).toEqual(["a", "b"]);
		expect(record?.wakes).toHaveLength(2);
		await expect(core.runRoutine(harness, "nope", "c")).rejects.toThrow(/no routine/);
		await harness.close(context);
	});
});

/** A model's call of `schedule` writing routine tea, then its reply. */
const writesTea = (id: string, cron: string, ask = "Remind the owner to drink tea.") => [
	fauxAssistantMessage([fauxToolCall("tool_search", { query: "schedule", limit: 1 })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxToolCall("schedule", { name: "tea", description: "Tea time", cron, ask }, { id })], {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage("Asked them to allow it."),
];

/** A daemon whose model writes a routine at 16:00 every day when asked (or does `script`), then answers its runs. */
async function daemon(script: readonly FauxResponseStep[] = writesTea("c1", "0 16 * * *")) {
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const web = join(home, "web");
	await mkdir(web, { recursive: true });
	await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([...script, ...Array.from({ length: 20 }, () => fauxAssistantMessage("Nothing to say."))]);
	const started = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
	const token = (await readDaemonFile(home))!.token!;
	const url = `http://127.0.0.1:${started.port}`;
	const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
		const response = await fetch(`${url}/api${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, ...init.headers },
		});
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	};
	const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
	return { home, daemon: started, api, post, faux };
}

describe("a routine rewritten in its chat", () => {
	it("its call's receipt names what it wrote; the feed says changed, or not changed, by what the owner allowed", async () => {
		const { daemon: started, api, post, faux } = await daemon([]);
		try {
			const thread = randomUUID();
			// each message's run: the model writes tea at `cron`, then has nothing more to say
			const say = (text: string, id: string, cron: string) => {
				faux.setResponses([
					...writesTea(id, cron),
					...Array.from({ length: 5 }, () => fauxAssistantMessage("Nothing to say.")),
				]);
				return post("/messages", { id: randomUUID(), thread, text });
			};
			const waiting = (cron: string) =>
				until(async () => {
					const routine = (await api<ControlView>("/control")).routines.find((each) => each.name === "tea");
					return routine?.change !== undefined &&
						"routine" in routine.change &&
						routine.change.routine?.schedule === `cron ${cron}`
						? (routine.change as { sha: string })
						: undefined;
				});
			const items = async () => {
				const chat = (await api<ChatRow[]>("/chats"))[0]?.chat;
				return (await api<{ items: Item[] }>(`/chats/${chat}/items?after=0`)).items;
			};
			const receipts = async () =>
				(await items()).flatMap((item) => (item.role === "tool" && item.receipt ? [item.receipt] : []));
			const feed = async () => {
				const routines = (await api<ControlView>("/control")).routines;
				return view(await items(), [], { busy: false, running: [], thinking: false }, { routines }).flatMap(
					(segment) => (segment.kind === "routine" ? [[segment.state, routineWords(segment)]] : []),
				);
			};

			await say("tea every day at four", "c1", "0 16 * * *");
			const first = await waiting("0 16 * * *");
			await post("/routines/tea/accept", { sha: first.sha });
			expect(await feed()).toEqual([["done", "Routine scheduled: Tea time"]]);

			// rewritten under the same name: a change of the routine in effect, which waits for the owner
			await say("make it five", "c2", "0 17 * * *");
			const second = await waiting("0 17 * * *");
			await until(async () => ((await receipts()).length === 2 ? true : undefined));
			expect(await receipts()).toEqual([
				{ kind: "routine", name: "tea", sha: first.sha, change: "added" },
				{ kind: "routine", name: "tea", sha: second.sha, change: "changed" },
			]);
			expect(await feed()).toEqual([["pending", "Routine change: Tea time · waiting for you"]]);
			// declined: the box gets the version in effect back, and the line says the change was not made
			await post("/routines/tea/decline", {});
			await until(async () =>
				(await api<ControlView>("/control")).routines.find(
					(routine) => routine.name === "tea" && routine.change === undefined,
				),
			);
			expect(await feed()).toEqual([["declined", "Routine not changed: Tea time"]]);

			// rewritten again and allowed: changed, and still so once the owner moves when it runs
			await say("six, then", "c3", "0 18 * * *");
			const third = await waiting("0 18 * * *");
			await post("/routines/tea/accept", { sha: third.sha });
			expect(await feed()).toEqual([["done", "Routine changed: Tea time"]]);
			const tea = (await api<ControlView>("/control")).routines.find((routine) => routine.name === "tea");
			expect(tea?.allowed).toEqual([first.sha, third.sha]);
			await post("/routines/tea/when", { when: "cron 0 19 * * *", sha: third.sha });
			expect(await feed()).toEqual([["done", "Routine changed: Tea time"]]);
		} finally {
			await started.close();
		}
	});
});

describe("routines through the API", () => {
	it("the owner changes when it runs at once, refused over a change they did not see; run now runs once per click", async () => {
		const { home, daemon: started, api, post } = await daemon();
		try {
			await post("/messages", { id: randomUUID(), thread: randomUUID(), text: "tea every day at four" });
			const file = join(home, "workspace", "routines", "tea.md");
			await until(async () => existsSync(file));
			const waiting = await until(async () =>
				(await api<ControlView>("/control")).routines.find(
					(routine) => routine.name === "tea" && routine.change !== undefined,
				),
			);
			expect(waiting.state).toBe("allow");
			const sha = (waiting.change as { sha: string }).sha;
			const allowed = await post<ControlView>("/routines/tea/accept", { sha });
			const tea = allowed.routines.find((routine) => routine.name === "tea");
			expect(tea).toMatchObject({ state: "active", accepted: { routine: { schedule: "cron 0 16 * * *" } } });
			expect(tea?.nextRuns).toHaveLength(3);
			expect(tea?.nextRuns?.every((at) => new Date(at).getHours() === 16)).toBe(true);
			expect(tea?.week).toHaveLength(7);

			// not a schedule; a version they did not see
			await expect(post("/routines/tea/when", { when: "soon", sha })).rejects.toThrow(/400/);
			await expect(post("/routines/tea/when", { when: "cron 0 8 * * 1-5", sha: "0".repeat(64) })).rejects.toThrow(
				/409/,
			);
			const before = await readFile(file, "utf8");
			const moved = await post<ControlView>("/routines/tea/when", { when: "cron 0 8 * * 1-5", sha });
			const after = await readFile(file, "utf8");
			expect(after).toBe(before.replace("cron: 0 16 * * *", "cron: 0 8 * * 1-5"));
			const edited = moved.routines.find((routine) => routine.name === "tea");
			expect(edited).toMatchObject({
				state: "active",
				accepted: {
					sha: shaOf(after),
					// a time on the wall says whose: here, the daemon's computer's
					routine: { when: `Weekdays at 08:00, ${zoneWords(hostZone())}`, schedule: "cron 0 8 * * 1-5" },
				},
			});
			expect(edited?.change).toBeUndefined();
			for (const at of edited?.nextRuns ?? []) {
				expect(new Date(at).getHours()).toBe(8);
				expect([1, 2, 3, 4, 5]).toContain(new Date(at).getDay());
			}
			expect(
				moved.activity.some((event) => event.routine === "tea" && /You changed when it runs/.test(event.what)),
			).toBe(true);

			// the box changes it: that waits for the owner, and their edit over it is refused
			await writeFile(file, after.replace("Remind", "Gently remind"));
			await until(async () =>
				(await api<ControlView>("/control")).routines.find((routine) => routine.change !== undefined),
			);
			await expect(post("/routines/tea/when", { when: "every 2h", sha: shaOf(after) })).rejects.toThrow(/409/);
			await writeFile(file, after);

			// run now: once per click
			await post("/routines/tea/run", { key: "click-1" });
			await post("/routines/tea/run", { key: "click-1" });
			await expect(post("/routines/tea/run", { key: "no spaces" })).rejects.toThrow(/400/);
			await expect(post("/routines/nope/run", { key: "click-2" })).rejects.toThrow(/404/);
			const ran = await until(async () => {
				const view = (await api<ControlView>("/control")).routines.find((routine) => routine.name === "tea");
				return view?.last !== undefined && view.running !== true ? view : undefined;
			});
			expect(ran.last).toMatchObject({ result: "ran" });
			const runs = (await api<ControlView>("/control")).activity.filter((event) => event.what === "You ran it now");
			expect(runs).toHaveLength(1);
			// its schedule did not move
			expect(ran.nextRuns).toEqual(edited?.nextRuns);
		} finally {
			await started.close();
		}
	});
});

describe("the owner's own routine, from the panel", () => {
	it("is made as a file in effect at once, for its agent; edited line by line; paused; deleted", async () => {
		const { home, daemon: started, post } = await daemon([]);
		try {
			await expect(
				post("/routines", { agent: "nobody", description: "Brief", when: "cron 0 8 * * 1-5", ask: "Go." }),
			).rejects.toThrow(/404/);
			await expect(
				post("/routines", { agent: "sancho", description: "Brief", when: "soon", ask: "Go." }),
			).rejects.toThrow(/400/);
			const made = await post<{ name: string; control: ControlView }>("/routines", {
				agent: "sancho",
				description: "Morning brief",
				when: "cron 0 8 * * 1-5",
				ask: "Tell me what is on my plate today.",
			});
			expect(made.name).toBe("morning-brief");
			const brief = made.control.routines.find((routine) => routine.name === "morning-brief");
			// in effect at once, never waiting for anyone to allow it, and the agent's
			expect(brief).toMatchObject({
				agent: "sancho",
				state: "active",
				accepted: { routine: { description: "Morning brief", when: `Weekdays at 08:00, ${zoneWords(hostZone())}` } },
			});
			expect(brief?.change).toBeUndefined();
			expect(brief?.next).toBeGreaterThan(Date.now());
			const file = join(home, "workspace", "routines", "morning-brief.md");
			const text = await readFile(file, "utf8");
			expect(shaOf(text)).toBe(brief?.accepted?.sha);
			// the same words again make another, never over the first
			const again = await post<{ name: string }>("/routines", {
				agent: "sancho",
				description: "Morning brief",
				when: "every 2h",
				ask: "Again.",
			});
			expect(again.name).toBe("morning-brief-2");

			// an edit rewrites only its lines, bound to the version seen
			const sha = brief?.accepted?.sha as string;
			const edited = await post<ControlView>("/routines/morning-brief/edit", {
				sha,
				description: "Morning plate",
				ask: "What needs me first?",
			});
			const after = await readFile(file, "utf8");
			expect(after).toBe(
				text
					.replace("description: Morning brief", "description: Morning plate")
					.replace("Tell me what is on my plate today.", "What needs me first?"),
			);
			expect(edited.routines.find((routine) => routine.name === "morning-brief")?.accepted?.sha).toBe(shaOf(after));
			await expect(post("/routines/morning-brief/edit", { sha, ask: "Stale." })).rejects.toThrow(/409/);

			// paused and resumed, then deleted
			const paused = await post<ControlView>("/routines/morning-brief/pause", {});
			expect(paused.routines.find((routine) => routine.name === "morning-brief")).toMatchObject({ state: "paused" });
			const removed = await post<ControlView>("/routines/morning-brief/remove", {});
			expect(removed.routines.map((routine) => routine.name)).toEqual(["morning-brief-2"]);
			expect(existsSync(file)).toBe(false);
		} finally {
			await started.close();
		}
	});
});

describe("the owner edits a routine an agent proposed, before allowing it", () => {
	it("what runs is the owner's when and ask, every other byte as written; the box gets it; what is not its text is refused", async () => {
		const { home, daemon: started, api, post } = await daemon();
		try {
			await post("/messages", { id: randomUUID(), thread: randomUUID(), text: "tea every day at four" });
			const file = join(home, "workspace", "routines", "tea.md");
			await until(async () => existsSync(file));
			const waiting = await until(async () =>
				(await api<ControlView>("/control")).routines.find(
					(routine) => routine.name === "tea" && routine.change !== undefined,
				),
			);
			const sha = (waiting.change as { sha: string }).sha;
			const written = await readFile(file, "utf8");
			// its limits, its name and its agent are not text the agent wrote for the owner; nor is a removal's
			for (const [body, why] of [
				[{ sha, runs_a_day: 1000 }, /400 .*runs_a_day cannot be edited/],
				[{ sha, agent: "other" }, /400 .*agent cannot be edited/],
				[{ sha, when: "soon" }, /400 .*not a schedule/],
				[{ sha, when: "at 2001-01-01 09:00" }, /400 .*passed/],
				[{ sha, ask: "  " }, /400/],
				[{ sha, ask: 7 }, /400/],
				[{ sha: null, ask: "Something else." }, /400/],
				[{ sha: "0".repeat(64), ask: "Something else." }, /409/],
			] as const)
				await expect(post("/routines/tea/accept", body), JSON.stringify(body)).rejects.toThrow(why);
			expect((await api<ControlView>("/control")).routines.find((each) => each.name === "tea")?.accepted).toBe(
				undefined,
			);
			expect(await readFile(file, "utf8")).toBe(written);

			// what it is for, given back as the agent wrote it, is no edit: the notice names only what changed
			const allowed = await post<ControlView>("/routines/tea/accept", {
				sha,
				description: "Tea time",
				when: "cron 0 9 * * *",
				ask: "Remind the owner, kindly, to drink tea.",
			});
			const expected = withWhen(written, "cron 0 9 * * *")!.replace(
				"Remind the owner to drink tea.",
				"Remind the owner, kindly, to drink tea.",
			);
			const tea = allowed.routines.find((routine) => routine.name === "tea");
			expect(tea).toMatchObject({
				state: "active",
				accepted: {
					sha: shaOf(expected),
					routine: {
						schedule: "cron 0 9 * * *",
						ask: "Remind the owner, kindly, to drink tea.",
						description: "Tea time",
					},
				},
				allowed: [sha],
				edited: [sha],
			});
			expect(tea?.change).toBeUndefined();
			// the agent finds its file as the owner left it, and is told which of its text they changed, never the text
			expect(await readFile(file, "utf8")).toBe(expected);
			// in the agent's own chat, where its routine wakes
			const told: Item[] = [];
			for (const { chat } of await api<ChatRow[]>("/chats"))
				for (const item of (await api<{ items: Item[] }>(`/chats/${chat}/items?after=0`)).items)
					if (item.role === "instruction" && item.text.includes("routine")) told.push(item);
			expect(told).toMatchObject([
				{
					text: 'The owner allowed your routine "tea" after editing its schedule and ask: routines/tea.md holds what runs. This notice is automatic, not from the owner.',
				},
			]);
			expect(tea?.nextRuns?.every((at) => new Date(at).getHours() === 9)).toBe(true);
		} finally {
			await started.close();
		}
	});
});
