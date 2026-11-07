/**
 * The model's runtime status line, not the owner's words: its stable agent id, the date, hour and time zone, and how
 * full its memory is. It is a
 * prompt section rendered before each request, after the fixed prompt prefix. When its words change, pi-durable appends
 * a small system entry with the new value, so the cached prefix stays and nothing the owner wrote is touched. The time
 * changes at most once an hour and memory's fill in steps of ten percent, so a chat gains few such entries, and only
 * while it runs.
 */
import { defineExtension, type PromptSection } from "@earendil-works/pi-durable";
import { AgentChats } from "./agents.ts";
import { MAX_MEMORY_CHARS, type MemoryFiles, memoryFill } from "./memory.ts";

/** How full an agent's memory is, in percent of each scope's budget. */
export type Fill = { readonly agent: number; readonly global: number };

/** The status line for `at`, to the hour, in the daemon's time zone (or `timeZone`). */
export function nowLine(at: number, timeZone?: string, agentId?: string, fill?: Fill): string {
	const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const hour = new Date(Math.floor(at / 3_600_000) * 3_600_000);
	const when = new Intl.DateTimeFormat("en-GB", {
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: zone,
		timeZoneName: "short",
	}).format(hour);
	const identity = agentId === undefined ? "" : `Your stable agent id is ${agentId}. `;
	return (
		identity +
		`It is ${when} (${zone}), to the hour. Use it for every date and time you say or reason about: ` +
		"a date the owner gives without a year is the next one to come." +
		(fill === undefined
			? ""
			: ` Your memory is ${fill.agent}% full and the band's shared memory ${fill.global}% ` +
				`(${MAX_MEMORY_CHARS} characters each).`)
	);
}

/** With `memory`, the line says how full the agent's memory is; memory it cannot read leaves that out. */
export const nowSection = (clock: () => number = Date.now, memory?: Pick<MemoryFiles, "read">): PromptSection => ({
	key: "now",
	render: async ({ conversationId, read }, ctx) => {
		const agent = (await read.snapshot(AgentChats, ctx))?.chats[conversationId];
		const fill =
			memory === undefined || agent === undefined
				? undefined
				: await memoryFill(memory, agent, ctx).catch(() => undefined);
		return nowLine(clock(), undefined, agent, fill);
	},
});

export const nowExtension = (clock: () => number = Date.now, memory?: Pick<MemoryFiles, "read">) =>
	defineExtension({ name: "banda.now", sections: [nowSection(clock, memory)] });
