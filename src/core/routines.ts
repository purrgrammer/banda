/**
 * Routines (DESIGN.md "Routines"): `routines/<name>.md` in the workspace, a "before" file: when it is due (every so
 * long, once, or on a cron-like schedule, its times on the wall of its `zone`, else the daemon's computer's), how many
 * runs a day it may have, and what to ask. The accepted file is what
 * runs. A routine belongs to one agent and wakes in that agent's chat, never a chat of its own. Each routine has one
 * task, a timer: it sleeps until the routine is due, and then, in the commit that records the due time as fired, queues
 * one wake into its agent's chat, so a routine fires once per due time whatever restarts come between. Due times
 * missed while the daemon was down or paused come together as one wake.
 *
 * A run that failed, a due time skipped because the last run still goes, and a routine that ran the most it may in a
 * day (and so paused alone) each leave a trouble entry in the chat, in the commit that decides it: the chat draws it as
 * an error line, and it counts as unread.
 *
 * The facts a routine's file cannot hold live in the `Routines` doc, written in the commits that make them: whose it
 * is, when it was allowed, the due time it last fired, its newest run, its wakes of the last day, and whether the owner
 * paused it. Its task is only a timer over them, so a task can be dropped and made again (a changed file, a pause) and
 * the routine goes on where it was.
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineDoc,
	defineTask,
	defineTool,
	type Harness,
	type JsonObject,
	type TaskId,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { log } from "./activity.ts";
import { Accepted, AGENT_NAME, agentWords, ChatAgent, frontmatter, isArchived, LEAD, shaOf } from "./agents.ts";

import {
	hostZone,
	isZone,
	localTime,
	nextDue,
	parseAt,
	parseCron,
	parseEvery,
	scheduleField,
	type When,
	whenWords,
} from "./schedule.ts";
import { context } from "./store.ts";

/** A routine's name, which is its file's: lowercase words joined by `-`, as an agent's. */
export const ROUTINE_NAME = AGENT_NAME;
export const routinePath = (name: string) => `routines/${name}.md`;
export const MAX_ROUTINE_BYTES = 16 * 1024;

/** Wakes a day a routine may have unless its file says otherwise (`runs_a_day`). */
export const DEFAULT_RUNS_A_DAY = 24;
/** The most `runs_a_day` a routine file may give. */
export const MAX_RUNS_A_DAY = 1000;
const DAY = 24 * 60 * 60_000;
/** The longest one sleep lasts: a routine due later sleeps again, so a far due time never rests on one timer. */
const LONGEST_SLEEP = 7 * DAY;

/** A routine as its accepted file says. */
export type Routine = {
	readonly name: string;
	/** What it is for, in the owner's words: how the app names it. */
	readonly description: string;
	readonly when: When;
	/** The most times it may wake in a day before it pauses itself (`runs_a_day` in its file). */
	readonly runsADay: number;
	/** What the agent is asked when it wakes. */
	readonly ask: string;
};

const FIELDS = ["description", "every", "at", "cron", "zone", "runs_a_day"] as const;

