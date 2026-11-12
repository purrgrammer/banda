/**
 * A routine's detail, in the agent's panel where its row was (DESIGN.md "Routines"): "‹ Routines" back to the list, its
 * name, when it runs and its next run, one Pause or Resume that says its state in words, and Edit, which puts the
 * owner's editor in its place. Beneath, its runs, newest first, each one line: when, and what came of it in words
 * (never colour alone). Silence is the default, so a run that said nothing is quiet ink with no chevron; a run whose
 * line is in the chat opens it there. Ten in view, and "Show earlier".
 */
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import type { RunRowView } from "../lib/routine-runs.ts";

export type RoutineDetailView = {
	readonly title: string;
	/** When it runs, in words, and its next run or that it is paused: "Weekdays at 08:00 · next Thu 08:00". */
	readonly when: string;
	readonly paused: boolean;
	/** Why it is paused, when not by the owner: "it ran the most times a day it may". */
	readonly pausedWhy?: string | undefined;
	/**
	 * Routines are off for every agent (the list's switch): nothing runs, and its own Pause waits until they are on
	 * again, as the list's rows do.
	 */
	readonly allPaused?: boolean | undefined;
	/**
	 * A change the agent asked for waits for the owner ("Mara asks to change it"): it is allowed or declined where it
	 * asked, and Edit waits until then, since the daemon would refuse an edit over it.
	 */
	readonly waiting?: string | undefined;
	/** Its runs, newest first; undefined while they load. */
	readonly runs: readonly RunRowView[] | undefined;
	/** Why its runs could not be read, in the daemon's words. */
	readonly error?: string | undefined;
	/** Why the daemon refused Pause or Resume, in its words. */
	readonly refused?: string | undefined;
	/** Why the earlier runs could not be read, in the daemon's words: the runs already read stay. */
	readonly earlierError?: string | undefined;
	/** There are runs older than these. */
	readonly earlier: boolean;
	/** Its record keeps no older runs than these: older ones are in the chat alone. */
	readonly full?: boolean | undefined;
};

export function RoutineDetail({
	routine,
	focusRun,
	onBack,
	onEdit,
	onPause,
	onEarlier,
}: {
	routine: RoutineDetailView;
	/** The run the owner last opened: focus goes back to its line when the detail shows again. */
	focusRun?: number | undefined;
	onBack: () => void;
	onEdit?: (() => void) | undefined;
	/** Pause it (true) or resume it (false). */
	onPause?: ((paused: boolean) => void) | undefined;
	onEarlier?: (() => void) | undefined;
}) {
	const list = useRef<HTMLUListElement>(null);
	const loaded = routine.runs !== undefined;
	useEffect(() => {
		if (focusRun === undefined || !loaded) return;
		list.current?.querySelector<HTMLElement>(`[data-run="${focusRun}"]`)?.focus();
	}, [focusRun, loaded]);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-12 shrink-0 items-center border-b border-line-soft px-2">
				<Button variant="ghost" size="sm" className="gap-1 px-2 text-ink-2" onClick={onBack}>
					<ChevronLeftIcon className="size-4" />
					Routines
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
				<div className="flex flex-col gap-3">
					<span className="flex min-w-0 flex-col gap-0.5">
						<h2 className="text-body font-semibold text-ink">{routine.title}</h2>
						<span className="text-meta text-ink-2">{routine.when}</span>
						{routine.allPaused === true ? (
							<span className="text-meta font-medium text-ink">
								Paused: routines are off. Turn them on in the list to run it.
							</span>
						) : routine.paused ? (
							<span className="text-meta font-medium text-ink">
								{routine.pausedWhy === undefined ? "Paused" : `Paused: ${routine.pausedWhy}`}
							</span>
						) : null}
						{routine.waiting === undefined ? null : (
							<span className="text-meta font-medium text-ink">Waiting for you: {routine.waiting}</span>
						)}
					</span>
					<span className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={onPause === undefined || routine.allPaused === true}
							onClick={() => onPause?.(!routine.paused)}
						>
							{routine.paused ? "Resume" : "Pause"}
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={onEdit === undefined || routine.waiting !== undefined}
							onClick={onEdit}
						>
							Edit
						</Button>
					</span>
					{routine.refused === undefined ? null : (
						<p role="alert" className="text-meta text-danger">
							{routine.refused}
						</p>
					)}
				</div>
				<section className="flex flex-col gap-1" aria-labelledby="routine-runs">
					<h3 id="routine-runs" className="text-meta font-medium text-ink-2">
						Runs
					</h3>
					{routine.error !== undefined ? (
						<p className="text-meta text-danger">Couldn't read its runs: {routine.error}</p>
					) : routine.runs === undefined ? (
						<span className="flex items-center gap-2 py-2 text-meta text-ink-2">
							<Spinner className="size-3.5" />
							Reading its runs…
						</span>
					) : routine.runs.length === 0 ? (
						<p className="py-2 text-meta text-ink-2">
							No runs yet. What it finds lands in the chat; when it finds nothing, it stays quiet.
						</p>
					) : (
						<ul ref={list} className="flex flex-col divide-y divide-line-soft">
							{routine.runs.map((run) => (
								<RunRow key={run.key} run={run} />
							))}
						</ul>
					)}
					{routine.earlierError === undefined ? null : (
						<p role="alert" className="text-meta text-danger">
							Couldn't read earlier runs: {routine.earlierError}
						</p>
					)}
					{routine.full === true && !routine.earlier && routine.runs !== undefined ? (
						<p className="mt-2 text-meta text-ink-2">Older runs are in the chat.</p>
					) : null}
					{routine.earlier && routine.runs !== undefined ? (
						<button
							type="button"
							onClick={onEarlier}
							className="mt-2 min-h-9 self-center text-meta text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink"
						>
							Show earlier
						</button>
					) : null}
				</section>
			</div>
		</div>
	);
}

function RunRow({ run }: { run: RunRowView }) {
	const words = (
		<span className="flex min-w-0 flex-1 flex-col">
			<span className="text-meta text-ink-2">{run.when}</span>
			<span
				className={cn(
					"text-ui",
					run.tone === "said" && "font-medium text-ink",
					run.tone === "trouble" && "font-medium text-danger",
					run.tone === "live" && "text-ink",
					run.tone === "quiet" && "text-ink-2",
				)}
			>
				{run.words}
			</span>
		</span>
	);
	if (run.onOpen === undefined)
		return (
			<li className="flex min-h-12 items-center px-1 py-2 outline-none" data-run={run.key} tabIndex={-1}>
				{words}
			</li>
		);
	return (
		<li>
			<button
				type="button"
				data-run={run.key}
				onClick={run.onOpen}
				aria-label={`${run.when}: ${run.words}. Show it in the chat`}
				className="flex min-h-12 w-full items-center gap-2 rounded-field px-1 py-2 text-left outline-none hover:bg-paper-3 focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-focus"
			>
				{words}
				<ChevronRightIcon className="size-4 shrink-0 text-ink-2" />
			</button>
		</li>
	);
}
