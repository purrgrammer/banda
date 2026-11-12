/**
 * routines in the box against their accepted versions, as agents are (DESIGN.md "The workspace"), and the control room
 * the app reads. A routine file is a "before" file: the owner allows a change by the hash of the text the app
 * showed them ("Allow this routine?"), and only the store's copy runs. The owner's own changes (removing a routine, pausing
 * one, when it runs, running it now) take effect at once.
 */
import type { Context } from "@earendil-works/chord";
import type { Harness, TaskId, Tx } from "@earendil-works/pi-durable";
import { ActivityLog, log } from "../core/activity.ts";
import { Accepted, activeAgents, agentWords, isArchived, shaOf, unaccept } from "../core/agents.ts";
import { fileNameFor } from "../core/names.ts";
import { openPermissions } from "../core/permissions.ts";
import {
	ALLOWED_KEPT,
	Control,
	DEFAULT_RUNS_A_DAY,
	dueOf,
	MAX_ROUTINE_BYTES,
	parseRoutine,
	ROUTINE_NAME,
	type Routine,
	type RoutineRecord,
	RoutineRefused,
	Routines,
	routineAgent,
	routinePath,
	routineText,
	withAsk,
	withDescription,
	withWhen,
} from "../core/routines.ts";
import { isZone, nextRuns, parseSchedule, scheduleField, scheduleText, whenWords } from "../core/schedule.ts";
import { context } from "../core/store.ts";
import { boxFiles, type Workspace, write } from "./agents.ts";
import type {
	ControlView,
	PermissionView,
	RoutineFileView,
	RoutineRun,
	RoutineState,
	RoutineSummary,
	RoutineView,
} from "./api.ts";
import { BadRequest } from "./http.ts";

type Reconcile = (harness: Harness, ctx?: Context) => Promise<void>;

const summary = (routine: Routine): RoutineSummary => ({
	description: routine.description,
	when: whenWords(routine.when),
	...("at" in routine.when ? { at: routine.when.at } : {}),
	schedule: scheduleText(routine.when),
	...("every" in routine.when || routine.when.zone === undefined ? {} : { zone: routine.when.zone }),

	runsADay: routine.runsADay,
	ask: routine.ask,
});

const fileView = (name: string, sha: string, text: string): RoutineFileView => {
	const parsed = parseRoutine(name, text);
	return { sha, ...("routine" in parsed ? { routine: summary(parsed.routine) } : { errors: parsed.errors }) };
};

const routineFiles = (workspace: Workspace, ctx: Context) => boxFiles(workspace, ctx, "routines", MAX_ROUTINE_BYTES);

const DAY = 24 * 60 * 60_000;
const lowerFirst = (words: string) => (words[0] ?? "").toLowerCase() + words.slice(1);
/** How many runs of one routine the timeline is given for the week ahead: an hourly one says the rest in words. */
const WEEK_SHOWN = 48;
/** What came of a routine's newest run: it failed, or it ran; what it said is in its chat, which the card opens. */
function lastRun(at: number | undefined, failed: number | undefined): RoutineRun | undefined {
	if (at === undefined) return undefined;
	return { at, result: failed !== undefined && failed >= at ? "failed" : "ran" };
}

/** How a routine stands, in the one word its card shows. */
function stateOf(view: Omit<RoutineView, "state">, record: RoutineRecord): RoutineState {
	if (view.change !== undefined) return "allow";
	if (record.done !== undefined) return "done";
	if (record.paused === "owner") return "paused";
	if (record.paused === "limit") return "limit";
	if (view.last?.result === "failed") return "failing";
	return "active";
}

