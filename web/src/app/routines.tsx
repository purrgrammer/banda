/**
 * An agent's routines in its panel, on the daemon's data: the rows (`routineRows`, pure, for the tests) and the owner's
 * own editor (`EditRoutine`), which saves at once as the owner's file. A row's next run is read from the time the
 * daemon last pushed its routines, so it never ticks on its own: the daemon pushes again when a routine fires.
 */

import { hostZone, parseSchedule, pickOf } from "../../../src/core/schedule.ts";
import type { RoutineView } from "../../../src/server/api.ts";
import { actOnRoutine, clickKey, makeRoutine } from "../areas/routines.ts";
import type { RoutineRowView } from "../chat/Panel.tsx";
import { type RoutineDraft, RoutineEditor } from "../chat/RoutineEditor.tsx";
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
