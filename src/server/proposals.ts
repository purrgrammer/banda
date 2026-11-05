/** Proposal reviews are projections of the exact definition files the owner would accept, never stored copies. */
import { type Agent, parseAgent } from "../core/agents.ts";
import type { Proposal } from "../core/proposals.ts";

export type AgentDefinitionPreview = Pick<Agent, "name" | "face" | "description" | "instructions" | "model" | "tier">;

export type ProposalView =
	| Exclude<Proposal, { kind: "agentChange" }>
	| (Extract<Proposal, { kind: "agentChange" }> & {
			readonly beforeAgent: AgentDefinitionPreview;
			readonly proposedAgent: AgentDefinitionPreview;
	  });

function reviewAgent(agent: Agent): AgentDefinitionPreview {
	return {
		name: agent.name,
		face: agent.face,
		description: agent.description,
		...(agent.model === undefined ? {} : { model: agent.model }),
		...(agent.tier === undefined ? {} : { tier: agent.tier }),
		instructions: agent.instructions,
	};
}

/** Invalid recorded files cannot produce an actionable review. Never substitute today's definition. */
export function proposalView(proposal: Proposal): ProposalView | undefined {
	if (proposal.kind !== "agentChange") return proposal;
	if (typeof proposal.before !== "string" || typeof proposal.result !== "string") return undefined;
	const before = parseAgent(proposal.agent, proposal.before);
	const after = parseAgent(proposal.agent, proposal.result);
	if (!("agent" in before) || !("agent" in after)) return undefined;
	return { ...proposal, beforeAgent: reviewAgent(before.agent), proposedAgent: reviewAgent(after.agent) };
}
