/**
 * Routines in the app: what the owner does to a routine, as one call each: allow or decline the box's change, pause,
 * resume, remove, change when it runs, and run it now. Each answers with the control view, as it is after.
 */
import type { RoutineRunsPage } from "../../../src/server/api.ts";
import { api, type ControlView, Refused } from "../lib/api.ts";
import type { ShellHandlers } from "../lib/shell.ts";

export const shell: ShellHandlers = {};

/** What the owner does to a routine. */
export type RoutineAct =
	/** Allow the box's change, as seen; with the owner's edit of what the agent wrote, made before allowing it. */
	| {
			readonly action: "accept";
			readonly sha: string | null;
			readonly when?: string;
			readonly description?: string;
			readonly ask?: string;
	  }
	| { readonly action: "decline" | "pause" | "resume" | "remove" }
	/** Change when it runs: one schedule line, and the hash of the version they saw. */
	| { readonly action: "when"; readonly when: string; readonly sha: string }
	/** Change it from its editor: what it is for, when it runs, what it does, bound to the version they saw. */
	| {
			readonly action: "edit";
			readonly sha: string;
			readonly when?: string;
			readonly description?: string;
			readonly ask?: string;
	  }
	/** Run it once now; `key` names the click, so a click sent twice runs once. */
	| { readonly action: "run"; readonly key: string };

/** A routine's id as the daemon gives it: `<agent>/<name>`, or a shared one's `<name>`. */
const ROUTINE_ID = /^(?:[a-z0-9-]+\/)?[a-z0-9-]+$/;

/**
 * Do `act` to routine `id`; rejects with why when the daemon refuses. The body names the routine again (`id`): that is
 * how the daemon tells this app from one built when a routine's id was its name alone. A view with no id is from a
 * daemon older than this app, whose routines this app cannot act on: refused here, before any request, with what to do.
 */
export function actOnRoutine(id: string, act: RoutineAct): Promise<ControlView> {
	if (typeof id !== "string" || !ROUTINE_ID.test(id))
		return Promise.reject(
			new Refused(
				"banda on this computer is older than this app and does not say which routine this is: update banda",
				400,
			),
		);
	const { action, ...body } = act;
	return api<ControlView>(`/routines/${id}/${action}`, { method: "POST", body: JSON.stringify({ ...body, id }) });
}

/**
 * Make a routine as the owner, for agent `agent` (its id): in effect at once. Its name, and the control view after.
 */
export const makeRoutine = (made: {
	readonly agent: string;
	readonly description: string;
	readonly when: string;
	readonly ask: string;
	/** The IANA time zone its times are in: the owner's, as this browser says. */
	readonly zone?: string;
}) => api<{ name: string; control: ControlView }>("/routines", { method: "POST", body: JSON.stringify(made) });

/** A new click's key. */
export const clickKey = (): string =>
	typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Routine `name`'s history, newest first: its runs before `before` (when one ran), or its newest. */
export const routineRuns = (name: string, before?: number) =>
	api<RoutineRunsPage>(`/routines/${name}/runs${before === undefined ? "" : `?before=${before}`}`);
