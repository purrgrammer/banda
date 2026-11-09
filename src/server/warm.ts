/**
 * Warming a chat's prompt cache while the owner types (DESIGN.md "The companion"): when the composer gets focus, the
 * daemon sends the chat's provider the request its next run will start with, minus the answer, so the provider caches
 * the prefix and the reply comes sooner. It sends exactly what the next request would (the chat's context as pi-durable
 * reads it, on the chat's model, with its session), never anything the provider has not seen, and nothing is stored:
 * a warm that fails or never happens changes nothing but the wait. Only when the cache has gone cold: a chat that
 * spoke or was warmed within `COLD_AFTER` is warm already, and a chat at work keeps its own cache warm.
 */
import type { Context } from "@earendil-works/chord";
import type { Message, MutableModels } from "@earendil-works/pi-ai";
import { type ConversationId, type Harness, LiveDoc, ProviderDoc } from "@earendil-works/pi-durable";
import { context } from "../core/store.ts";

/** How long a provider keeps a prompt cached after its last use, at least: Anthropic's default, five minutes. */
export const COLD_AFTER = 4 * 60_000;

/** Why a warm was not sent. */
export type Unwarmed = "busy" | "warm" | "empty" | "unknown";

/** The newest moment `chat` used its cache: its newest entry's time. */
async function lastUsed(harness: Harness, chat: number, ctx: Context): Promise<number | undefined> {
	return harness.commit(async (tx) => {
		const page = await tx.scanEntries({ conversationId: chat as ConversationId }, 1);
		const at = page.items[0]?.model?.[0]?.timestamp;
		return typeof at === "number" ? at : undefined;
	}, ctx);
}

/**
 * A warmer for one daemon: `warm(chat)` starts a warm unless the cache is warm, the chat is at work or has nothing to
 * send; it resolves once the request is on its way (or with why not), and the request ends by itself after the
 * provider's first answer. `log` hears a warm that failed.
 */
export function defineWarm({
	harness,
	models,
	now = Date.now,
	log = () => {},
}: {
	harness: Harness;
	models: MutableModels;
	now?: () => number;
	log?: (line: string) => void;
}) {
	const warmed = new Map<number, number>();

	async function warm(
		chat: number,
		ctx: Context = context,
	): Promise<{ readonly warming: Promise<void> } | { readonly skipped: Unwarmed }> {
		const at = now();
		if (at - (warmed.get(chat) ?? 0) < COLD_AFTER) return { skipped: "warm" };
		const conversation = await harness.conversation(chat as ConversationId, ctx);
		if (conversation === undefined) return { skipped: "unknown" };
		if ((await harness.snapshot(LiveDoc, chat as ConversationId, ctx))?.run !== undefined) return { skipped: "busy" };
		if (at - ((await lastUsed(harness, chat, ctx)) ?? 0) < COLD_AFTER) return { skipped: "warm" };
		const agent = await conversation.agent(ctx);
		const model = agent.model === undefined ? undefined : models.getModel(agent.model.provider, agent.model.modelId);
		if (model === undefined) return { skipped: "unknown" };
		// what the next request starts with: the context up to the newest thing said to the model, not its answer
		const messages: Message[] = [...(await conversation.context(ctx)).messages];
		while (messages.at(-1)?.role === "assistant") messages.pop();
		if (!messages.some((message) => message.role === "user")) return { skipped: "empty" };
		const sessionId = (await harness.snapshot(ProviderDoc, chat as ConversationId, ctx))?.sessionId;
		warmed.set(chat, at);
		const abort = new AbortController();
		const stream = models.streamSimple(
			model,
			{ messages },
			{
				maxTokens: 1,
				signal: abort.signal,
				...(sessionId === undefined ? {} : { sessionId }),
				...(agent.thinkingLevel === "off" ? {} : { reasoning: agent.thinkingLevel }),
			},
		);
		const warming = (async () => {
			try {
				// the prompt is read, and cached, before anything comes back: the first answer is enough
				for await (const event of stream) {
					if (event.type === "error" && !abort.signal.aborted) log(`warm: ${event.error.errorMessage ?? "failed"}`);
					if (event.type !== "start") break;
				}
			} catch (error) {
				if (!abort.signal.aborted) log(`warm: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				abort.abort();
			}
		})();
		return { warming };
	}

	return { warm };
}
