/**
 * An agent's routines in its panel, on the daemon's data: the rows (`routineRows`, pure, for the tests), a routine's
 * detail with its runs (`RoutineHistory`; its lines from `../lib/routine-runs.ts`) and the owner's own editor (`EditRoutine`),
 * which saves at once as the owner's file. A row's next run is read from the time the daemon last pushed its routines,
 * so it never ticks on its own: the daemon pushes again when a routine fires.
 */

import { useEffect, useRef, useState } from "react";
import { hostZone, parseSchedule, pickOf } from "../../../src/core/schedule.ts";
import type { RoutineRunView, RoutineView } from "../../../src/server/api.ts";
import { actOnRoutine, clickKey, makeRoutine, routineRuns } from "../areas/routines.ts";
import type { RoutineRowView } from "../chat/Panel.tsx";
import { RoutineDetail } from "../chat/RoutineDetail.tsx";
import { type RoutineDraft, RoutineEditor } from "../chat/RoutineEditor.tsx";
import { runRows } from "../lib/routine-runs.ts";
import { showControl } from "../lib/shell.ts";
import { nearTime, routineTitle } from "./titles.ts";

/** A time near `now`, lowercase where a sentence goes on: "today 09:00", "Fri 09:00". */
const near = (at: number, now: number) =>
	nearTime(at, now).replace(/^(Today|Tomorrow|Yesterday)/, (word) => word.toLowerCase());

/** How its newest run went, in words: "Last ran today 08:00", "Last run failed today 08:00". */
export function lastWords(last: RoutineView["last"], now: number): string | undefined {
	if (last === undefined) return undefined;
	return last.result === "failed" ? `Last run failed ${near(last.at, now)}` : `Last ran ${near(last.at, now)}`;
}

/**
 * Agent `agent`'s routines as its panel's rows, by name: each with when it runs in words, its next run and last run
 * read at `now`, and a change the agent made waiting for the owner, as it would be.
 */
export function routineRows(all: readonly RoutineView[], agent: string, now: number): RoutineRowView[] {
	return all
		.filter((routine) => routine.agent === agent)
		.flatMap((routine): RoutineRowView[] => {
			const change = routine.change;
			// a change waiting for the owner shows as it would be; a removal as the routine it stops
			const file =
				(change !== undefined && change.kind !== "removed" ? change.routine : undefined) ?? routine.accepted?.routine;
			if (file === undefined) return [];
			const waiting =
				change === undefined
					? undefined
					: change.kind === "removed"
						? ("stop" as const)
						: routine.accepted === undefined
							? ("set up" as const)
							: ("change" as const);
			const last = lastWords(routine.last, now);
			return [
				{
					id: routine.name,
					// its file's name as words: portugal-fun-fact reads Portugal fun fact
					name: routineTitle(routine.name, file.description),
					when: file.when,
					...(change === undefined
						? {}
						: {
								waiting,
								onAllow: () =>
									void actOnRoutine(routine.name, {
										action: "accept",
										sha: change.kind === "removed" ? null : (change.sha ?? null),
									}).then(showControl),
								onDecline: () => void actOnRoutine(routine.name, { action: "decline" }).then(showControl),
							}),
					...(routine.next === undefined ? {} : { next: near(routine.next, now) }),
					...(last === undefined ? {} : { last }),
					paused: routine.paused !== undefined,
				},
			];
		});
}

/** Its newest runs and the page before them, kept as the owner reads back. */
type Runs = { readonly runs: readonly RoutineRunView[]; readonly earlier?: number | undefined };

/**
 * Routine `routine`'s detail, wired to the daemon: its runs read when it opens and again whenever the daemon pushes a
 * change of it (a run fired or ended, it was paused), keeping the earlier pages the owner read; Pause and Resume in
 * effect at once; Edit, Back and a run's line handed up.
 */
