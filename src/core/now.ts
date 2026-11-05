/**
 * The model's runtime status line, not the owner's words: its stable agent id and the date, hour and time zone. It is a
 * prompt section rendered before each request, after the fixed prompt prefix. When its words change, pi-durable appends
 * a small system entry with the new value, so the cached prefix stays and nothing the owner wrote is touched. The time
 * changes at most once an hour, so a chat gains at most one such entry an hour, and only while it runs.
 */
import { defineExtension, type PromptSection } from "@earendil-works/pi-durable";
import { AgentChats } from "./agents.ts";

/** The status line for `at`, to the hour, in the daemon's time zone (or `timeZone`). */
export function nowLine(at: number, timeZone?: string, agentId?: string): string {
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
		"a date the owner gives without a year is the next one to come."
	);
}

export const nowSection = (clock: () => number = Date.now): PromptSection => ({
	key: "now",
	render: async ({ conversationId, read }, ctx) => {
		const agent = (await read.snapshot(AgentChats, ctx))?.chats[conversationId];
		return nowLine(clock(), undefined, agent);
	},
});

export const nowExtension = (clock: () => number = Date.now) =>
	defineExtension({ name: "banda.now", sections: [nowSection(clock)] });
