/**
 * routines in the box against their accepted versions, as agents are (DESIGN.md "The workspace"), and the control room
 * the app reads. A routine file is a "before" file: the owner allows a change by the hash of the text the app
 * showed them ("Allow this routine?"), and only the store's copy runs. The owner's own changes (removing a routine, pausing
 * one, when it runs, running it now) take effect at once.
 */
import type { Context } from "@earendil-works/chord/context";
import type { Harness, TaskId, Tx } from "@earendil-works/pi-durable";
import { ActivityLog, log } from "../core/activity.ts";
import {
	Accepted,
	AGENT_NAME,
	acceptedAgent,
	activeAgents,
	agentPath,
	agentWords,
	isArchived,
	shaOf,
	unaccept,
} from "../core/agents.ts";
import { fileNameFor } from "../core/names.ts";
import { openPermissions } from "../core/permissions.ts";
import {
	ALLOWED_KEPT,
	Control,
	DEFAULT_RUNS_A_DAY,
	dueOf,
	folderChain,
	MAX_ROUTINE_BYTES,
	parseRoutine,
	type Routine,
	type RoutineRecord,
	RoutineRefused,
	Routines,
	routineAgent,
	routineFolder,
	routineId,
	routineName,
	routineOfPath,
	routinePath,
	routineRef,
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

const fileView = (id: string, sha: string, text: string): RoutineFileView => {
	const parsed = parseRoutine(routineName(id), text);
	return { sha, ...("routine" in parsed ? { routine: summary(parsed.routine) } : { errors: parsed.errors }) };
};

type BoxFile = { readonly text: string } | { readonly unreadable: string };

/**
 * Every routine file in the box, by id: the shared ones in `routines/`, and each agent's own in its folder,
 * `agents/<agent>/routines/`; each folder a real one, never one reached through a link.
 */
async function routineFiles(workspace: Workspace, ctx: Context): Promise<{ files: Map<string, BoxFile> }> {
	const files = new Map<string, BoxFile>(
		(await realFolder(workspace, "routines", ctx))
			? (await boxFiles(workspace, ctx, "routines", MAX_ROUTINE_BYTES)).files
			: [],
	);
	if (!(await realFolder(workspace, "agents", ctx))) return { files };
	const listed = await workspace.env().listDir(`${workspace.root}/agents`, ctx);
	if (!listed.ok) {
		if (listed.error.code === "not_found") return { files };
		throw listed.error;
	}
	for (const entry of listed.value) {
		if (entry.kind !== "directory" || !AGENT_NAME.test(entry.name)) continue;
		const folder = `agents/${entry.name}/routines`;
		if (!(await realFolder(workspace, folder, ctx))) continue;
		const own = await boxFiles(workspace, ctx, folder, MAX_ROUTINE_BYTES);
		for (const [name, file] of own.files) files.set(routineId({ agent: entry.name, name }), file);
	}
	return { files };
}

/**
 * Whether `folder` (relative to the workspace) is a folder itself, never a link: an agent's routines folder linked to
 * another's would show one file as two agents' routines.
 */
async function realFolder(workspace: Workspace, folder: string, ctx: Context): Promise<boolean> {
	const info = await workspace.env().fileInfo(`${workspace.root}/${folder}`, ctx);
	if (!info.ok) {
		if (info.error.code === "not_found") return false;
		throw info.error;
	}
	return info.value.kind === "directory";
}

/** Routine `id`'s file in the box, read from its own folder alone; none while that folder is no real folder. */
async function routineFile(workspace: Workspace, id: string, ctx: Context): Promise<BoxFile | undefined> {
	for (const folder of folderChain(id)) if (!(await realFolder(workspace, folder, ctx))) return undefined;
	return (await boxFiles(workspace, ctx, routineFolder(id), MAX_ROUTINE_BYTES)).files.get(routineName(id));
}

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

/**
 * Every routine, accepted or only in the box, with the change the box holds and its state: each agent's own and the
 * shared ones, by id, a name shared by several being several routines.
 */
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
	const ids = new Set([
		...Object.keys(accepted).flatMap((path) => routineOfPath(path) ?? []),
		...(boxed?.keys() ?? []),
	]);
	const views = await Promise.all(
		[...ids].map(async (id): Promise<RoutineView> => {
			const name = routineName(id);
			const file = accepted[routinePath(id)];
			const box = boxed?.get(id);
			const record: RoutineRecord = records[id] ?? {};
			const change: RoutineView["change"] =
				boxed === undefined
					? undefined
					: box === undefined
						? // the owner's own new routine the box does not hold yet is no removal of the box's
							file === undefined || record.edit?.base === null
							? undefined
							: { kind: "removed" }
						: "unreadable" in box
							? { kind: file === undefined ? "added" : "changed", errors: [`${routinePath(id)}: ${box.unreadable}`] }
							: // the owner's own edit the box does not hold yet is no change of the box's
								shaOf(box.text) === file?.sha || shaOf(box.text) === record.edit?.base
								? undefined
								: { kind: file === undefined ? "added" : "changed", ...fileView(id, shaOf(box.text), box.text) };
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
				id,
				name,
				...(file === undefined ? {} : { accepted: fileView(id, file.sha, file.text) }),
				...(change === undefined ? {} : { change }),
				...(next === undefined ? {} : { next }),
				...(runs.length === 0 ? {} : { nextRuns: runs }),
				...(week.length === 0 ? {} : { week }),
				...(last === undefined ? {} : { last }),
				...(record.paused === undefined ? {} : { paused: record.paused }),
				...(record.done === undefined ? {} : { done: record.done }),
				...(record.wakes?.length ? { lastRun: record.wakes.at(-1) } : {}),
				...(turn !== undefined && turn.state.status !== "terminal" ? { running: true } : {}),

				agent: routineAgent(id, record),
				...(routineRef(id)?.agent === undefined ? { shared: true as const } : {}),
				...(record.allowed?.length ? { allowed: [...record.allowed] } : {}),
				...(record.edited?.length ? { edited: [...record.edited] } : {}),
			};
			return { ...view, state: stateOf(view, record) };
		}),
	);
	// routines of one name that wake the same agent: each says the others, so neither runs beside the other unseen
	const twinned = views.map((view) => {
		const twins = views
			.filter((each) => each.id !== view.id && each.name === view.name && each.agent === view.agent)
			.map((each) => each.id);
		return twins.length === 0 ? view : { ...view, twins };
	});
	return twinned.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** `id`, when it is a routine's id: `<agent>/<name>`, or a shared routine's `<name>`. */
