/**
 * How long the model thought. pi-ai times a whole response (`durationMs`), not its blocks, so the daemon times them on
 * the stream between every provider and pi-durable, which it owns: each event it passes on carries a copy of the
 * message with one `banda.thinking` diagnostic, each thinking block's start, end once it ended, and the time its last
 * text arrived. pi-durable stores what it is handed (each partial it commits, the final message, and, for a response
 * cut off by a stop or a crash, its last committed partial), so every stored copy carries its own timing, whatever the
 * provider does with its objects. A block cut off thought until its last text arrived.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";

export const THINKING_DIAGNOSTIC = "banda.thinking";

/** One thinking block's times, epoch ms: started, ended once it did, and when its latest text arrived. */
export type BlockTimes = { readonly start: number; readonly end?: number; readonly last: number };

/** The thinking blocks' times, by content index. */
export function thinkingTimes(message: AssistantMessage): Map<number, BlockTimes> {
	const blocks = message.diagnostics?.find((d) => d.type === THINKING_DIAGNOSTIC)?.details?.blocks;
	const times = new Map<number, BlockTimes>();
	if (typeof blocks !== "object" || blocks === null || Array.isArray(blocks)) return times;
	for (const [index, value] of Object.entries(blocks)) {
		const t = value as Partial<BlockTimes> | null;
		if (typeof t?.start !== "number" || typeof t.last !== "number") continue;
		times.set(Number(index), { start: t.start, last: t.last, ...(typeof t.end === "number" ? { end: t.end } : {}) });
	}
	return times;
}

/** How long the message thought, all blocks together; undefined when it carries no timing. */
export function thinkingMs(message: AssistantMessage): number | undefined {
	const times = [...thinkingTimes(message).values()];
	if (times.length === 0) return undefined;
	return times.reduce((sum, t) => sum + Math.max(0, (t.end ?? t.last) - t.start), 0);
}

/** Time every provider's thinking blocks, in place. */
export function timeThinking(models: MutableModels): MutableModels {
	for (const provider of models.getProviders()) models.setProvider(timed(provider));
	return models;
}

function timed(provider: Provider): Provider {
	return new Proxy(provider, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if ((key !== "stream" && key !== "streamSimple") || typeof value !== "function") return value;
			return (...args: unknown[]) => observe(value.apply(target, args) as AssistantMessageEventStream);
		},
	});
}

/** `message` copied (shallowly: its content is shared, unchanged) with the timing so far as its diagnostic. */
function stamped(message: AssistantMessage, blocks: ReadonlyMap<number, BlockTimes>): AssistantMessage {
	const kept = (message.diagnostics ?? []).filter((d) => d.type !== THINKING_DIAGNOSTIC);
	if (blocks.size === 0) return message;
	const details = { blocks: Object.fromEntries([...blocks].map(([index, t]) => [String(index), { ...t }])) };
	return { ...message, diagnostics: [...kept, { type: THINKING_DIAGNOSTIC, timestamp: Date.now(), details }] };
}

/** The event with every message it carries stamped. */
function stampEvent(event: AssistantMessageEvent, blocks: ReadonlyMap<number, BlockTimes>): AssistantMessageEvent {
	if (event.type === "done") return { ...event, message: stamped(event.message, blocks) };
	if (event.type === "error") return { ...event, error: stamped(event.error, blocks) };
	return { ...event, partial: stamped(event.partial, blocks) };
}

function observe(inner: AssistantMessageEventStream): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	const blocks = new Map<number, BlockTimes>();
	void (async () => {
		try {
			for await (const event of inner) {
				const now = Date.now();
				if (event.type === "thinking_start") blocks.set(event.contentIndex, { start: now, last: now });
				else if (event.type === "thinking_delta" || event.type === "thinking_end") {
					const known = blocks.get(event.contentIndex) ?? { start: now, last: now };
					blocks.set(event.contentIndex, {
						...known,
						last: now,
						...(event.type === "thinking_end" ? { end: now } : {}),
					});
				}
				outer.push(stampEvent(event, blocks));
			}
		} finally {
			// A stream never throws by contract; ending ours either way keeps a broken one from hanging the request.
			outer.end();
		}
	})();
	return outer;
}