/** Every routine, accepted or only in the box, with the change the box holds and its state; by name. */
export async function routines(
	harness: Harness,
	workspace: Workspace,
	now: number,
	ctx: Context = context,
): Promise<RoutineView[]> {
	const accepted = (await harness.snapshot(Accepted, ctx))?.files ?? {};
	const records = (await harness.snapshot(Routines, ctx))?.routines ?? {};
	const paused = (await harness.snapshot(Control, ctx))?.paused !== undefined;
	let boxed: Map<string, { text: string } | { unreadable: string }> | undefined;
	try {
		boxed = (await routineFiles(workspace, ctx)).files;
	} catch {
		// the box is down: what is in effect still shows
	}
	const names = new Set([
		...Object.keys(accepted).flatMap((path) => /^routines\/(.+)\.md$/.exec(path)?.slice(1) ?? []),
		...(boxed?.keys() ?? []),
	]);
	const views = await Promise.all(
		[...names].map(async (name): Promise<RoutineView> => {
			const file = accepted[routinePath(name)];
			const box = boxed?.get(name);
			const record: RoutineRecord = records[name] ?? {};
			const change: RoutineView["change"] =
				boxed === undefined
					? undefined
					: box === undefined
						? // the owner's own new routine the box does not hold yet is no removal of the box's
							file === undefined || record.edit?.base === null
							? undefined
							: { kind: "removed" }
						: "unreadable" in box
							? { kind: file === undefined ? "added" : "changed", errors: [`${routinePath(name)}: ${box.unreadable}`] }
							: // the owner's own edit the box does not hold yet is no change of the box's
								shaOf(box.text) === file?.sha || shaOf(box.text) === record.edit?.base
								? undefined
								: { kind: file === undefined ? "added" : "changed", ...fileView(name, shaOf(box.text), box.text) };
			const parsed = file === undefined ? undefined : parseRoutine(name, file.text);
			const routine = parsed !== undefined && "routine" in parsed ? parsed.routine : undefined;
			const scheduled = routine !== undefined && !paused && record.paused === undefined && record.done === undefined;
			const next = scheduled ? dueOf(routine, record, now) : undefined;
			const since = record.since ?? now;
			const after = record.fired ?? since;
			const runs = scheduled ? nextRuns(routine.when, after, since, 3) : [];
			const week = scheduled ? nextRuns(routine.when, after, since, WEEK_SHOWN, now + 7 * DAY) : [];
			const turn = record.turn === undefined ? undefined : await harness.getTask(record.turn as TaskId, ctx);
			const last = lastRun(record.last ?? record.wakes?.at(-1), record.failed);
			const view = {
				name,
				...(file === undefined ? {} : { accepted: fileView(name, file.sha, file.text) }),
				...(change === undefined ? {} : { change }),
				...(next === undefined ? {} : { next }),
				...(runs.length === 0 ? {} : { nextRuns: runs }),
				...(week.length === 0 ? {} : { week }),
				...(last === undefined ? {} : { last }),
				...(record.paused === undefined ? {} : { paused: record.paused }),
				...(record.done === undefined ? {} : { done: record.done }),
				...(record.wakes?.length ? { lastRun: record.wakes.at(-1) } : {}),
				...(turn !== undefined && turn.state.status !== "terminal" ? { running: true } : {}),

				agent: routineAgent(record),
				...(record.allowed?.length ? { allowed: [...record.allowed] } : {}),
				...(record.edited?.length ? { edited: [...record.edited] } : {}),
			};
			return { ...view, state: stateOf(view, record) };
		}),
	);
	return views.sort((a, b) => a.name.localeCompare(b.name));
}

const named = (name: string) => {
	if (!ROUTINE_NAME.test(name)) throw new BadRequest(`"${name}" is not a routine's name`);
	return name;
};

/**
 * Allow the box's change to routine `name`, as the owner saw it: `sha` is the hash of the text shown, or null for a
 * removal. A file changed since is refused, as is one that does not parse. Its task follows at once.
 *
 * `change` is the owner's edit of what the agent wrote, made before allowing it (what it is for, when it runs, what it
 * does each run, `changeRoutine`'s words): what runs is the file as they edited it, every other byte as the agent wrote
 * it. The store accepts the edited file and notes the box still needs it, as for any edit of the owner's, so the agent
 * finds its file as the owner left it; the version it wrote counts as allowed, edited.
 */