const identified = (id: string) => {
	if (routineRef(id) === undefined) throw new BadRequest(`"${id}" is not a routine's id`);
	return id;
};

/**
 * Allow the box's change to routine `id`, as the owner saw it: `sha` is the hash of the text shown, or null for a
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
	id: string,
	sha: string | null,
	now: number,
	ctx: Context = context,
	change: RoutineChange = {},
	/** Tell the routine's agent, in the commit that allows it, which of its text the owner edited. */
	told?: (tx: Tx, agent: string, fields: readonly string[]) => Promise<void>,
): Promise<void> {
	const box = await routineFile(workspace, identified(id), ctx);
	if (sha === null) {
		if (Object.keys(change).length > 0) throw new BadRequest("a removal has nothing to edit");
		if (box !== undefined) throw new BadRequest(`${routinePath(id)} is back in the box: look again`, 409);
		await harness.commit(async (tx) => {
			await unaccept(tx, routinePath(id), now);
			await log(tx, { at: now, routine: id, what: "You removed it" });
		}, ctx);
	} else {
		if (box === undefined || "unreadable" in box || shaOf(box.text) !== sha)
			throw new BadRequest(`${routinePath(id)} changed since you saw it: look again`, 409);
		const parsed = parseRoutine(routineName(id), box.text);
		if ("errors" in parsed) throw new BadRequest(parsed.errors.join("\n"));
		const { text, fields } = editedText(id, box.text, parsed.routine, change, now);
		const runs = shaOf(text);
		await harness.commit(async (tx) => {
			// a routine in an agent's folder runs as that agent: allowed only for one that is there to run it
			const owner = routineRef(id)?.agent;
			if (owner !== undefined && (await acceptedAgent(tx, owner)) === undefined)
				throw new BadRequest(`${agentPath(owner)} is no agent: a routine in its folder has no one to run as`, 409);
			if (owner !== undefined && (await isArchived(tx, owner)))
				throw new BadRequest(`${await agentWords(tx, owner)} is archived: restore it first`, 409);
			const files = (await tx.doc(Accepted)).files;
			const known = files[routinePath(id)] !== undefined;
			files[routinePath(id)] = { sha: runs, text, at: now };
			const { routines } = await tx.doc(Routines);
			routines[id] ??= {};
			const record = routines[id] as RoutineRecord;
			record.allowed = [...(record.allowed ?? []).filter((each) => each !== sha), sha].slice(-ALLOWED_KEPT);
			if (runs !== sha) {
				record.edited = [...(record.edited ?? []).filter((each) => each !== sha), sha].slice(-ALLOWED_KEPT);
				// the box holds the agent's version: it gets the owner's, as after any edit of theirs
				record.edit = { sha: runs, base: sha };
			}
			if (runs !== sha) await told?.(tx, routineAgent(id, record), fields);
			const how = runs === sha ? "" : ", edited";
			await log(tx, { at: now, routine: id, what: known ? `You allowed its change${how}` : `You allowed it${how}` });
		}, ctx);
		if (runs !== sha) await finishEdit(harness, workspace, id, ctx);
	}
	await reconcile(harness, ctx);
}

