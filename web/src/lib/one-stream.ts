/**
 * One stream a page (`GET /api/events?chat=`): the shell, and the live events of the chat on screen. A browser holds
 * only a few connections to one host, so a stream for each would leave a page with several tabs waiting on none.
 * A new reader reopens the one stream, so it hears the chat's `ready`. Pure but for `open`, so the tests drive it.
 */
import type { LiveEvent, ShellEvent } from "../../../src/server/api.ts";

/** Read the stream at `path` until `signal` aborts or it ends. */
export type Open = (path: string, onEvent: (event: ShellEvent) => void, signal: AbortSignal) => Promise<void>;

export function oneStream(open: Open) {
	type Watcher = (event: LiveEvent | { readonly type: "gone" }) => void;
	const watchers = new Map<number, Set<Watcher>>();
	let watched: number | undefined;
	let reopen: (() => void) | undefined;
	let reopening = false;

	/** Whether the shell stream just ended to reopen for another chat (its reader then reconnects at once). */
	function takeReopen(): boolean {
		const was = reopening;
		reopening = false;
		return was;
	}

	/** Read chat `chat`'s live events, through the page's one stream, until `signal` aborts; rejects for no such chat. */
	function events(chat: number, onEvent: (event: LiveEvent) => void, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const set = watchers.get(chat) ?? new Set<Watcher>();
			watchers.set(chat, set);
			const cleanup = () => {
				set.delete(listener);
				if (set.size === 0) watchers.delete(chat);
			};
			const listener: Watcher = (event) => {
				if (event.type === "gone") {
					cleanup();
					reject(new Error("no such chat"));
				} else onEvent(event);
			};
			set.add(listener);
			signal.addEventListener(
				"abort",
				() => {
					cleanup();
					resolve();
				},
				{ once: true },
			);
			// every new reader needs the chat's `ready`, which the stream sends as it opens: so it reopens, once for every
			// reader that arrived together, even for the chat it already watches (one left and came back)
			watched = chat;
			if (!pending) {
				pending = true;
				queueMicrotask(() => {
					pending = false;
					// no stream yet: the one that starts opens for `watched`
					if (reopen === undefined) return;
					reopening = true;
					reopen();
				});
			}
		});
	}
	let pending = false;

	/** Read the shell, whole on every change, and the watched chat's live events, until `signal` aborts or it ends. */
	async function shellEvents(onEvent: (event: ShellEvent) => void, signal: AbortSignal): Promise<void> {
		const local = new AbortController();
		const stop = () => local.abort();
		signal.addEventListener("abort", stop, { once: true });
		reopen = stop;
		try {
			await open(
				watched === undefined ? "/events" : `/events?chat=${watched}`,
				(event) => {
					if (event.type !== "live") onEvent(event);
					else for (const watcher of [...(watchers.get(event.chat) ?? [])]) watcher(event.event);
				},
				local.signal,
			);
		} catch (error) {
			if (!(local.signal.aborted && !signal.aborted)) throw error;
		} finally {
			signal.removeEventListener("abort", stop);
			if (reopen === stop) reopen = undefined;
		}
	}
	return { events, shellEvents, takeReopen };
}
