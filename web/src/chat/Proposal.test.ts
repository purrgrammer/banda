import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import type { Proposal } from "../../../src/core/proposals.ts";
import { proposalView } from "../../../src/server/proposals.ts";
import { ProposalCard } from "./Proposal.tsx";

describe("an agent's proposal card", () => {
	it("previews an agent update as field changes, with instructions behind details", () => {
		const proposal: Proposal = {
			id: "private-id",
			chat: 1,
			from: "mara",
			kind: "agentChange",
			agent: "private-agent-id",
			displayName: "Mara",
			base: "base-sha",
			before: "---\nname: Mara\ndescription: Trip planner.\n---\nOld personality.\n",
			result: "---\nname: Mara\ndescription: Travel planner.\n---\nNew personality.\n",
			at: 1,
			state: "pending",
		};
		const shown = proposalView(proposal);
		if (shown === undefined) throw new Error("valid proposal did not produce a preview");
		const html = renderToStaticMarkup(createElement(ProposalCard, { proposal: shown, state: "pending" }));
		expect(html).toContain("Update Mara");
		expect(html).toContain("Trip planner.");
		expect(html).toContain("Travel planner.");
		expect(html).toContain("New personality.");
		expect(html).toContain("Old personality.");
		expect(html).not.toContain("private-agent-id");
		expect(html).toContain("Instructions");
		expect(html).not.toContain("What it was");
	});

	it("labels declining a new agent proposal as Cancel", () => {
		const proposal: Proposal = {
			id: "new-agent",
			chat: 1,
			from: "mara",
			kind: "agent",
			agentId: "researcher",
			name: "Researcher",
			face: defaultAvatarFace(),
			description: "Finds sources.",
			instructions: "Research carefully.",
			at: 1,
			state: "pending",
		};
		const html = renderToStaticMarkup(createElement(ProposalCard, { proposal, state: "pending" }));
		expect(html).toContain(">Cancel</button>");
		expect(html).not.toContain("Keep as is");
	});

	it("draws the text as the agent's with a quiet Edit, and an accepted edit as the owner's", () => {
		const proposal: Extract<Proposal, { kind: "agent" }> = {
			id: "agent-1",
			chat: 1,
			from: "sancho",
			kind: "agent",
			agentId: "writer",
			name: "Writer",
			face: defaultAvatarFace(),
			description: "Writes drafts",
			instructions: "Write clearly.",
			at: 1,
			state: "pending",
		};
		const pending = renderToStaticMarkup(
			createElement(ProposalCard, { proposal, state: "pending", onAct: async () => "accepted" as const }),
		);
		expect(pending).toContain("Edit description");
		expect(pending).toContain("Edit instructions");
		expect(pending).not.toContain("Edited by you");
		const accepted = renderToStaticMarkup(
			createElement(ProposalCard, {
				proposal: { ...proposal, state: "accepted" },
				state: "accepted",
				edited: { description: "Writes short drafts" },
			}),
		);
		expect(accepted).toContain("Writes short drafts");
		expect(accepted).toContain("Edited by you");
		expect(accepted).not.toContain("Edit description");
		// a group has no text of an agent's to edit
		const group = renderToStaticMarkup(
			createElement(ProposalCard, {
				proposal: {
					id: "g",
					chat: 1,
					from: "a",
					kind: "group",
					name: "G",
					members: ["a", "b"],
					memberNames: ["A", "B"],
					at: 1,
					state: "pending",
				},
				state: "pending",
				onAct: async () => "accepted" as const,
			}),
		);
		expect(group).not.toContain(">Edit<");
	});
});