/** Parse a routine file, each problem saying what to write instead. */
export function parseRoutine(
	name: string,
	text: string,
): { readonly routine: Routine } | { readonly errors: readonly string[] } {
	const errors: string[] = [];
	if (!ROUTINE_NAME.test(name))
		errors.push(`"${name}" is not a routine name: use lowercase letters, digits and dashes, such as "price-check"`);
	const read = frontmatter(text, FIELDS);
	if (read === undefined)
		return { errors: [...errors, "a routine file starts with its frontmatter between two --- lines"] };
	errors.push(...read.errors);
	const description = read.one("description") ?? "";
	if (description === "") errors.push(`add a "description:", a few words saying what it is for`);
	const every = read.one("every");
	const at = read.one("at");
	const cron = read.one("cron");
	const zoned = read.one("zone");
	if (zoned !== undefined && !isZone(zoned))
		errors.push(`"zone: ${zoned}" is not a time zone: write an IANA name, such as Europe/Lisbon`);
	// a time on the wall is on the owner's wall when the file names it, else the daemon's computer's, said either way
	const zone = zoned !== undefined && isZone(zoned) ? zoned : hostZone();
	const given = [every, at, cron].filter((value) => value !== undefined).length;
	let when: When | undefined;
	if (given > 1) errors.push(`give one of "every", "at" and "cron"`);
	else if (every !== undefined) {
		const ms = parseEvery(every);
		if (ms === undefined)
			errors.push(`"every: ${every}" is not a period: write a number and m, h, d or w, such as 30m`);
		else when = { every: ms };
	} else if (at !== undefined) {
		const ms = parseAt(at, zone);
		if (ms === undefined) errors.push(`"at: ${at}" is not a time: write it as 2026-11-02 09:00`);
		else when = { at: ms, zone };
	} else if (cron !== undefined) {
		if (parseCron(cron) === undefined)
			errors.push(`"cron: ${cron}" is not a schedule: write minute hour day month weekday, such as 0 9 * * 1-5`);
		else when = { cron, zone };
	} else errors.push(`say when it runs: "every", "at" or "cron"`);
	const runsText = read.one("runs_a_day");
	const runsADay = runsText === undefined ? DEFAULT_RUNS_A_DAY : Number(runsText);
	if (!Number.isInteger(runsADay) || runsADay < 1 || runsADay > MAX_RUNS_A_DAY)
		errors.push(
			`"runs_a_day: ${runsText}" is the most times it may run in one day: a whole number from 1 to ${MAX_RUNS_A_DAY}`,
		);
	if (read.body === "") errors.push("below the frontmatter, write what to do when it is due");
	if (errors.length > 0 || when === undefined) return { errors };
	return {
		routine: {
			name,
			description,
			when,
			runsADay,
			ask: read.body,
		},
	};
}

/** A routine file's text, as the tools write it. */
export function routineText(
	routine: Omit<Routine, "name" | "when"> & { readonly when: Record<string, string> },
): string {
	const lines = [`description: ${routine.description}`];
	for (const [key, value] of Object.entries(routine.when)) lines.push(`${key}: ${value}`);
	if (routine.runsADay !== DEFAULT_RUNS_A_DAY) lines.push(`runs_a_day: ${routine.runsADay}`);
	return `---\n${lines.join("\n")}\n---\n${routine.ask.trim()}\n`;
}

/**
 * A routine file's text with its schedule replaced by `line` (`every 4h`, `at 2026-11-02 09:00`, `cron 0 8 * * 1-5`),
 * every other byte as it was: the owner changing when it runs changes nothing else. Undefined when `line` is no
 * schedule or the text has no frontmatter.
 */
export function withWhen(text: string, line: string): string | undefined {
	const field = scheduleField(line);
	const match = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(text);
	if (field === undefined || match === null) return undefined;
	const lines = (match[2] ?? "").split(/\r?\n/);
	const scheduled = (each: string) => /^(every|at|cron):/.test(each);
	const first = lines.findIndex(scheduled);
	const kept = lines.filter((each) => !scheduled(each));
	// where its schedule was; else after its description
	const at = first !== -1 ? first : kept.findIndex((each) => each.startsWith("description:")) + 1;
	kept.splice(at, 0, `${field.key}: ${field.value}`);
	return `${match[1]}${kept.join("\n")}${match[3]}${text.slice(match[0].length)}`;
}

const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;

/**
 * A routine file's text with its description line replaced, every other byte as it was. Undefined when the text has
 * no frontmatter or no description line.
 */