export function RoutineHistory({
	routine,
	agent,
	chat,
	now,
	focusRun,
	onBack,
	onEdit,
	onOpenRun,
}: {
	routine: RoutineView;
	/** The agent's name. */
	agent: string;
	/** The agent's chat beside the panel, where a run's line is opened. */
	chat: number | undefined;
	now: number;
	focusRun?: number | undefined;
	onBack: () => void;
	onEdit: () => void;
	/** Show a run's line in the chat: the run's `at`, and its entry there. */
	onOpenRun: (at: number, entry: number) => void;
}) {
	const [runs, setRuns] = useState<Runs>();
	const [error, setError] = useState<string>();
	const [acting, setActing] = useState<string>();
	const kept = useRef<Runs | undefined>(undefined);
	kept.current = runs;
	// what the daemon says of it that moves its runs: a run fired, ended, or it was paused
	const moved = JSON.stringify([routine.lastRun, routine.running, routine.last, routine.paused, routine.state]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a push of its runs is what reads them again
	useEffect(() => {
		let live = true;
		routineRuns(routine.name).then(
			(newest) => {
				if (!live) return;
				setError(undefined);
				const was = kept.current;
				const oldest = newest.runs.at(-1)?.at;
				// the pages read further back stay, past the newest page
				const older = was === undefined || oldest === undefined ? [] : was.runs.filter((run) => run.at < oldest);
				setRuns({
					runs: [...newest.runs, ...older],
					earlier: older.length > 0 ? was?.earlier : newest.earlier,
				});
			},
			(failed: unknown) => {
				if (live) setError(failed instanceof Error ? failed.message : String(failed));
			},
		);
		return () => {
			live = false;
		};
	}, [routine.name, moved]);
	const file = routine.accepted?.routine;
	const paused = routine.paused !== undefined;
	const when = file?.when ?? "";
	return (
		<RoutineDetail
			routine={{
				title: routineTitle(routine.name, file?.description),
				when: paused || routine.next === undefined ? when : `${when} · next ${near(routine.next, now)}`,
				paused,
				pausedWhy: routine.paused === "limit" ? "it ran the most times a day it may" : undefined,
				runs:
					runs === undefined
						? undefined
						: runRows(runs.runs, now, agent, chat, (run, entry) => onOpenRun(run.at, entry)),
				error,
				refused: acting,
				earlier: runs?.earlier !== undefined,
			}}
			focusRun={focusRun}
			onBack={onBack}
			{...(routine.accepted?.sha === undefined ? {} : { onEdit })}
			onPause={(pause) => {
				setActing(undefined);
				void actOnRoutine(routine.name, { action: pause ? "pause" : "resume" }).then(showControl, (failed: unknown) =>
					setActing(failed instanceof Error ? failed.message : String(failed)),
				);
			}}
			onEarlier={() => {
				const before = runs?.earlier;
				if (before === undefined) return;
				void routineRuns(routine.name, before).then(
					(page) => setRuns((was) => ({ runs: [...(was?.runs ?? []), ...page.runs], earlier: page.earlier })),
					(failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)),
				);
			}}
		/>
	);
}

/** A routine in effect as its editor opens on it; undefined while it has no version in effect. */
function editedOf(routine: RoutineView, now: number) {
	const file = routine.accepted?.routine;
	const when = file === undefined ? undefined : parseSchedule(file.schedule, file.zone);
	if (file === undefined || when === undefined) return undefined;
	const draft: RoutineDraft = { description: file.description, pick: pickOf(when), ask: file.ask };
	return {
		title: routineTitle(routine.name, file.description),
		draft,
		paused: routine.paused !== undefined,
		last: lastWords(routine.last, now),
		zone: file.zone,
	};
}

/**
 * The owner's editor for routine `routine` of agent `agent` (none: a new one), wired to the daemon: each action in
 * effect at once; `onDone` closes it (saved, deleted, or Back).
 */
export function EditRoutine({
	agent,
	name,
	routine,
	now,
	onDone,
}: {
	/** The agent's id, whose chat it wakes. */
	agent: string;
	/** The agent's name, as the form says it. */
	name: string;
	routine?: RoutineView | undefined;
	now: number;
	onDone: () => void;
}) {
	const edited = routine === undefined ? undefined : editedOf(routine, now);
	const sha = routine?.accepted?.sha;
	return (
		<RoutineEditor
			key={routine === undefined ? "new" : `${routine.name}:${sha}`}
			agent={name}
			routine={edited}
			now={now}
			onBack={onDone}
			onSave={async (draft, when) => {
				if (routine === undefined || sha === undefined) {
					// the owner's times are on their own wall, wherever the daemon runs
					const made = await makeRoutine({
						agent,
						description: draft.description,
						when,
						ask: draft.ask,
						zone: hostZone(),
					});
					showControl(made.control);
				} else
					showControl(
						await actOnRoutine(routine.name, {
							action: "edit",
							sha,
							when,
							description: draft.description,
							ask: draft.ask,
						}),
					);
				onDone();
			}}
			{...(routine === undefined
				? {}
				: {
						onRunNow: () => actOnRoutine(routine.name, { action: "run", key: clickKey() }).then(showControl),
						onPause: (paused: boolean) =>
							actOnRoutine(routine.name, { action: paused ? "pause" : "resume" }).then(showControl),
						onDelete: () =>
							actOnRoutine(routine.name, { action: "remove" }).then((control) => {
								showControl(control);
								onDone();
							}),
					})}
		/>
	);
}