/**
 * The box's routine file `text` with the owner's `change` in it, every other byte as the agent wrote it, checked as any
 * routine file is, and which of what the agent wrote it changes (an edit that gives the same words back changes nothing);
 * `text` itself when they changed nothing.
 */
function editedText(
	id: string,
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
	const parsed = next === undefined ? undefined : parseRoutine(routineName(id), next);
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

/** Decline the box's change to routine `id`: the accepted file is written back, or a new one removed. */
export async function decline(harness: Harness, workspace: Workspace, id: string, ctx: Context = context) {
	const file = (await harness.snapshot(Accepted, ctx))?.files[routinePath(identified(id))];
	const env = workspace.env();
	const path = `${workspace.root}/${routinePath(id)}`;
	if (file !== undefined) return write(env, workspace, path, file.text, ctx);
	const removed = await env.remove(path, { force: true }, ctx);
	if (!removed.ok) throw removed.error;
}

/** Remove routine `id`, as the owner: its file goes from the box and the store, and it never runs again. */
export async function remove(
	harness: Harness,
	workspace: Workspace,
	reconcile: Reconcile,
	id: string,
	now: number,
	ctx: Context = context,
): Promise<void> {
	const removed = await workspace
		.env()
		.remove(`${workspace.root}/${routinePath(identified(id))}`, { force: true }, ctx);
	if (!removed.ok) throw removed.error;
	await harness.commit(async (tx) => {
		const files = (await tx.doc(Accepted)).files;
		if (files[routinePath(id)] === undefined) return;
		delete files[routinePath(id)];
		await log(tx, { at: now, routine: id, what: "You removed it" });
	}, ctx);
	await reconcile(harness, ctx);
}

/** The box's routine file `id` as it is now: its text, none, or unreadable. */
async function boxText(workspace: Workspace, id: string, ctx: Context): Promise<string | undefined | null> {
	const box = await routineFile(workspace, id, ctx);
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
	id: string,
	change: RoutineChange,
	sha: string,
	now: number,
	ctx: Context = context,
): Promise<void> {
	const description = change.description === undefined ? undefined : descriptionOf(change.description);
	const ask = change.ask === undefined ? undefined : askOf(change.ask);
	const file = (await harness.snapshot(Accepted, ctx))?.files[routinePath(identified(id))];
	if (file === undefined) throw new BadRequest(`there is no routine ${id}`, 404);
	// the owner's times are on the wall the routine keeps: its zone stays as it was
	const was = parseRoutine(routineName(id), file.text);
	const zone = "routine" in was && !("every" in was.routine.when) ? was.routine.when.zone : undefined;
	const schedule = change.when === undefined ? undefined : scheduleOf(change.when, now, zone);
	if (file.sha !== sha) throw new BadRequest("it changed since you saw it: look again", 409);
	const box = await boxText(workspace, id, ctx);
	if (box === null) throw new BadRequest("it has a change waiting for you to allow it: answer that first", 409);
	const pending = (await harness.snapshot(Routines, ctx))?.routines[id]?.edit;
	// the box holds what is in effect, or what was before an edit of the owner's it does not hold yet
	const base = box === undefined ? null : shaOf(box);
	if (base !== sha && !(pending?.sha === sha && pending.base === base))
		throw new BadRequest("it has a change waiting for you to allow it: answer that first", 409);
	let text: string | undefined = file.text;
	if (schedule !== undefined) text = withWhen(text, scheduleText(schedule));
	if (description !== undefined && text !== undefined) text = withDescription(text, description);
	if (ask !== undefined && text !== undefined) text = withAsk(text, ask);
	const parsed = text === undefined ? undefined : parseRoutine(routineName(id), text);
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
		if (files[routinePath(id)]?.sha !== sha) throw new BadRequest("it changed since you saw it: look again", 409);
		files[routinePath(id)] = { sha: changed, text: edited, at: now };
		const { routines } = await tx.doc(Routines);
		routines[id] ??= {};
		(routines[id] as RoutineRecord).edit = { sha: changed, base };
		await log(tx, { at: now, routine: id, what });
	}, ctx);
	await finishEdit(harness, workspace, id, ctx);
	await reconcile(harness, ctx);
}

