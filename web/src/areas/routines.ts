/**
 * Routines in the app: what the owner does to a routine, as one call each: allow or decline the box's change, pause,
 * resume, remove, change when it runs, and run it now. Each answers with the control view, as it is after.
 */
import { api, type ControlView } from "../lib/api.ts";
import type { ShellHandlers } from "../lib/shell.ts";

export const shell: ShellHandlers = {};

/** What the owner does to a routine. */
export type RoutineAct =
	| { readonly action: "accept"; readonly sha: string | null }
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

/** Do `act` to routine `name`; rejects with why when the daemon refuses. */
export function actOnRoutine(name: string, act: RoutineAct): Promise<ControlView> {
	const { action, ...body } = act;
	return api<ControlView>(`/routines/${name}/${action}`, { method: "POST", body: JSON.stringify(body) });
}

/**
 * Make a routine as the owner, for agent `agent` (its id): in effect at once. Its name, and the control view after.
 */
export const makeRoutine = (made: {
	readonly agent: string;
	readonly description: string;
	readonly when: string;
	readonly ask: string;
}) => api<{ name: string; control: ControlView }>("/routines", { method: "POST", body: JSON.stringify(made) });

/** A new click's key. */
export const clickKey = (): string =>
	typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
