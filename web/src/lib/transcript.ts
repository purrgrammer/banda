/**
 * One chat's transcript, live. The event stream opens first and says how far the store is (`ready.tail`);
 * entries up to there are fetched by id and everything after arrives as events, so nothing is missed or shown twice.
 * A dropped stream reopens, and its next `ready` fills the gap the same way.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
	api,
	type Block,
	events,
	type Item,
	type ItemPage,
	type Queued,
	type RunningTool,
	type ShownWait,
	Unauthorized,
} from "./api.ts";

export type Transcript = {
	readonly items: readonly Item[];
	readonly waits: readonly ShownWait[];
	/** The owner's messages waiting for the run at work, oldest first; not yet items. */
	readonly queued: readonly Queued[];
	readonly busy: boolean;
	readonly input: number | undefined;
	/** The tool calls running now, oldest first. */
	readonly running: readonly RunningTool[];
	/** The answer being generated, by block: thinking and notes the raw transcript shows as they come. */
	readonly partial: readonly Block[];
	/** Whether it is thinking now: a thinking block of the answer being generated has not ended. */
	readonly thinking: boolean;
	readonly older: boolean;
	readonly loadOlder: () => Promise<void>;
	readonly loaded: boolean;
	readonly missing: boolean;
};

const RETRY_MS = 1000;

/** Each open chat's items read so far, for whoever draws a part of it outside the chat's own view. */
const itemsByChat = new Map<number, readonly Item[]>();
const listeners = new Set<() => void>();

const NO_ITEMS: readonly Item[] = [];
const told = () => {
	for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** Chat `chat`'s items read so far, live while its transcript is open. */
export function useChatItems(chat: number): readonly Item[] {
	return useSyncExternalStore(subscribe, () => itemsByChat.get(chat) ?? NO_ITEMS);
}

function merge(items: readonly Item[], more: readonly Item[]): Item[] {
	const byId = new Map(items.map((item) => [item.id, item]));
	for (const item of more) byId.set(item.id, item);
	return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function useTranscript(chat: number): Transcript {
	const [items, setItems] = useState<readonly Item[]>([]);
	const [waits, setWaits] = useState<readonly ShownWait[]>([]);
	const [queued, setQueued] = useState<readonly Queued[]>([]);
	const [busy, setBusy] = useState(false);
	const [input, setInput] = useState<number>();
	const [running, setRunning] = useState<readonly RunningTool[]>([]);
	const [partial, setPartial] = useState<readonly Block[]>([]);
	const [next, setNext] = useState<number>();
	const [loaded, setLoaded] = useState(false);
	const [missing, setMissing] = useState(false);

	useEffect(() => {
		const stop = new AbortController();
		let known: Item[] = [];
		const add = (more: readonly Item[]) => {
			known = merge(known, more);
			// A live entry must not discard the history loaded while this stream was open.
			setItems((now) => merge(now, more));
		};
		const sync = async (tail: number) => {
			const newest = known.at(-1)?.id;
			if (newest === undefined) {
				const page = await api<ItemPage>(`/chats/${chat}/items?through=${tail}`);
				add(page.items);
				setNext(page.next);
			} else
				for (let after: number | undefined = newest; after !== undefined && after < tail; ) {
					const page: ItemPage = await api<ItemPage>(`/chats/${chat}/items?after=${after}&through=${tail}`);
					add(page.items);
					after = page.next;
				}
			setLoaded(true);
		};
		void (async () => {
			while (!stop.signal.aborted) {
				let queue = Promise.resolve();
				try {
					await events(
						chat,
						(event) => {
							if (event.type === "ready") {
								setBusy(event.busy);
								setInput(event.input);
								setPartial(event.partial);
								setRunning(event.running);
								// events after `ready` wait for its fetch, so they land on a whole transcript
								queue = queue.then(() => sync(event.tail));
							} else if (event.type === "entry") {
								queue = queue.then(() => add([event.item]));
								if (event.item.role === "assistant") setPartial([]);
							} else if (event.type === "start") setPartial(event.partial);
							else if (event.type === "delta")
								setPartial((blocks) => {
									const now = [...blocks];
									const block = now[event.index] ?? { type: "text", text: "" };
									now[event.index] = { ...block, text: block.text + event.text };
									return now;
								});
							else if (event.type === "waits") setWaits(event.waits);
							// in line with the entries, so the entry a run took it as lands before it leaves the queue
							else if (event.type === "queued") queue = queue.then(() => setQueued(event.queued));
							else if (event.type === "tool")
								setRunning((now) => [
									...now.filter((tool) => tool.call !== event.call),
									{
										call: event.call,
										name: event.name,
										output: "",
										...(event.doing === undefined ? {} : { doing: event.doing }),
									},
								]);
							else if (event.type === "output")
								setRunning((now) =>
									now.map((tool) =>
										tool.call === event.call
											? { ...tool, output: event.set ?? tool.output.slice(event.trim ?? 0) + (event.append ?? "") }
											: tool,
									),
								);
							else if (event.type === "toolEnd")
								// its result entry follows in the same commit's events
								queue = queue.then(() => setRunning((now) => now.filter((tool) => tool.call !== event.call)));
							else if (event.type === "busy") {
								setBusy(event.busy);
								setInput(event.input);
								if (!event.busy) {
									setPartial([]);
									setRunning([]);
								}
							}
						},
						stop.signal,
					);
					await queue;
				} catch (error) {
					if (stop.signal.aborted || error instanceof Unauthorized) return;
					if (error instanceof Error && error.message === "no such chat") {
						setMissing(true);
						return;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
			}
		})();
		return () => stop.abort();
	}, [chat]);

	useEffect(() => {
		itemsByChat.set(chat, items);
		told();
	}, [chat, items]);

	const loadOlder = useCallback(async () => {
		if (next === undefined) return;
		const page = await api<ItemPage>(`/chats/${chat}/items?before=${next}`);
		setItems((now) => merge(now, page.items));
		setNext(page.next);
	}, [chat, next]);

	return {
		items,
		waits,
		queued,
		busy,
		input,
		running,
		partial,
		thinking: partial.some((block) => block.type === "thinking" && block.endedAt === undefined),
		older: next !== undefined,
		loadOlder,
		loaded,
		missing,
	};
}