export function withDescription(text: string, description: string): string | undefined {
	const match = FRONTMATTER.exec(text);
	if (match === null) return undefined;
	const lines = (match[2] ?? "").split(/\r?\n/);
	const at = lines.findIndex((each) => each.startsWith("description:"));
	if (at === -1) return undefined;
	lines[at] = `description: ${description}`;
	return `${match[1]}${lines.join("\n")}${match[3]}${text.slice(match[0].length)}`;
}

/** A routine file's text with what it does each run (its body) replaced, its frontmatter as it was. */
export function withAsk(text: string, ask: string): string | undefined {
	const match = FRONTMATTER.exec(text);
	if (match === null) return undefined;
	const head = match[0].endsWith("\n") ? match[0] : `${match[0]}\n`;
	return `${head}${ask.trim()}\n`;
}

/**
 * What a `schedule` call wrote, in its result's details: the routine by name, the hash of the file, and
 * whether it made one (`added`), changed one in effect (`changed`), or found it in effect as written (`same`).
 */
export type RoutineReceipt = {
	readonly kind: "routine";
	readonly name: string;
	readonly sha: string;
	readonly change: "added" | "changed" | "same";
};

/** What the store knows of a routine beyond its file. */
export type RoutineRecord = {
	/**
	 * The agent it belongs to, whose chat its wakes go to: the agent whose chat wrote it, or the one the owner made it
	 * for; the lead when unset (a file the owner allowed that no `schedule` call wrote).
	 */
	agent?: string;
	/** When it was first allowed: `every` counts from here. */
	since?: number;
	/** The hash of the accepted file its task runs. */
	sha?: string;
	/** Its live task, while it has one. */
	task?: number;
	/** Up to when its due times are fired: the newest it fired for, or, firing late, when it did. */
	fired?: number;
	/** The Turn of its newest wake, which says whether that run still goes. */
	turn?: number;
	/** That Turn, once a stall of it was told, so it is told once. */
	stalled?: number;
	/** When it woke, within the last day: its runs a day counts them. */
	wakes?: number[];
	/** When it last woke, kept past the day its runs a day looks at. */
	last?: number;
	/** When its newest run failed. */
	failed?: number;
	/** The keys of the owner's newest "Run now" clicks, so a click sent twice runs once. */
	ranNow?: string[];
	/**
	 * The owner made or changed it: the accepted file's new hash, and the hash the box held before (null: none). The store took the
	 * change first; until the box holds it too, this says to write it there (again, after a restart).
	 */
	edit?: { sha: string; base: string | null };
	/** Paused alone: by the owner, or by reaching its runs a day (`limit`). */
	paused?: "owner" | "limit";
	/** A one-time routine that ran, when. */
	done?: number;
	/**
	 * The hashes of the box's versions the owner allowed, newest last (at most `ALLOWED_KEPT`): the chat that wrote one
	 * says it was allowed, whatever changed since, and one never allowed was declined.
	 */
	allowed?: string[];
};

/** How many allowed versions a routine's record remembers: a chat's line looks back at its own write, a few at most. */
export const ALLOWED_KEPT = 8;

