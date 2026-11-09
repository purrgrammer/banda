/**
 * When a chat compacts (DESIGN.md "The prompt"): pi-durable's thresholds, placed at one share of each model's window,
 * the same for every model, so a long chat stays fast and cheap instead of filling a large window.
 */
import type { Message, Models } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	AgentDoc,
	CompactionEntry,
	type CompactionPolicy,
	type CompactionSettings,
	CompactionTask,
	defineExtension,
	hook,
} from "@earendil-works/pi-durable";

/** The share of a model's window a chat's context may fill before the next request waits for a compaction. */
export const BUDGET_SHARE = 0.5;
/** Background compaction starts this share of the window before the budget, so most chats never wait for one. */
const BACKGROUND_SHARE = 0.1;
/** Recent context a summary keeps verbatim: pi-durable's default, less on a small window, so a cut is always found. */
const KEEP_RECENT = 20_000;
const KEEP_RECENT_SHARE = 0.2;

/** The thresholds for a model with `contextWindow` tokens. */
export function budgetPolicy(contextWindow: number, share = BUDGET_SHARE): Omit<CompactionPolicy, "enabled"> {
	const budget = Math.floor(contextWindow * share);
	return {
		reserveTokens: contextWindow - budget,
		backgroundTokens: Math.floor(contextWindow * BACKGROUND_SHARE),
		keepRecentTokens: Math.min(KEEP_RECENT, Math.floor(contextWindow * KEEP_RECENT_SHARE)),
	};
}

/**
 * Compaction settings whose per-model entries are read from the catalog when pi-durable looks one up, so a model added
 * later (a provider signed in, a custom model) has its budget without the settings being rebuilt. A model the catalog
 * does not know keeps pi-durable's defaults.
 */
export function compactionSettings(models: Pick<Models, "getModel">, share = BUDGET_SHARE): CompactionSettings {
	const overrides = new Proxy({} as Record<string, Partial<CompactionPolicy>>, {
		get(_, key) {
			if (typeof key !== "string") return undefined;
			const slash = key.indexOf("/");
			if (slash < 0) return undefined;
			const window = models.getModel(key.slice(0, slash), key.slice(slash + 1))?.contextWindow;
			return typeof window === "number" && window > 0 ? budgetPolicy(window, share) : undefined;
		},
	});
	return { modelOverrides: overrides };
}

/**
 * A threshold compaction summarizes at least the background band of the window, or declines. When what a compaction
 * keeps (the prompt, the summary and the recent entries) sits near the threshold, each new turn would otherwise
 * compact again and summarize only that turn: a compaction on every request. A declined one lets the request go
 * ahead; the context grows by a band before the next is worth it. A compaction for an overflow never declines.
 */
export const compactionExtension = defineExtension({
	name: "banda.compaction",
	hooks: [
		hook(CompactionTask, {
			beforeCompact: async (compaction, api, ctx) => {
				if (compaction.reason !== "threshold") return undefined;
				const ref = (await api.snapshot(AgentDoc, api.conversationId, ctx))?.model;
				const window = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId)?.contextWindow;
				if (window === undefined || window <= 0) return undefined;
				return summarizedTokens(compaction.entries) < budgetPolicy(window).backgroundTokens
					? { decline: true }
					: undefined;
			},
		}),
	],
});

/**
 * Tokens of what a compaction would summarize: what was said, without the earlier summary it folds in or the system
 * entries (the prompt pi-durable writes again after each compaction), which the summarizer never reads.
 */
export function summarizedTokens(entries: readonly { readonly kind?: string; readonly model?: readonly Message[] }[]) {
	return entries
		.filter((entry) => entry.kind !== CompactionEntry.kind)
		.flatMap((entry) => entry.model ?? [])
		.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult")
		.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}
