/**
 * The app's shell state, live: the chat list and the companion, from the daemon's shell stream, shared by
 * every screen. A dropped stream reopens after a pause, and the app says it cannot reach the daemon meanwhile.
 */
import { useSyncExternalStore } from "react";
import type { Tier } from "../../../src/core/tiers.ts";
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
	type WatchView,
} from "./api.ts";
import { checkForUpdate } from "./worker.ts";

/**
 * The shell's state. An area adds its own fields in its own file (`web/src/areas/<area>.ts`, augmenting this interface:
 * `declare module "../lib/shell.ts" { interface Shell { … } }`), optional, and its handlers set them.
 */
export interface Shell {
	/** The chat list. A chat's tier is not on its row here: `useChatTier` reads it. */
	readonly rows: readonly Omit<ChatRow, "tier" | "custom">[];
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
	chats: (event) => takeRows(event.rows),
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
	// nothing of the shell changed (a tier did): the state keeps its identity, and no screen renders
	if (Object.keys(next).length > 0) state = { ...state, ...next };
	for (const listener of listeners) listener();
}

/** How hard a chat thinks: the tier it runs on, and whether its agent's file names a model of its own instead. */
export type ChatTierView = { readonly tier: Tier | undefined; readonly custom: boolean };

const NO_TIER: ChatTierView = { tier: undefined, custom: false };

/**
 * Each chat's tier, apart from `state`: only the selector reads it, so a tier changing renders that and no other screen
 * that holds the shell.
 */
let tiers: ReadonlyMap<number, ChatTierView> = new Map();

/** Split the daemon's rows: the tiers kept apart, and the rows only if something other than a tier changed. */
function takeRows(rows: readonly ChatRow[]): Partial<Shell> {
	tiers = new Map(
		rows.flatMap((row): [number, ChatTierView][] => {
			if (row.tier === undefined) return [];
			const was = tiers.get(row.chat);
			const custom = row.custom === true;
			return [[row.chat, was?.tier === row.tier && was.custom === custom ? was : { tier: row.tier, custom }]];
		}),
	);
	const bare = rows.map(({ tier: _tier, custom: _custom, ...row }) => row);
	return JSON.stringify(bare) === JSON.stringify(state.rows) ? {} : { rows: bare };
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
/** What a watch's action answered: the control room and the watches as they are after. */
export const showWatching = (answer: { readonly control: ControlView; readonly watches: readonly WatchView[] }) =>
	set({ control: answer.control, watches: answer.watches });
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

// the same snapshot on the server: the specimen's registry test renders every component without a browser
const snapshot = () => state;

export function useShell(): Shell {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** One string `pick` makes of the shell: a component re-renders only when it changes, not at every event. */
export function useShellPick(pick: (shell: Shell) => string): string {
	const picked = () => pick(state);
	return useSyncExternalStore(subscribe, picked, picked);
}

/** Chat `chat`'s tier as the daemon last said; a component using it renders only when that changes. */
export function useChatTier(chat: number | undefined): ChatTierView {
	const picked = () => (chat === undefined ? undefined : tiers.get(chat)) ?? NO_TIER;
	return useSyncExternalStore(subscribe, picked, picked);
}

/** The agent chat `chat` runs, as the chat list says; the companion's when the list does not have it yet. */
export const chatAgentOf = (shell: Pick<Shell, "rows">, chat: number | undefined): string =>
	shell.rows.find((row) => row.chat === chat)?.agent ?? "sancho";