export async function accept(
	harness: Harness,
	workspace: Workspace,
	reconcile: Reconcile,
	name: string,
	sha: string | null,
	now: number,
	ctx: Context = context,
	change: RoutineChange = {},
	/** Tell the routine's agent, in the commit that allows it, which of its text the owner edited. */
	told?: (tx: Tx, agent: string, fields: readonly string[]) => Promise<void>,
): Promise<void> {
	const box = (await routineFiles(workspace, ctx)).files.get(named(name));
	if (sha === null) {
		if (Object.keys(change).length > 0) throw new BadRequest("a removal has nothing to edit");
		if (box !== undefined) throw new BadRequest(`${routinePath(name)} is back in the box: look again`, 409);
		await harness.commit(async (tx) => {
			await unaccept(tx, routinePath(name), now);
			await log(tx, { at: now, routine: name, what: "You removed it" });
		}, ctx);
	} else {
		if (box === undefined || "unreadable" in box || shaOf(box.text) !== sha)
			throw new BadRequest(`${routinePath(name)} changed since you saw it: look again`, 409);
		const parsed = parseRoutine(name, box.text);
		if ("errors" in parsed) throw new BadRequest(parsed.errors.join("\n"));
		const { text, fields } = editedText(name, box.text, parsed.routine, change, now);
		const runs = shaOf(text);
		await harness.commit(async (tx) => {
			const files = (await tx.doc(Accepted)).files;
			const known = files[routinePath(name)] !== undefined;
			files[routinePath(name)] = { sha: runs, text, at: now };
			const { routines } = await tx.doc(Routines);
			routines[name] ??= {};
			const record = routines[name] as RoutineRecord;
			record.allowed = [...(record.allowed ?? []).filter((each) => each !== sha), sha].slice(-ALLOWED_KEPT);
			if (runs !== sha) {
				record.edited = [...(record.edited ?? []).filter((each) => each !== sha), sha].slice(-ALLOWED_KEPT);
				// the box holds the agent's version: it gets the owner's, as after any edit of theirs
				record.edit = { sha: runs, base: sha };
			}
			if (runs !== sha) await told?.(tx, routineAgent(record), fields);
			const how = runs === sha ? "" : ", edited";
			await log(tx, { at: now, routine: name, what: known ? `You allowed its change${how}` : `You allowed it${how}` });
		}, ctx);
		if (runs !== sha) await finishEdit(harness, workspace, name, ctx);
	}
	await reconcile(harness, ctx);
}

/**
 * The box's routine file `text` with the owner's `change` in it, every other byte as the agent wrote it, checked as any
 * routine file is, and which of what the agent wrote it changes (an edit that gives the same words back changes nothing);
 * `text` itself when they changed nothing.
 */
function editedText(
	name: string,
	text: string,
	routine: Routine,
	change: RoutineChange,
	now: number,
): { readonly text: string; readonly fields: readonly string[] } {
	if (change.when === undefined && change.description === undefined && change.ask === undefined)
		return { text, fields: [] };
	const description = change.description === undefined ? undefined : descriptionOf(change.description);
	const ask = change.ask === undefined ? undefined : askOf(change.ask);
	// the owner's times are on the wall the agent named: its zone stays as it was
	const zone = "every" in routine.when ? undefined : routine.when.zone;
	const schedule = change.when === undefined ? undefined : scheduleOf(change.when, now, zone);
	let next: string | undefined = text;
	if (schedule !== undefined) next = withWhen(next, scheduleText(schedule));
	if (description !== undefined && next !== undefined) next = withDescription(next, description);
	if (ask !== undefined && next !== undefined) next = withAsk(next, ask);
	const parsed = next === undefined ? undefined : parseRoutine(name, next);
	if (next === undefined || parsed === undefined || "errors" in parsed)
		throw new BadRequest(
			parsed !== undefined && "errors" in parsed ? parsed.errors.join("; ") : "it has no frontmatter",
		);
	const after = parsed.routine;
	const fields = [
		...(after.description === routine.description ? [] : ["description"]),
		...(JSON.stringify(after.when) === JSON.stringify(routine.when) ? [] : ["schedule"]),
		...(after.ask === routine.ask ? [] : ["ask"]),
	];
	// the same routine in other bytes is no edit: what the agent wrote runs, as it wrote it
	return fields.length === 0 ? { text, fields } : { text: next, fields };
}

/** Decline the box's change to routine `name`: the accepted file is written back, or a new one removed. */
export async function decline(harness: Harness, workspace: Workspace, name: string, ctx: Context = context) {
	const file = (await harness.snapshot(Accepted, ctx))?.files[routinePath(named(name))];
	const env = workspace.env();
	const path = `${workspace.root}/${routinePath(name)}`;
	if (file !== undefined) return write(env, workspace, path, file.text, ctx);
	const removed = await env.remove(path, { force: true }, ctx);
	if (!removed.ok) throw removed.error;
}

