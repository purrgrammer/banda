/**
 * The app's shell state, live: the chat list and the companion, from the daemon's shell stream, shared by
 * every screen. A dropped stream reopens after a pause, and the app says it cannot reach the daemon meanwhile.
 */
import { useSyncExternalStore } from "react";
import { AREA_HANDLERS } from "../areas/index.ts";
import {
	type AgentBrowserView,
	type AgentView,
	type BrowserView,
	type CapabilitiesView,
	type ChatRow,
	type CompanionView,
	type ComputerView,
	type ControlView,
	type MemoryView,
	type ShellEvent,
	shellEvents,
	takeReopen,
	Unauthorized,
} from "./api.ts";
import { checkForUpdate } from "./worker.ts";

/**
 * The shell's state. An area adds its own fields in its own file (`web/src/areas/<area>.ts`, augmenting this interface:
 * `declare module "../lib/shell.ts" { interface Shell { … } }`), optional, and its handlers set them.
 */
export interface Shell {
	readonly rows: readonly ChatRow[];
	readonly companion: CompanionView | undefined;
	/** The control room (`ControlView`), as the daemon last said. */
	readonly control: ControlView | undefined;
	/** The agents, each with the change its file in the box holds; and what the companion knows. */
	readonly agents: readonly AgentView[];
	readonly memory: MemoryView | undefined;
	/** The companion's computer: up, or offline (it then runs nothing), and how it reaches outside. */
	readonly computer: ComputerView | undefined;
	/** Its connections and the tools it made. */
	readonly capabilities: CapabilitiesView | undefined;
	/** Each agent's browser: open or not, whose page it shows, who holds it. */
	readonly browsers: readonly AgentBrowserView[];
	/** Whether the stream has said who the companion is yet. */
	readonly loaded: boolean;
	/** The daemon cannot be reached now. */
	readonly offline: boolean;
}

/** What each shell event changes in the shell's state, by its type. */
export type ShellHandlers = {
	readonly [T in ShellEvent["type"]]?: (event: Extract<ShellEvent, { type: T }>) => Partial<Shell>;
};

const CORE: ShellHandlers = {
	chats: (event) => ({ rows: event.rows }),
	// loaded once the companion came too, which the stream sends after the list: a screen never starts unnamed
	companion: (event) => ({ companion: event.companion, loaded: true }),
	control: (event) => ({ control: event.control }),
	agents: (event) => ({ agents: event.agents }),
	memory: (event) => ({ memory: event.memory }),
	computer: (event) => ({ computer: event.computer }),
	capabilities: (event) => ({ capabilities: event.capabilities }),
	browsers: (event) => ({ browsers: event.browsers }),
};

/** The daemon's events, then each area's own (an area's handler for a type replaces the core's). */
const HANDLERS: ShellHandlers = { ...CORE, ...AREA_HANDLERS };

const RETRY_MS = [500, 1000, 2000, 5000];

let state: Shell = {
	rows: [],
	companion: undefined,
	control: undefined,
	agents: [],
	memory: undefined,
	computer: undefined,
	capabilities: undefined,
	browsers: [],
	loaded: false,
	offline: false,
};
const listeners = new Set<() => void>();
let started = false;

function set(next: Partial<Shell>) {
	state = { ...state, ...next };
	for (const listener of listeners) listener();
}

async function run() {
	for (let failures = 0; ; ) {
		const stop = new AbortController();
		try {
			await shellEvents((event) => {
				failures = 0;
				if (state.offline) {
					set({ offline: false });
					// the daemon is back, perhaps with a new build
					checkForUpdate();
				}
				const handle = HANDLERS[event.type] as ((event: ShellEvent) => Partial<Shell>) | undefined;
				if (handle !== undefined) set(handle(event));
			}, stop.signal);
		} catch (error) {
			if (error instanceof Unauthorized) return;
		}
		// it ended to reopen for the chat now on screen: at once, not as an outage
		if (takeReopen()) continue;
		// the stream ended or never opened: the daemon stopped, or cannot be reached
		set({ offline: true });
		await new Promise((resolve) => setTimeout(resolve, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]));
	}
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (!started) {
		started = true;
		void run();
	}
	return () => listeners.delete(listener);
}

/** Take what an action answered at once, before the stream says it too. */
export const showControl = (control: ControlView) => set({ control });
export const showMemory = (memory: MemoryView) => set({ memory });
export const showAgents = (agents: readonly AgentView[]) => set({ agents });
export const showCapabilities = (capabilities: CapabilitiesView) => set({ capabilities });
/** Take what an action answered about chat `chat`'s tab at once, before the stream says it too. */
export const showBrowser = (chat: number, view: BrowserView) => {
	const was = state.browsers.find((each) => each.tab === chat);
	set({
		browsers: [
			...state.browsers.filter((each) => each.tab !== chat),
			{ agent: was?.agent ?? chatAgentOf(state, chat), tab: chat, ...view },
		],
	});
};

/** Chat `chat`'s tab, in the browser of the agent it runs, as the daemon last said; none until it was opened. */
export const browserOf = (shell: Pick<Shell, "browsers">, chat: number | undefined): AgentBrowserView | undefined =>
	chat === undefined ? undefined : shell.browsers.find((each) => each.tab === chat);

export function useShell(): Shell {
	return useSyncExternalStore(subscribe, () => state);
}

/** One string `pick` makes of the shell: a component re-renders only when it changes, not at every event. */
export function useShellPick(pick: (shell: Shell) => string): string {
	return useSyncExternalStore(subscribe, () => pick(state));
}

/** The agent chat `chat` runs, as the chat list says; the companion's when the list does not have it yet. */
export const chatAgentOf = (shell: Pick<Shell, "rows">, chat: number | undefined): string =>
	shell.rows.find((row) => row.chat === chat)?.agent ?? "sancho";
