/**
 * The agents' browsers (DESIGN.md "The box", The browser): one Chromium per agent, its own profile and proxy login, so
 * what one agent signed in to another never acts with; and in it one tab per chat, so an agent's chats never blank
 * each other's page. Each tab stamps its requests with its chat (`TAB_HEADER`, marked by the daemon), and the proxy
 * takes a request of an agent's browser as the chat its stamp names, only while that chat holds a tab there: what a
 * tab reads is its own chat's alone, and a write waits for that chat.
 *
 * A process starts with its agent's first tab and ends once its last tab closed (a tab closes after a while unused).
 */
import {
	type Browser,
	type BrowserProcess,
	type BrowserSetup,
	type BrowserView,
	openBrowser,
	Refused,
} from "./browser.ts";
import { Cdp } from "./cdp.ts";

/** Each agent's tabs, by chat: whether the owner holds it. What the proxy is told. */
export type TabHolders = {
	readonly [agent: string]: { readonly tabs: { readonly [chat: string]: { readonly owner: boolean } } };
};

export type BrowsersOptions = {
	/** How agent `agent`'s browser starts: its command, its proxy login and its tabs' stamps. */
	readonly setup: (agent: string) => BrowserSetup;
	readonly ensure: () => Promise<void>;
	/** The agent chat `chat` runs; throws when it runs none. */
	readonly agentOf: (chat: number) => Promise<string>;
	/** The tabs changed: push them to the proxy; resolves once it knows. */
	readonly tell: (holders: TabHolders) => Promise<void>;
	/** Whose session a request of chat `chat` in agent `agent`'s browser goes with (`BrowserOptions.sessionAt`). */
	readonly sessionAt?: (
		agent: string,
		chat: number,
		url: string,
		cookies: readonly string[] | null,
	) => Promise<{ readonly site: string; readonly allowed: boolean } | undefined>;
	/** The owner, holding agent `agent`'s tab of chat `chat`, loaded a page from or wrote to `url`: they may be signed in there. */
	readonly log: (line: string) => void;
	/** Told whenever any tab's view changes. */
	readonly changed?: () => void;
	readonly idleMs?: number;
	readonly settleMs?: number;
	readonly fault?: (point: string) => void;
};

/** A tab, as the app sees it: the agent whose browser it is in, the chat it is (`tab`), and its view. */
export type AgentBrowserView = BrowserView & { readonly agent: string; readonly tab: number };

export type Browsers = {
	/** The tab of chat `chat`, in the browser of the agent it runs; opened (not started) the first time. */
	for(chat: number): Promise<Browser>;
	/** Every tab that was opened, as it stands. */
	views(): readonly AgentBrowserView[];
	/** The tabs as the proxy is told. */
	holders(): TabHolders;
	/** Sign agent `agent`'s browser out of `site`, starting it if it is closed. */
	forget(agent: string, site: string): Promise<void>;
	close(): void;
};

