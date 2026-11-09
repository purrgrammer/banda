/**
 * The model's runtime status line, not the owner's words: its stable agent id, the date, hour and time zone, and how
 * full its memory is. It is a system message appended after everything else on every request, for that request only:
 * the system prompt and the transcript never hold it, so the cached prefix stays whatever the line says, and the model
 * reads it last, next to the turn it answers. A model that cannot take a system message mid-conversation gets it folded
 * into its system prompt by pi-ai.
 */
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, type HookApi, hook } from "@earendil-works/pi-durable";
import { AgentChats } from "./agents.ts";
import { type MemoryFiles, memoryFill } from "./memory.ts";

/** How full an agent's memory is, in percent of each scope's budget. */
export type Fill = { readonly agent: number; readonly global: number };

/** The status line for `at`, to the hour, in the daemon's time zone (or `timeZone`). */
export function nowLine(at: number, timeZone?: string, agentId?: string, fill?: Fill): string {
	const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const start = Math.floor(at / 3_600_000) * 3_600_000;
	const day = new Intl.DateTimeFormat("en-GB", {
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: zone,
	}).format(start);
	const clock = (t: number) =>
		new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone }).format(t);
	const abbreviation =
		new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" })
			.formatToParts(start)
			.find((part) => part.type === "timeZoneName")?.value ?? zone;
	const when = `${day}, between ${clock(start)} and ${clock(start + 3_600_000)} ${abbreviation}`;
	const identity = agentId === undefined ? "" : `Your stable agent id is ${agentId}. `;
	return (
		identity +
		`It is ${when} (${zone}). Use it for every date and time you say or reason about: ` +
		"a date the owner gives without a year is the next one to come." +
		(fill === undefined
			? ""
			: ` Memory: yours ${fill.agent}% full, shared ${fill.global}%${
					Math.max(fill.agent, fill.global) >= 80 ? "; merge or forget facts" : ""
				}.`)
	);
}

/** The status line for this conversation now; with `memory`, it says how full the agent's memory is, unless unreadable. */
export async function statusLine(
	api: Pick<HookApi, "conversationId" | "snapshot">,
	context: Context,
	clock: () => number = Date.now,
	memory?: Pick<MemoryFiles, "read">,
): Promise<string> {
	const agent = (await api.snapshot(AgentChats, context))?.chats[api.conversationId];
	const fill =
		memory === undefined || agent === undefined
			? undefined
			: await memoryFill(memory, agent, context).catch(() => undefined);
	return nowLine(clock(), undefined, agent, fill);
}

/**
 * `messages` with the status line as a system message just before the last user message: the turn's input, or the
 * latest nudge or steer. It sits in one place for every request of a turn, so the turn's later requests reuse the cached
 * prefix; only the next turn moves it. Anthropic emits a later system message just before the next assistant message,
 * so there it reads right after that input.
 */
export async function withStatus(
	messages: readonly Message[],
	api: Pick<HookApi, "conversationId" | "snapshot">,
	context: Context,
	clock: () => number = Date.now,
	memory?: Pick<MemoryFiles, "read">,
): Promise<readonly Message[]> {
	const status: Message = {
		role: "system",
		content: await statusLine(api, context, clock, memory),
		timestamp: clock(),
	};
	const at = messages.length - 1 - [...messages].reverse().findIndex((message) => message.role === "user");
	return at === messages.length ? [...messages, status] : [...messages.slice(0, at), status, ...messages.slice(at)];
}

export const nowExtension = (clock: () => number = Date.now, memory?: Pick<MemoryFiles, "read">) =>
	defineExtension({
		name: "banda.now",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async ({ messages }, api, context) => ({
					messages: await withStatus(messages, api, context, clock, memory),
				}),
			}),
		],
	});
