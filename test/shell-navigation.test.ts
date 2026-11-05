import { describe, expect, it } from "vitest";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import type { AgentView, ChatRow, CompanionView } from "../src/server/api.ts";
import { agentNameOf, agentNavigation, archivedAgents, chatAgents } from "../web/src/lib/navigation.ts";

const companion: CompanionView = {
	name: "Rucio",
	face: defaultAvatarFace(),
};
const researcherFace = { ...defaultAvatarFace(), color: "#67a98c" };
const agent = (id: string, state: "active" | "archived" = "active"): AgentView => ({
	name: id,
	accepted: {
		sha: "a".repeat(64),
		text: "",
		agent: {
			id,
			name: id,
			face: researcherFace,
			state,
			description: "Research",
			instructions: "Be exact",
			tools: [],
		},
	},
});
const row = (chat: number, agent: string, at: number, more: Partial<ChatRow> = {}): ChatRow => ({
	chat,
	agent,
	at,
	title: `Chat ${chat}`,
	origin: { gateway: "web", peer: "owner", thread: `thread-${chat}` },
	state: "idle",
	unread: 0,
	read: 0,
	unanswered: 0,
	...more,
});

describe("agent navigation", () => {
	it("names the agent a chat runs, so its asks say who wants something; the companion otherwise", () => {
		const rows = [row(1, "sancho", 1), row(2, "researcher", 2), row(3, "ghost", 3)];
		const agents = [agent("researcher")];
		expect(agentNameOf(2, rows, agents, companion)).toBe("researcher");
		expect(agentNameOf(1, rows, agents, companion)).toBe("Rucio");
		// an agent never accepted, and a chat not listed yet
		expect(agentNameOf(3, rows, agents, companion)).toBe("Rucio");
		expect(agentNameOf(9, rows, agents, companion)).toBe("Rucio");
	});
	it("always includes the companion once with its current identity, and only accepted active agents", () => {
		const pending = { name: "pending", change: { kind: "added" as const, agent: agent("pending").accepted!.agent! } };
		expect(
			chatAgents([agent("sancho"), agent("researcher"), agent("archived", "archived"), pending], companion).map(
				({ id, name }) => ({ id, name }),
			),
		).toEqual([
			{ id: "sancho", name: "Rucio" },
			{ id: "researcher", name: "researcher" },
		]);
	});
	it("leaves an archived agent out of the band, the first one too, and lists it to restore, newest first", () => {
		const at = (view: AgentView, when: number): AgentView => ({
			...view,
			accepted: { ...view.accepted!, at: when },
		});
		const views = [at(agent("sancho", "archived"), 5), agent("researcher"), at(agent("atlas", "archived"), 9)];
		expect(chatAgents(views, companion).map(({ id }) => id)).toEqual(["researcher"]);
		expect(archivedAgents(views, companion)).toEqual([
			{ id: "atlas", name: "atlas", face: researcherFace, at: 9 },
			{ id: "sancho", name: "Rucio", face: researcherFace, at: 5 },
		]);
		expect(archivedAgents([agent("researcher")], companion)).toEqual([]);
	});
	it("has one entry per agent opening its main chat, its unread and state that chat's alone", () => {
		const rows = [
			row(1, "sancho", 10, { origin: { gateway: "web", peer: "owner", thread: "main" }, unread: 1 }),
			row(2, "researcher", 20, { origin: { gateway: "web", peer: "owner", thread: "agent:researcher" } }),
			row(3, "researcher", 30, { unread: 2, state: "waiting" }),
		];
		const entries = agentNavigation([agent("researcher"), agent("empty")], rows, companion);
		expect(entries.map(({ agent }) => agent.id)).toEqual(["sancho", "researcher", "empty"]);
		expect(entries.map(({ main }) => main?.chat)).toEqual([1, 2, undefined]);
		expect(entries.map(({ unread }) => unread)).toEqual([1, 0, 0]);
		expect(entries[1]?.state).toBe("idle");
	});
});