/** Remove routine `name`, as the owner: its file goes from the box and the store, and it never runs again. */
export async function remove(
	harness: Harness,
	workspace: Workspace,
	reconcile: Reconcile,
	name: string,
	now: number,
	ctx: Context = context,
): Promise<void> {
	const removed = await workspace.env().remove(`${workspace.root}/${routinePath(named(name))}`, { force: true }, ctx);
	if (!removed.ok) throw removed.error;
	await harness.commit(async (tx) => {
		const files = (await tx.doc(Accepted)).files;
		if (files[routinePath(name)] === undefined) return;
		delete files[routinePath(name)];
		await log(tx, { at: now, routine: name, what: "You removed it" });
	}, ctx);
	await reconcile(harness, ctx);
}

/** The box's routine file `name` as it is now: its text, none, or unreadable. */
async function boxText(workspace: Workspace, name: string, ctx: Context): Promise<string | undefined | null> {
	const box = (await routineFiles(workspace, ctx)).files.get(name);
	if (box === undefined) return undefined;
	return "unreadable" in box ? null : box.text;
}

/** What the owner changes in a routine, from its editor: when it runs, what it is for, what it does; each optional. */
export type RoutineChange = { readonly when?: string; readonly description?: string; readonly ask?: string };

/** A schedule line the owner gave, read; refused in words when it is none, or a time that has passed. */
function scheduleOf(when: string, now: number, zone?: string) {
	const schedule = parseSchedule(when, zone);
	if (schedule === undefined)
		throw new BadRequest(`"${when}" is not a schedule: every 4h, at 2026-11-02 09:00, or cron 0 8 * * 1-5`);
	if ("at" in schedule && schedule.at <= now) throw new BadRequest("that time has passed: pick one still to come");
	return schedule;
}

/** What it is for, as the owner wrote it: one plain line. */
function descriptionOf(description: string): string {
	const line = description.trim();
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
	if (line === "" || line.length > 120 || /[\u0000-\u001f\u007f]/.test(line))
		throw new BadRequest("say what it is for in one line, at most 120 characters");
	return line;
}

/** What it does each run, as the owner wrote it. */
function askOf(ask: string): string {
	if (ask.trim() === "" || ask.length > 8000) throw new BadRequest("say what it does each run, in a few lines");
	return ask;
}

/**
 * Change routine `name` as the owner: when it runs (one schedule line: `every 4h`, `at 2026-11-02 09:00`,
 * `cron 0 8 * * 1-5`), what it is for, what it does each run; `sha` is the version in effect they saw. Only the lines
 * changed are rewritten, every other byte kept. It is the owner's edit, so it takes effect at once: the store accepts
 * the new text and notes that the box still needs it, then the box gets it and the note goes, then the task moves to
 * the new time. Refused when the version in effect is not the one shown, or when the box holds a change of its own
 * waiting to be allowed: an edit over it would allow what the owner never saw. A restart between the two writes
 * finishes the box's (`finishEdits`).
 */
