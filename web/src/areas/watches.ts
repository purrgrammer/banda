/**
 * Watches in the app: what the owner does to a watch, as one call each: allow or decline the box's change, change
 * its words, pause, resume, remove, and check now. Each answers with the control view, as it is after. And following
 * an object from its card or the panel, as the owner, in effect at once.
 */
import type { Looked } from "../../../src/core/watches.ts";
import { api, type ControlView, type WatchView } from "../lib/api.ts";
import type { ShellHandlers } from "../lib/shell.ts";

declare module "../lib/shell.ts" {
	interface Shell {
		/** Every watch, as the daemon last pushed them; undefined until it said. */
		readonly watches?: readonly WatchView[];
	}
}

export const shell: ShellHandlers = {
	watches: (event) => ({ watches: event.watches }),
};

/** What the owner does to a watch. */
export type WatchAct =
	| { readonly action: "accept"; readonly sha: string | null }
	| { readonly action: "decline" | "pause" | "resume" | "remove" }
	/**
	 * Change what ends it (null: any of its ends), the most times it may wake in a day and what matters, over the
	 * version `sha` the owner saw.
	 */
	| {
			readonly action: "edit";
			readonly sha: string;
			readonly until?: string | null;
			readonly wakesADay?: number;
			readonly ask?: string;
	  }
	/** Look now; `key` names the click, so a click sent twice looks once. */
	| { readonly action: "check"; readonly key: string };

/** What every watch action answers: the control room and the watches as they are after. */
export type Watching = { readonly control: ControlView; readonly watches: readonly WatchView[] };

/** Do `act` to watch `name`; rejects with why when the daemon refuses. */
export async function actOnWatch(name: string, act: WatchAct): Promise<Watching> {
	const { action, ...body } = act;
	const { control, watches } = await api<Watching & { looked?: Looked }>(`/watches/${name}/${action}`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	return { control, watches };
}

/**
 * Follow an object as the owner, for agent `agent` (its id): a watch in effect at once, its first look made before it
 * is. Its name, and the control room and the watches after.
 */
export const follow = (made: {
	readonly agent: string;
	/** The object: a link, or its canonical key as a card names it. */
	readonly object: string;
	readonly until?: string;
	readonly ask?: string;
}) => api<Watching & { name: string }>("/watches", { method: "POST", body: JSON.stringify(made) });