export const Routines = defineDoc<{ routines: { [name: string]: RoutineRecord } }>({
	kind: "banda.routines",
	version: 1,
	scope: "session",
	initial: () => ({ routines: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

/**
 * The control room's switch and where routines live: `paused` since when, while the owner has everything paused; and the
 * chat that holds the routines' tasks, which runs no agent and is listed nowhere.
 */
export const Control = defineDoc<{ paused?: number; chat?: number }>({
	kind: "banda.control",
	version: 1,
	scope: "session",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/** The routine `name` as accepted, or undefined when there is none, or what was accepted does not parse. */
export async function acceptedRoutine(tx: Tx, name: string): Promise<(Routine & { readonly sha: string }) | undefined> {
	const file = (await tx.doc(Accepted)).files[routinePath(name)];
	if (file === undefined) return undefined;
	const parsed = parseRoutine(name, file.text);
	return "routine" in parsed ? { ...parsed.routine, sha: file.sha } : undefined;
}

/** Every accepted routine's name. */
export async function acceptedRoutines(tx: Tx): Promise<string[]> {
	return Object.keys((await tx.doc(Accepted)).files).flatMap(
		(path) => /^routines\/(.+)\.md$/.exec(path)?.slice(1) ?? [],
	);
}

/** When a routine is next due, from its file and its record; undefined when it never is again. */
export function dueOf(routine: Pick<Routine, "when">, record: RoutineRecord, now: number): number | undefined {
	const since = record.since ?? now;
	return nextDue(routine.when, record.fired ?? since, since);
}

/** A wake's entry: the routine, and the due time it is for; or, run by the owner, when they asked. */
export type WakeData = {
	readonly routine: string;
	readonly due: number;
	readonly description: string;
	readonly owner?: true;
};
export const WAKE = "banda.routine-wake";

/**
 * A routine in trouble, as its chat's entry says it: its newest run failed (`why`, in the daemon's words), a due time
 * was skipped because its last run still goes (`due`), or it ran the most times a day it may and paused alone
 * (`runsADay`). The chat draws it as an error line, and it counts as unread.
 */
export type TroubleData = {
	readonly routine: string;
	readonly description: string;
	readonly at: number;
} & (
	| { readonly trouble: "failed"; readonly why: string }
	| { readonly trouble: "stalled"; readonly due: number }
	| { readonly trouble: "limit"; readonly runsADay: number }
);
export const TROUBLE = "banda.routine-trouble";

/** Tell chat `chat` that a routine is in trouble, in the commit that decided it. */
export async function troubleIn(tx: Tx, chat: number, data: TroubleData): Promise<void> {
	await tx.appendEntry(chat as ConversationId, { kind: TROUBLE, data: data as unknown as JsonObject });
}

/** What the model reads when a routine wakes it; `owner`, when the owner ran it now. */
function wakeText(routine: Routine, due: number, owner = false): string {
	const zone = "every" in routine.when ? hostZone() : (routine.when.zone ?? hostZone());
	const words = whenWords(routine.when);
	const when = `${localTime(due, zone)} ${zone}`;
	const runs = (words[0] ?? "").toLowerCase() + words.slice(1);
	const why = owner
		? `The owner asked your routine "${routine.name}" to run now, at ${when} (it runs ${runs}): `
		: `Your routine "${routine.name}" was due at ${when} (${runs}): `;
	return (
		why +
		`${routine.description}. ${owner ? "" : "Nobody is waiting on this run, and "}` +
		`${owner ? "The owner" : "the owner"} sees nothing you do not send with message_user.\n\n` +
		routine.ask +
		"\n\nSend only what is worth their attention: most runs need to say nothing."
	);
}

export type RoutinesOptions = {
	/** Queue an input to `chat`, after its other inputs, watched by a Turn: the Turn's id. */
	readonly followUp: (
		tx: Tx,
		chat: number,
		input: { readonly key: string; readonly text: string; readonly entry: { kind: string; data: JsonObject } },
	) => Promise<number>;
	/**
	 * Agent `agent`'s one chat, made and routed if it has none yet; undefined when that agent is not active (archived or
	 * gone), so nothing runs as another agent instead.
	 */
	readonly agentChat: (tx: Tx, agent: string) => Promise<number | undefined>;
	/** The workspace's root in the box, where the tools write routine files; none, and they cannot. */
	readonly workspace?: () => string | undefined;
};

type RoutineState = { phase: "wait" } | { phase: "fire"; due: number };
type RoutineEnd = { readonly ended: string };

/** The agent a routine belongs to: the one its record names, else the lead. */
export const routineAgent = (record: RoutineRecord): string => record.agent ?? LEAD;

/** The agent `chat` runs. */
const agentOf = async (tx: Tx, chat: number) => (await tx.doc(ChatAgent, chat as ConversationId)).agent?.id ?? LEAD;

export function defineRoutines(options: RoutinesOptions) {
	/** Drop `task` from its routine's record, if it is still the one there, and end it. */
	const ending = async (tx: Tx, name: string, task: number, ended: string) => {
		const record = (await tx.doc(Routines)).routines[name];
		if (record?.task === task) delete record.task;
		return { status: "terminal" as const, outcome: { status: "completed" as const, result: { ended } } };
	};

	const Routine = defineTask<{ name: string }, RoutineState, RoutineEnd>({
		name: "banda.routine",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: (task, runtime, ctx) =>
				runtime.commit(async (tx) => {
					const { name } = task.input;
					const id = Number(task.id);
					const routine = await acceptedRoutine(tx, name);
					const record = (await tx.doc(Routines)).routines[name];
					if (routine === undefined || record === undefined || record.task !== id) return ending(tx, name, id, "gone");
					if ((await tx.doc(Control)).paused !== undefined || record.paused !== undefined)
						return ending(tx, name, id, "paused");
					const due = dueOf(routine, record, runtime.now());
					if (due === undefined) {
						record.done ??= record.fired ?? runtime.now();
						return ending(tx, name, id, "done");
					}
					const far = runtime.now() + LONGEST_SLEEP;
					return due <= far
						? { status: "sleeping", until: due, checkpoint: { phase: "fire", due } }
						: { status: "sleeping", until: far, checkpoint: { phase: "wait" } };
				}, ctx),
			fire: async (task, runtime, ctx) => {
				const { name } = task.input;
				const id = Number(task.id);
				const { due } = task.state.checkpoint;
				// whether the first commit settled this due time: gone, paused, at its limit, or skipped for a run still going
				let ended = false;
				// first, whether it fires at all: its file, the pause, its newest run, its runs a day
				await runtime.commit(async (tx) => {
					const pre = (await tx.doc(Routines)).routines[name];
					const prior = pre?.turn === undefined ? undefined : await tx.task(pre.turn as TaskId);
					const routine = await acceptedRoutine(tx, name);
					const record = (await tx.doc(Routines)).routines[name];
					const now = runtime.now();
					const stop = (why: string) => {
						ended = true;
						return ending(tx, name, id, why);
					};
					if (routine === undefined || record === undefined || record.task !== id) return stop("gone");
					if ((await tx.doc(Control)).paused !== undefined || record.paused !== undefined) return stop("paused");
					if (prior !== undefined && prior.state.status !== "terminal") {
						// its last run still goes: this due time is skipped, and the owner told once, in the chat it runs in
						if (record.turn !== undefined && record.stalled !== record.turn) {
							record.stalled = record.turn;
							await log(tx, { at: now, routine: name, what: "skipped a turn: its last run is still going" });
							const { chat } = prior.input as { chat: number };
							await troubleIn(tx, chat, {
								routine: name,
								description: routine.description,
								at: now,
								trouble: "stalled",
								due,
							});
						}
						record.fired = Math.max(due, now);
						// and nothing more is done for it: the wake below is for a due time that fires
						ended = true;
						return { status: "running", checkpoint: { phase: "wait" } };
					}
					const wakes = (record.wakes ?? []).filter((at) => at > now - DAY);
					record.wakes = wakes;
					if (wakes.length >= routine.runsADay) {
						record.paused = "limit";
						await log(tx, { at: now, routine: name, what: "paused: it ran the most times a day it may" });
						const chat = await options.agentChat(tx, routineAgent(record));
						if (chat !== undefined)
							await troubleIn(tx, chat, {
								routine: name,
								description: routine.description,
								at: now,
								trouble: "limit",
								runsADay: routine.runsADay,
							});
						return stop("limit");
					}
					return undefined;
				}, ctx);
				if (ended) return;
				await runtime.commit(async (tx) => {
					const routine = await acceptedRoutine(tx, name);
					const record = (await tx.doc(Routines)).routines[name];
					if (routine === undefined || record === undefined || record.task !== id) return ending(tx, name, id, "gone");
					const now = runtime.now();
					const next = { status: "running" as const, checkpoint: { phase: "wait" as const } };
					// every due time up to now comes in this one: those missed while it could not fire are not fired again
					record.fired = Math.max(due, now);
					const text = wakeText(routine, due);
					const agent = routineAgent(record);
					const chat = await options.agentChat(tx, agent);
					if (chat === undefined) {
						await log(tx, { at: now, routine: name, what: `skipped a turn: ${agent} is not active` });
						return next;
					}
					const data: WakeData = { routine: name, due, description: routine.description };
					record.turn = await options.followUp(tx, chat, {
						key: `routine:${name}:${due}`,
						text,
						entry: { kind: WAKE, data },
					});
					record.wakes = [...(record.wakes ?? []), now];
					record.last = now;
					await log(tx, { at: now, routine: name, what: "ran" });
					return next;
				}, ctx);
			},
		},
		abort: (task, runtime, ctx) =>
			runtime.commit(async (tx) => {
				const record = (await tx.doc(Routines)).routines[task.input.name];
				if (record?.task === Number(task.id)) delete record.task;
				return { status: "terminal", outcome: { status: "aborted", reason: "aborted" } };
			}, ctx),
	});

	/**
	 * Bring the routines' tasks in line with the accepted files: one live task per accepted routine that is neither paused nor
	 * done, made again when its file changed; none while everything is paused. Tasks no longer needed are aborted.
	 */
	async function reconcile(harness: Harness, now: number, ctx: Context = context): Promise<void> {
		const stale = await harness.commit(async (tx) => {
			// reads first: a transaction reads tables only until its first write
			const { routines } = await tx.doc(Routines);
			const live = new Map<string, boolean>();
			for (const [name, record] of Object.entries(routines))
				if (record.task !== undefined) {
					const found = await tx.task(record.task as TaskId);
					live.set(name, found !== undefined && found.state.status !== "terminal");
				}
			const names = await acceptedRoutines(tx);
			const control = await tx.doc(Control);
			const old: number[] = [];
			const drop = (name: string, record: RoutineRecord) => {
				if (record.task !== undefined && live.get(name) === true) old.push(record.task);
				live.delete(name);
				delete record.task;
			};
			for (const [name, record] of Object.entries(routines)) if (!names.includes(name)) drop(name, record);
			for (const name of names) {
				const routine = await acceptedRoutine(tx, name);
				routines[name] ??= {};
				const record = routines[name];
				if (record === undefined) continue;
				if (routine === undefined) {
					drop(name, record);
					continue;
				}
				if (record.sha !== routine.sha) {
					// a changed file runs from now; what it already fired stays fired
					if (record.sha !== undefined) record.since = now;
					record.sha = routine.sha;
					delete record.done;
					drop(name, record);
				}
				record.since ??= now;
				if (control.paused !== undefined || record.paused !== undefined || record.done !== undefined) {
					drop(name, record);
					continue;
				}
				if (record.task !== undefined && live.get(name) === true) continue;
				if (control.chat === undefined)
					control.chat = Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
				record.task = Number(
					await tx.createTask(
						Routine,
						{ name },
						{
							ownership: { kind: "conversation" },
							background: true,
							conversationId: control.chat as ConversationId,
						},
					),
				);
			}
			return old;
		}, ctx);
		for (const task of stale) await harness.abortTask(task as TaskId, ctx);
	}

	/**
	 * Write a routine file into the box for the owner to allow, from a tool call, recording who wrote it. What it says, and
	 * its receipt: the file it wrote, by name and hash, and whether that made a routine, changed one in effect, or was
	 * already in effect as written.
	 */
	async function propose(
		api: Parameters<ToolRegistration["execute"]>[1],
		name: string,
		text: string,
		ctx: Context,
	): Promise<{ readonly text: string; readonly receipt: RoutineReceipt }> {
		const parsed = parseRoutine(name, text);
		if ("errors" in parsed) throw new Refused(`Not written: ${parsed.errors.join("; ")}.`);
		if ("at" in parsed.routine.when && parsed.routine.when.at <= api.now())
			throw new Refused("Not written: that time has passed; give one still to come.");
		const root = options.workspace?.();
		if (root === undefined || api.env === undefined)
			throw new Refused("Not written: there is no workspace to write to.");
		const sha = shaOf(text);
		const known = await api.commit(async (tx) => {
			const agent = await agentOf(tx, Number(api.conversationId));
			const known = (await tx.doc(Accepted)).files[routinePath(name)]?.sha;
			const { routines } = await tx.doc(Routines);
			routines[name] ??= {};
			const record = routines[name] as RoutineRecord;
			// a new routine is its writer's, wherever it wrote it (its chat, or a group's); a change keeps whose it is
			if (known === undefined) record.agent = agent;
			return known;
		}, ctx);
		const change = known === sha ? "same" : known === undefined ? "added" : "changed";
		const made = await api.env.createDir(`${root}/routines`, { recursive: true }, ctx);
		if (!made.ok) throw new Refused(`Not written: ${made.error.message}`);
		const written = await api.env.writeFile(`${root}/${routinePath(name)}`, text, ctx);
		if (!written.ok) throw new Refused(`Not written: ${written.error.message}`);
		return {
			text:
				change === "same"
					? `${routinePath(name)} is already in effect, as written.`
					: `Wrote ${routinePath(name)}. It runs once the owner allows it; until then it does nothing. They see it in ` +
						"the chat as a card to set it up: do not ask them to approve it, nor say it is set.",
			receipt: { kind: "routine", name, sha, change },
		};
	}

	/**
	 * Run routine `name` once now, as the owner asked: one wake into its chat, beside its schedule, which stays as it was.
	 * `key` is the click's, so a click sent twice runs once. Refused while its last run still goes, as a due time would skip its
	 * turn; the owner's own pause (of it, or of everything) does not hold it back: it is their decision.
	 */
	async function runNow(
		harness: Harness,
		name: string,
		key: string,
		now: () => number,
		ctx: Context = context,
	): Promise<"ran" | "already"> {
		/** Whether it may run: undefined when it may, "already" for a click it took, or why not. */
		const vet = async (tx: Tx) => {
			const record = (await tx.doc(Routines)).routines[name];
			const prior = record?.turn === undefined ? undefined : await tx.task(record.turn as TaskId);
			const routine = await acceptedRoutine(tx, name);
			if (routine === undefined) throw new RoutineRefused(`there is no routine named ${name}`, 404);
			if (record?.ranNow?.includes(key)) return { already: true as const, routine };
			const agent = routineAgent(record ?? {});
			if (await isArchived(tx, agent))
				throw new RoutineRefused(`${await agentWords(tx, agent)} is archived: restore it to run its routines`, 409);
			if (prior !== undefined && prior.state.status !== "terminal")
				throw new RoutineRefused("its last run is still going: it runs again once that one ends", 409);
			return { routine };
		};
		const first = await harness.commit(vet, ctx);
		if ("already" in first) return "already";
		return harness.commit(async (tx) => {
			const vetted = await vet(tx);
			if ("already" in vetted) return "already" as const;
			const { routine } = vetted;
			const at = now();
			const { routines } = await tx.doc(Routines);
			routines[name] ??= {};
			const record = routines[name] as RoutineRecord;
			const agent = routineAgent(record);
			const chat = await options.agentChat(tx, agent);
			if (chat === undefined) throw new RoutineRefused(`${agent} is not active: it cannot run as anyone else`, 409);
			const data: WakeData = { routine: name, due: at, description: routine.description, owner: true };
			record.turn = await options.followUp(tx, chat, {
				key: `routine:${name}:owner:${key}`,
				text: wakeText(routine, at, true),
				entry: { kind: WAKE, data },
			});
			record.wakes = [...(record.wakes ?? []).filter((each) => each > at - DAY), at];
			record.last = at;
			record.ranNow = [...(record.ranNow ?? []).slice(-(RAN_NOW_KEPT - 1)), key];
			await log(tx, { at, routine: name, what: "You ran it now" });
			return "ran" as const;
		}, ctx);
	}

	const said = (text: string, isError = false) => ({
		output: [{ type: "text" as const, text }],
		...(isError ? { isError: true } : {}),
	});
	const run = async (fn: () => Promise<{ readonly text: string; readonly receipt: RoutineReceipt }>) => {
		try {
			const { text, receipt } = await fn();
			return { ...said(text), details: { receipt } };
		} catch (error) {
			if (error instanceof Refused) return said(error.message, true);
			throw error;
		}
	};

	const common = {
		name: Type.String({
			minLength: 1,
			maxLength: 60,
			description: "Its name: lowercase words joined by -, such as call-mum.",
		}),
		description: Type.String({
			minLength: 1,
			maxLength: 120,
			description: "What it is for, in a few words the owner reads.",
		}),
		ask: Type.String({
			minLength: 1,
			description: "What to do when it is due, as a complete brief to yourself: you will remember nothing else.",
		}),
		max_runs_a_day: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: MAX_RUNS_A_DAY,
				description:
					`The most times it may run in one day before it pauses itself: a whole number from 1 to ${MAX_RUNS_A_DAY}, ` +
					`default ${DEFAULT_RUNS_A_DAY}. A safety limit per day, not how many times it runs in all, nor for how long: ` +
					"leave it out unless it runs more often than once an hour.",
			}),
		),
	};

	const schedule = defineTool({
		name: "schedule",
		description:
			'Keep a promise in time: when you tell the owner you will do something later ("I\'ll check tomorrow", "every ' +
			'Monday"), make it a routine, or it will not happen: you remember nothing between runs. Give exactly one of ' +
			"`every` (30m, 2h, 1d, 1w), `at` (2026-11-02 09:00, once) or `cron` (minute hour day month weekday). " +
			"`at` and `cron` are times on a wall clock: give `zone`, the IANA time zone of the place the owner means " +
			"(Europe/Lisbon), whenever you know it; without it they are in the zone your status line names, which is the " +
			"computer you run on, not where the owner is. Say the time back in the place's zone. It writes routines/<name>.md, which runs once the owner allows it; writing the same name again changes it.",
		parameters: Type.Object({
			...common,
			every: Type.Optional(Type.String()),
			at: Type.Optional(Type.String()),
			cron: Type.Optional(Type.String()),
			zone: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: 64,
					description:
						"The IANA time zone `at` and `cron` are in, such as Europe/Lisbon: where the owner is, or the place they name.",
				}),
			),
		}),
		replay: "safe",
		execute: (args, api, ctx) =>
			run(async () => {
				const when = Object.fromEntries(
					(["every", "at", "cron", "zone"] as const).flatMap((key) =>
						args[key] === undefined ? [] : [[key, args[key]]],
					),
				);
				return propose(
					api,
					args.name,
					routineText({
						description: args.description,
						when,
						runsADay: args.max_runs_a_day ?? DEFAULT_RUNS_A_DAY,
						ask: args.ask,
					}),
					ctx,
				);
			}),
	}) as ToolRegistration;

	return { Routine, reconcile, runNow, tools: [schedule] };
}

class Refused extends Error {}

/** Why the owner's action on a routine did not happen, with the HTTP status that says it. */
export class RoutineRefused extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/** How many of the owner's "Run now" clicks a routine remembers: a retry comes long before this many more clicks. */
const RAN_NOW_KEPT = 8;