/** Change when routine `id` runs, as the owner: `changeRoutine` with the schedule alone. */
export const changeWhen = (
	harness: Harness,
	workspace: Workspace,
	reconcile: Reconcile,
	id: string,
	when: string,
	sha: string,
	now: number,
	ctx: Context = context,
): Promise<void> => changeRoutine(harness, workspace, reconcile, id, { when }, sha, now, ctx);

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
 * Make a routine as the owner, from the panel: a file the daemon writes as the owner's own, in effect at once, in the
 * folder of agent `agent`, whose chat it wakes. Named after what it is for, a number added when that agent has a routine
 * of that name (in effect or in the box): another agent's, or a shared one, takes no name from it. The store accepts it
 * first and notes the box still needs it (`base` null: the box has no such file), so a restart between the two
 * finishes the box's copy. Its id.
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
	const own = (each: string) => routineId({ agent: made.agent, name: each });
	const boxed = (await boxFiles(workspace, ctx, routineFolder(own(nameFor(description))), MAX_ROUTINE_BYTES)).files;
	const base = nameFor(description);
	let name = base;
	for (let n = 2; accepted[routinePath(own(name))] !== undefined || boxed.has(name); n++) name = `${base}-${n}`;
	const id = own(name);
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
		if (files[routinePath(id)] !== undefined) throw new BadRequest(`${name} was just made: look again`, 409);
		files[routinePath(id)] = { sha, text, at: now };
		const { routines } = await tx.doc(Routines);
		routines[id] = { agent: made.agent, edit: { sha, base: null } };
		await log(tx, { at: now, routine: id, what: "You made it" });
	}, ctx);
	await finishEdit(harness, workspace, id, ctx);
	await reconcile(harness, ctx);
	return id;
}

/**
 * Write an owner's edit of routine `id` into the box, if one waits: the box gets the accepted text unless it changed
 * to something else since (then that is a change of the box's own, which waits to be allowed), and the note goes.
 */
async function finishEdit(harness: Harness, workspace: Workspace, id: string, ctx: Context): Promise<void> {
	const records = (await harness.snapshot(Routines, ctx))?.routines ?? {};
	const edit = records[id]?.edit;
	if (edit === undefined) return;
	const file = (await harness.snapshot(Accepted, ctx))?.files[routinePath(id)];
	const box = await boxText(workspace, id, ctx);
	const held = edit.base === null ? box === undefined : box !== undefined && box !== null && shaOf(box) === edit.base;
	if (file?.sha === edit.sha && held) {
		if (edit.base === null) {
			const made = await workspace.env().createDir(`${workspace.root}/${routineFolder(id)}`, { recursive: true }, ctx);
			if (!made.ok) throw made.error;
		}
		for (const folder of folderChain(id))
			if (!(await realFolder(workspace, folder, ctx)))
				throw new Error(`${folder} is not a folder: the box keeps no copy`);
		await write(workspace.env(), workspace, `${workspace.root}/${routinePath(id)}`, file.text, ctx);
	}
	await harness.commit(async (tx) => {
		const record = (await tx.doc(Routines)).routines[id];
		if (record?.edit?.sha === edit.sha) delete record.edit;
	}, ctx);
}

/** Finish every owner's edit the box does not hold yet: on start, after a restart cut one short. */
export async function finishEdits(harness: Harness, workspace: Workspace, ctx: Context = context): Promise<void> {
	const records = (await harness.snapshot(Routines, ctx))?.routines ?? {};
	for (const [id, record] of Object.entries(records))
		if (record.edit !== undefined && routineRef(id) !== undefined) await finishEdit(harness, workspace, id, ctx);
}

/** Run routine `id` once now, as the owner; once per click `key`. */
export async function runNow(
	run: (id: string, key: string) => Promise<"ran" | "already">,
	id: string,
	key: string,
): Promise<void> {
	if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) throw new BadRequest("key names the click: letters, digits and dashes");
	try {
		await run(identified(id), key);
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
