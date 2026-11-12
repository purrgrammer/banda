/**
 * The band's roster in a direct agent chat's prompt: the other active agents, each by the id `message_agent` and
 * `read_agent_chat` take, the name the owner calls it and its description, which is how another agent chooses it.
 * Nothing else of an agent file reaches the prompt. A group member's chat has its group's members instead (`group`).
 * It renders before each request; when an agent is made, renamed, described anew or archived, pi-durable appends the
 * new words where the conversation then stands, so the prefix before stays cached.
 */
import type { PromptSection } from "@earendil-works/pi-durable";
import { Accepted, AgentChats, LEAD, parseAgent } from "./agents.ts";
import { DEFAULT_NAME } from "./choices.ts";
import { Companion } from "./companion.ts";
import { Groups } from "./groups.ts";

/** At most this many characters of a description: enough to route by, and a long one costs every chat's prompt. */
export const ROSTER_DESCRIPTION = 160;

export type RosterAgent = { readonly id: string; readonly name: string; readonly description: string };

const short = (text: string) => {
	const chars = [...text.trim()];
	return chars.length <= ROSTER_DESCRIPTION ? chars.join("") : `${chars.slice(0, ROSTER_DESCRIPTION - 1).join("")}…`;
};

/** The roster's words for the agent `self`, given the band's active agents; `self` is left out of the list. */
export function rosterText(self: string, agents: readonly RosterAgent[]): string {
	const others = agents.filter((agent) => agent.id !== self).sort((a, b) => (a.id < b.id ? -1 : 1));
	if (others.length === 0) return "No other agent is active in the band, so there is nobody to message or read.";
	return [
		"Besides you, the band's active agents, each as its id, the name the owner calls it and what it is for. " +
			"Give the id as `agent` to `message_agent` or `read_agent_chat`; an agent not listed is archived or does not exist.",
		...others.map(({ id, name, description }) => `- ${id}: ${name}. ${short(description)}`),
	].join("\n");
}

/** The roster, in every direct agent chat; nothing in a group member's chat or a chat that is no agent's. */
export const rosterSection: PromptSection = {
	key: "roster",
	render: async ({ conversationId, read }, ctx) => {
		const self = (await read.snapshot(AgentChats, ctx))?.chats[conversationId];
		if (self === undefined) return undefined;
		if ((await read.snapshot(Groups, ctx))?.byExecution[conversationId] !== undefined) return undefined;
		const files = (await read.snapshot(Accepted, ctx))?.files ?? {};
		const lead = (await read.snapshot(Companion, ctx))?.name ?? DEFAULT_NAME;
		const agents = Object.entries(files).flatMap(([path, file]) => {
			const id = /^agents\/(.+)\.md$/.exec(path)?.[1];
			if (id === undefined) return [];
			const parsed = parseAgent(id, file.text);
			if (!("agent" in parsed) || parsed.agent.state !== "active") return [];
			// these three fields and no other reach the prompt: never instructions, tools, connections or model
			const { name, description } = parsed.agent;
			return [{ id, name: id === LEAD ? lead : name, description }];
		});
		return rosterText(self, agents);
	},
};