export async function changeRoutine(
	harness: Harness,
	workspace: Workspace,
	reconcile: Reconcile,
	name: string,
	change: RoutineChange,
	sha: string,
	now: number,
	ctx: Context = context,
): Promise<void> {
	const description = change.description === undefined ? undefined : descriptionOf(change.description);
	const ask = change.ask === undefined ? undefined : askOf(change.ask);
	const file = (await harness.snapshot(Accepted, ctx))?.files[routinePath(named(name))];
	if (file === undefined) throw new BadRequest(`there is no routine named ${name}`, 404);
	// the owner's times are on the wall the routine keeps: its zone stays as it was
	const was = parseRoutine(name, file.text);
	const zone = "routine" in was && !("every" in was.routine.when) ? was.routine.when.zone : undefined;
	const schedule = change.when === undefined ? undefined : scheduleOf(change.when, now, zone);
	if (file.sha !== sha) throw new BadRequest("it changed since you saw it: look again", 409);
	const box = await boxText(workspace, name, ctx);
	if (box === null) throw new BadRequest("it has a change waiting for you to allow it: answer that first", 409);
	const pending = (await harness.snapshot(Routines, ctx))?.routines[name]?.edit;
	// the box holds what is in effect, or what was before an edit of the owner's it does not hold yet
	const base = box === undefined ? null : shaOf(box);
	if (base !== sha && !(pending?.sha === sha && pending.base === base))
		throw new BadRequest("it has a change waiting for you to allow it: answer that first", 409);
	let text: string | undefined = file.text;
	if (schedule !== undefined) text = withWhen(text, scheduleText(schedule));
	if (description !== undefined && text !== undefined) text = withDescription(text, description);
	if (ask !== undefined && text !== undefined) text = withAsk(text, ask);
	const parsed = text === undefined ? undefined : parseRoutine(name, text);
	if (text === undefined || parsed === undefined || "errors" in parsed)
		throw new BadRequest(
			parsed !== undefined && "errors" in parsed ? parsed.errors.join("; ") : "it has no frontmatter",
		);
	const changed = shaOf(text);
	if (changed === sha) return;
	const what =
		schedule !== undefined && description === undefined && ask === undefined
			? `You changed when it runs: ${lowerFirst(whenWords(schedule))}`
			: "You changed it";
	const edited = text;
	await harness.commit(async (tx) => {
		const files = (await tx.doc(Accepted)).files;
		if (files[routinePath(name)]?.sha !== sha) throw new BadRequest("it changed since you saw it: look again", 409);
		files[routinePath(name)] = { sha: changed, text: edited, at: now };
		const { routines } = await tx.doc(Routines);
		routines[name] ??= {};
		(routines[name] as RoutineRecord).edit = { sha: changed, base };
		await log(tx, { at: now, routine: name, what });
	}, ctx);
	await finishEdit(harness, workspace, name, ctx);
	await reconcile(harness, ctx);
}

/** Change when routine `name` runs, as the owner: `changeRoutine` with the schedule alone. */
export const changeWhen = (
	harness: Harness,
	workspace: Workspace,
	reconcile: Reconcile,
	name: string,
	when: string,
	sha: string,
	now: number,
	ctx: Context = context,
): Promise<void> => changeRoutine(harness, workspace, reconcile, name, { when }, sha, now, ctx);

/** A routine's name from what it is for: its words, lowercase, joined by `-` ("Morning brief" is morning-brief). */
export const nameFor = (description: string): string => fileNameFor(description, "routine");

/** What the owner makes from the panel: whose it is, what it is for, when it runs (one schedule line), what it does. */
export type NewRoutine = {
	readonly agent: string;
	readonly description: string;
	readonly when: string;
	readonly ask: string;
	/** The IANA time zone its wall times are in: the owner's, as their browser says. */
	readonly zone?: string;
};

/**
 * Make a routine as the owner, from the panel: a file the daemon writes as the owner's own, in effect at once, for
 * agent `agent`, whose chat it wakes. Named after what it is for, a number added when that name is taken (in effect or
 * in the box). The store accepts it first and notes the box still needs it (`base` null: the box has no such file),
 * so a restart between the two finishes the box's copy. Its name.
 */
export async function createRoutine(
	harness: Harness,
	workspace: Workspace,
	reconcile: Reconcile,
	made: NewRoutine,
	now: number,
	ctx: Context = context,
): Promise<string> {
	if (made.zone !== undefined && !isZone(made.zone))
		throw new BadRequest(`"${made.zone}" is not a time zone: an IANA name, such as Europe/Lisbon`);
	const schedule = scheduleOf(made.when, now, made.zone);
	const description = descriptionOf(made.description);
	const ask = askOf(made.ask);
	const accepted = (await harness.snapshot(Accepted, ctx))?.files ?? {};
	if (!activeAgents(accepted).includes(made.agent)) throw new BadRequest(`there is no agent named ${made.agent}`, 404);
	const boxed = (await routineFiles(workspace, ctx)).files;
	const base = nameFor(description);
	let name = base;
	for (let n = 2; accepted[routinePath(name)] !== undefined || boxed.has(name); n++) name = `${base}-${n}`;
	const field = scheduleField(scheduleText(schedule));
	if (field === undefined) throw new BadRequest("that is not a schedule");
	const text = routineText({
		description,
		when: {
			[field.key]: field.value,
			...(made.zone === undefined || field.key === "every" ? {} : { zone: made.zone }),
		},
		runsADay: DEFAULT_RUNS_A_DAY,
		ask,
	});
	const parsed = parseRoutine(name, text);
	if ("errors" in parsed) throw new BadRequest(parsed.errors.join("; "));
	const sha = shaOf(text);
	await harness.commit(async (tx) => {
		if (await isArchived(tx, made.agent))
			throw new BadRequest(`${await agentWords(tx, made.agent)} is archived: restore it first`, 409);
		const files = (await tx.doc(Accepted)).files;
		if (files[routinePath(name)] !== undefined) throw new BadRequest(`${name} was just made: look again`, 409);
		files[routinePath(name)] = { sha, text, at: now };
		const { routines } = await tx.doc(Routines);
		routines[name] = { agent: made.agent, edit: { sha, base: null } };
		await log(tx, { at: now, routine: name, what: "You made it" });
	}, ctx);
	await finishEdit(harness, workspace, name, ctx);
	await reconcile(harness, ctx);
	return name;
}

