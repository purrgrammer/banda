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