/** An agent's id: lowercase words and dashes, as an agent file's name is. */
const AGENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function openBrowsers(options: BrowsersOptions): Browsers {
	// by agent and chat: chat 0 (a sign-out with no tab open) is every agent's own
	const tabs = new Map<string, { readonly agent: string; readonly chat: number; readonly browser: Browser }>();
	const holders = new Map<string, { readonly agent: string; readonly chat: number; readonly owner: boolean }>();
	const processes = new Map<string, { cdp: Promise<Cdp>; users: number; started?: Cdp }>();
	let closed = false;

	const told = (): TabHolders => {
		const all: { [agent: string]: { tabs: { [chat: string]: { owner: boolean } } } } = {};
		for (const { agent, chat, owner } of holders.values()) {
			all[agent] ??= { tabs: {} };
			const tabsOf = all[agent];
			if (tabsOf !== undefined) tabsOf.tabs[chat] = { owner };
		}
		return all;
	};

	/** Agent `agent`'s process, started for its first tab; let go by each tab, ended with its last. */
	const processOf = async (agent: string, signal: AbortSignal): Promise<BrowserProcess> => {
		signal.throwIfAborted();
		if (closed) throw new Refused("The browsers are closed.");
		let found = processes.get(agent);
		if (found === undefined) {
			const cdp = Promise.resolve().then(async () => {
				const command = await options.setup(agent).command();
				const entry = processes.get(agent);
				if (closed || entry?.cdp !== cdp || entry.users === 0) throw new Refused("The browser was closed.");
				const started = new Cdp(command, (line) => options.log(`${agent}: ${line}`));
				entry.started = started;
				void started.ended.then(() => {
					if (processes.get(agent)?.cdp === cdp) processes.delete(agent);
				});
				try {
					await started.send("Target.setDiscoverTargets", { discover: true });
					await started.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => undefined);
					return started;
				} catch (error) {
					started.close();
					throw error;
				}
			});
			found = { cdp, users: 0 };
			processes.set(agent, found);
			cdp.catch(() => {
				if (processes.get(agent)?.cdp === cdp) processes.delete(agent);
			});
		}
		const entry = found;
		entry.users++;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			entry.users--;
			if (entry.users > 0 || processes.get(agent) !== entry) return;
			processes.delete(agent);
			entry.started?.close();
		};
		signal.addEventListener("abort", release, { once: true });
		try {
			const cdp = await entry.cdp;
			signal.throwIfAborted();
			return { cdp, release };
		} catch (error) {
			release();
			throw error;
		} finally {
			signal.removeEventListener("abort", release);
		}
	};

	/** The tab of `chat` in `agent`'s browser. */
	const tabOf = (agent: string, chat: number): Browser => {
		if (closed) throw new Refused("The browsers are closed.");
		if (!AGENT.test(agent)) throw new Error(`"${agent}" is not an agent's id`);
		const key = `${agent}:${chat}`;
		const found = tabs.get(key);
		if (found !== undefined) return found.browser;
		const browser = openBrowser({
			setup: options.setup(agent),
			ensure: options.ensure,
			process: (signal) => processOf(agent, signal),
			tell: async (holder) => {
				if (holder === undefined) holders.delete(key);
				else {
					// a tab is its chat's for good: it never holds another's page
					if (holder.chat !== chat) throw new Error(`chat ${chat}'s tab cannot hold chat ${holder.chat}`);
					holders.set(key, { agent, chat, owner: holder.owner });
				}
				await options.tell(told());
			},
			log: (line) => options.log(`${agent} (chat ${chat}): ${line}`),
			...(options.sessionAt === undefined
				? {}
				: {
						sessionAt: (tab: number, url: string, cookies: readonly string[] | null) =>
							options.sessionAt?.(agent, tab, url, cookies) ?? Promise.resolve(undefined),
					}),
			...(options.changed === undefined ? {} : { changed: options.changed }),
			...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
			...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
			...(options.fault === undefined ? {} : { fault: options.fault }),
		});
		tabs.set(key, { agent, chat, browser });
		return browser;
	};

	return {
		for: async (chat) => tabOf(await options.agentOf(chat), chat),
		// chat 0 is the tab a sign-out opens, nobody's page: the app never shows it
		views: () =>
			[...tabs.values()]
				.filter(({ chat }) => chat !== 0)
				.map(({ agent, chat, browser }) => ({ agent, tab: chat, ...browser.view() })),
		holders: told,
		forget: async (agent, site) => {
			// a running tab of the agent's forgets for all; with none, its own tab 0, which never holds a chat's page
			const running = [...tabs.values()].find((tab) => tab.agent === agent && tab.browser.view().running);
			await (running?.browser ?? tabOf(agent, 0)).forget(site);
		},
		close: () => {
			closed = true;
			for (const { browser } of tabs.values()) browser.close();
			tabs.clear();
			holders.clear();
			for (const { started } of processes.values()) started?.close();
			processes.clear();
		},
	};
}