/**
 * Write an owner's edit of routine `name` into the box, if one waits: the box gets the accepted text unless it changed
 * to something else since (then that is a change of the box's own, which waits to be allowed), and the note goes.
 */
async function finishEdit(harness: Harness, workspace: Workspace, name: string, ctx: Context): Promise<void> {
	const records = (await harness.snapshot(Routines, ctx))?.routines ?? {};
	const edit = records[name]?.edit;
	if (edit === undefined) return;
	const file = (await harness.snapshot(Accepted, ctx))?.files[routinePath(name)];
	const box = await boxText(workspace, name, ctx);
	const held = edit.base === null ? box === undefined : box !== undefined && box !== null && shaOf(box) === edit.base;
	if (file?.sha === edit.sha && held) {
		if (edit.base === null) {
			const made = await workspace.env().createDir(`${workspace.root}/routines`, { recursive: true }, ctx);
			if (!made.ok) throw made.error;
		}
		await write(workspace.env(), workspace, `${workspace.root}/${routinePath(name)}`, file.text, ctx);
	}
	await harness.commit(async (tx) => {
		const record = (await tx.doc(Routines)).routines[name];
		if (record?.edit?.sha === edit.sha) delete record.edit;
	}, ctx);
}

/** Finish every owner's edit the box does not hold yet: on start, after a restart cut one short. */
export async function finishEdits(harness: Harness, workspace: Workspace, ctx: Context = context): Promise<void> {
	const records = (await harness.snapshot(Routines, ctx))?.routines ?? {};
	for (const [name, record] of Object.entries(records))
		if (record.edit !== undefined) await finishEdit(harness, workspace, name, ctx);
}

/** Run routine `name` once now, as the owner; once per click `key`. */
export async function runNow(
	run: (name: string, key: string) => Promise<"ran" | "already">,
	name: string,
	key: string,
): Promise<void> {
	if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) throw new BadRequest("key names the click: letters, digits and dashes");
	try {
		await run(named(name), key);
	} catch (error) {
		if (error instanceof RoutineRefused) throw new BadRequest(error.message, error.status);
		throw error;
	}
}

/** The control room, from the store. */
export async function control(
	harness: Harness,
	workspace: Workspace,
	now: number,
	ctx: Context = context,
): Promise<ControlView> {
	const paused = (await harness.snapshot(Control, ctx))?.paused;
	const activity = [...((await harness.snapshot(ActivityLog, ctx))?.events ?? [])].reverse();
	const permissions = (await openPermissions(harness, now, ctx)).map(
		({ id, permission, serves }): PermissionView => ({
			id,
			what: permission.what,
			scope: permission.scope,
			...(permission.until === undefined ? {} : { until: permission.until }),
			at: permission.at,
			...(permission.task === undefined ? {} : { chat: permission.task.chat }),
			...(permission.agent === undefined ? {} : { agent: permission.agent }),
			...(permission.scope === "host" && typeof permission.match._host === "string"
				? { host: permission.match._host }
				: {}),
			...(serves === undefined ? {} : { serves }),
		}),
	);
	return {
		...(paused === undefined ? {} : { paused }),
		routines: await routines(harness, workspace, now, ctx),
		activity,
		permissions,
		removed: { ...((await harness.snapshot(Accepted, ctx))?.removed ?? {}) },
	};
}
