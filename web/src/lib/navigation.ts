/** Navigation is derived from content; a revealed destination remains stable for the current visit. */
import type { Agent, AgentView, ChatRow, CompanionView } from "../../../src/server/api.ts";
import { agentMainOf } from "./chats.ts";

/** An agent as a chat names it; `since`, when its file was last accepted, orders it in the band before it has said anything. */
export type ChatAgent = Pick<Agent, "id" | "name" | "face"> & { readonly since?: number };

/** Whether the first agent's accepted file says it is archived; until the agents are read, it is not. */
const leadArchived = (agents: readonly AgentView[]) =>
	agents.some(({ accepted }) => accepted?.agent?.id === "sancho" && accepted.agent.state === "archived");

/**
 * Only accepted, active agents can start conversations; the first agent, by the companion's name, unless it is
 * archived.
 */
export function chatAgents(agents: readonly AgentView[], companion: CompanionView): ChatAgent[] {
	const lead = agents.find(({ accepted }) => accepted?.agent?.id === "sancho")?.accepted?.agent;
	return [
		...(leadArchived(agents)
			? []
			: [{ id: "sancho", name: companion.name ?? "Sancho", face: lead?.face ?? companion.face }]),
		...agents.flatMap(({ accepted }) =>
			accepted?.agent?.state === "active" && accepted.agent.id !== "sancho"
				? [{ ...accepted.agent, ...(accepted.at === undefined ? {} : { since: accepted.at }) }]
				: [],
		),
	];
}

/** An archived agent, as Settings lists it to restore: its face, its name, and when it was archived. */
export type ArchivedAgent = ChatAgent & { readonly at?: number };

/** The archived agents, the most recently archived first; the first agent by the companion's name. */
export function archivedAgents(agents: readonly AgentView[], companion: CompanionView): ArchivedAgent[] {
	return agents
		.flatMap(({ accepted }): ArchivedAgent[] =>
			accepted?.agent?.state !== "archived"
				? []
				: [
						{
							...(accepted.agent.id === "sancho"
								? { id: "sancho", name: companion.name ?? "Sancho", face: accepted.agent.face }
								: { id: accepted.agent.id, name: accepted.agent.name, face: accepted.agent.face }),
							...(accepted.at === undefined ? {} : { at: accepted.at }),
						},
					],
		)
		.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/**
 * The name of the agent a chat runs, as an ask from it says who wants something: an accepted agent's own name, else the
 * companion's (the default agent, a chat not found yet, an agent never accepted).
 */
export function agentNameOf(
	chat: number,
	rows: readonly ChatRow[],
	agents: readonly AgentView[],
	companion: Pick<CompanionView, "name"> | undefined,
): string | undefined {
	const id = rows.find((row) => row.chat === chat)?.agent;
	const agent = id === undefined || id === "sancho" ? undefined : agents.find((a) => a.accepted?.agent?.id === id);
	return agent?.accepted?.agent?.name ?? companion?.name;
}

const stateOf = (chat: ChatRow | undefined) =>
	chat?.state === "waiting"
		? ("waiting" as const)
		: chat?.state === "running"
			? ("working" as const)
			: ("idle" as const);

/** One row per agent, the companion first: each opens the agent's main chat; its unread and state are that chat's. */
export function agentNavigation(agents: readonly AgentView[], rows: readonly ChatRow[], companion: CompanionView) {
	return chatAgents(agents, companion).map((agent) => {
		const main = agentMainOf(rows, agent.id);
		return { agent, main, unread: main?.unread ?? 0, state: stateOf(main) };
	});
}
