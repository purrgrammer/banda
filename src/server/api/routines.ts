/**
 * The API's shapes for routines in full: how a routine stands, its next runs and last run, the owner changing when it
 * runs, and running it now. Slice 8, S7. Re-exported by `../api.ts`, whose `RoutineView` carries them.
 */

/**
 * How a routine stands, in one word the card shows: waiting for the owner to allow a change the box made, running on
 * schedule, paused by the owner, paused for running the most times a day it may, failing (its last run failed, or its check keeps failing), or a
 * one-time routine that ran.
 */
export type RoutineState = "allow" | "active" | "paused" | "limit" | "failing" | "done";

/** Its newest run: when, and whether it failed; what it said is in its chat. */
export type RoutineRun = {
	readonly at: number;
	readonly result: "ran" | "failed";
};

/**
 * One line of a routine's history (`GET /api/routines/:name/runs`), from its durable record and its chat: a run waiting
 * its turn behind the chat's other inputs, running, ended having said something (`said`, its first line), ended saying
 * nothing, failed (`why`), stopped, or a due time it skipped (`skipped`: its last run still went, its agent was not
 * active, or it reached its runs a day and paused itself). `line` is where the chat draws it, when it does: a quiet run
 * draws nothing (DESIGN.md "Routines"), so it has none.
 */
export type RoutineRunView = {
	readonly at: number;
	/** The owner's own Run now. */
	readonly owner?: true;
	readonly state: "waiting" | "running" | "said" | "quiet" | "failed" | "stopped" | "skipped";
	readonly said?: string;
	readonly why?: string;
	readonly skipped?: "running" | "inactive" | "limit";
	readonly line?: { readonly chat: number; readonly entry: number };
};

/**
 * A page of a routine's history, newest first; `earlier` is the `before` that reads the page older than it, while
 * there is one.
 */
export type RoutineRunsPage = { readonly runs: readonly RoutineRunView[]; readonly earlier?: number };

/**
 * The owner changes when a routine runs (`POST /api/routines/:name/when`): `when` as one line (`every 4h`,
 * `at 2026-11-02 09:00`, `cron 0 8 * * 1-5`), and `sha`, the hash of the version in effect the owner saw. In effect at
 * once, as the owner's own edit; refused (409) when the file changed since, or the box holds a change of its own
 * waiting to be allowed. Answers with the control view.
 */
export type RoutineWhen = { readonly when: string; readonly sha: string };

/**
 * Run a routine once now (`POST /api/routines/:name/run`): `key` names the click (letters, digits and dashes), so a click
 * sent twice runs once. Refused (409) while its last run still goes. Answers with the control view.
 */
export type RunNow = { readonly key: string };
