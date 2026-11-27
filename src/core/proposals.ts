/**
 * Owner-reviewed proposals about the band, as an earlier banda's agents made them (`propose_agent`, `propose_group`,
 * `propose_agent_change`). No tool makes one now (`band-tools.ts` acts at once), so this is what a home still holds: a
 * pending proposal stays data, never a definition in effect, until the owner answers its card, and nothing else
 * applies it.
 */
import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import type { Agent } from "./agents.ts";
import { agentText, MAX_AGENT_BYTES, parseAgent } from "./agents.ts";
import type { AvatarFace } from "./avatar-face.ts";
import type { ModelId, Tier } from "./tiers.ts";

export const PROPOSAL_ENTRY = "banda.meta-proposal";
export const PROPOSAL_RESULT = "banda.meta-proposal-result";
/**
 * The daemon's word to the agent that the owner decided its proposal: a user message in its chat's history, read at
 * its next model request, which starts no turn and is nobody's input. The owner's decision itself is `PROPOSAL_RESULT`.
 */
export const PROPOSAL_DECIDED = "banda.proposal-decided";
export const MAX_PROPOSAL_TEXT = 16_000;

export type Proposal =
	| {
			readonly id: string;
			readonly chat: number;
			readonly from: string;
			readonly kind: "agent";
			readonly agentId: string;
			readonly name: string;
			readonly face: AvatarFace;
			readonly description: string;
			readonly model?: ModelId;
			readonly tier?: Tier;
			readonly instructions: string;
			readonly at: number;
			readonly state: "pending" | "accepted" | "declined";
			/** The text the owner edited before accepting: what is in effect is theirs. */
			readonly edited?: readonly ProposalText[];
	  }
	| {
			readonly id: string;
			readonly chat: number;
			readonly from: string;
			readonly kind: "group";
			readonly name: string;
			readonly members: readonly string[];
			readonly memberNames: readonly string[];
			readonly at: number;
			readonly state: "pending" | "accepted" | "declined";
	  }
	| {
			readonly id: string;
			readonly chat: number;
			readonly from: string;
			readonly kind: "agentChange";
			readonly agent: string;
			readonly displayName: string;
			readonly base: string;
			readonly before: string;
			readonly result: string;
			readonly name?: string;
			readonly face?: AvatarFace;
			readonly model?: ModelId;
			readonly tier?: Tier;
			readonly description?: string;
			readonly instructions?: string;
			readonly at: number;
			readonly state: "pending" | "accepted" | "declined";
			/** The text the owner edited before accepting: what is in effect is theirs. */
			readonly edited?: readonly ProposalText[];
	  };

/**
 * The text of a proposal the owner may edit before accepting: what the agent wrote as an agent's description and
 * personality. Never its id, name, face, model, tier or members: those are the definition's settings, not words.
 */
export const PROPOSAL_TEXT = ["description", "instructions"] as const;
export type ProposalText = (typeof PROPOSAL_TEXT)[number];
/** The owner's text for a proposal, by field. */
export type ProposalEdits = { readonly [field in ProposalText]?: string };

export const Proposals = defineDoc<{ proposals: { [id: string]: JsonObject } }>({
	kind: "banda.meta-proposals",
	version: 1,
	scope: "session",
	initial: () => ({ proposals: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

const singleLine = (value: string) => value !== "" && !/\p{Cc}/u.test(value);

/**
 * Proposal `proposal` with the owner's text in place, checked as the agent's own would be, and the fields they changed;
 * or why it cannot be. A change to an agent takes edits only to the fields it changes, so accepting it never rewrites
 * what the owner was not shown as proposed.
 */
export function editProposal(
	proposal: Proposal,
	edits: { readonly [field: string]: unknown },
): { readonly proposal: Proposal; readonly edited: readonly ProposalText[] } | { readonly refused: string } {
	const fields = Object.keys(edits);
	if (fields.length === 0) return { proposal, edited: [] };
	if (proposal.kind === "group") return { refused: "a group has no text to edit" };
	const text: { [field in ProposalText]?: string } = {};
	for (const field of fields) {
		if (!(PROPOSAL_TEXT as readonly string[]).includes(field)) return { refused: `${field} cannot be edited` };
		const key = field as ProposalText;
		const value = edits[key];
		if (typeof value !== "string") return { refused: `${field} is text` };
		if (proposal[key] === undefined) return { refused: `${field} is not part of this change` };
		text[key] = value.trim();
	}
	if (text.description !== undefined && (!singleLine(text.description) || text.description.length > 240))
		return { refused: "the description is one line, at most 240 characters" };
	if (text.instructions !== undefined && (text.instructions === "" || text.instructions.length > MAX_PROPOSAL_TEXT))
		return { refused: `the instructions are some text, at most ${MAX_PROPOSAL_TEXT} characters` };
	const edited = PROPOSAL_TEXT.filter((field) => text[field] !== undefined && text[field] !== proposal[field]);
	if (edited.length === 0) return { proposal, edited: [] };
	const changes = Object.fromEntries(edited.map((field) => [field, text[field]])) as ProposalEdits;
	if (proposal.kind === "agent") {
		const next = { ...proposal, ...changes };
		const candidate: Agent = {
			id: next.agentId,
			name: next.name,
			face: next.face,
			state: "active",
			description: next.description,
			...(next.model === undefined ? {} : { model: next.model }),
			...(next.tier === undefined ? {} : { tier: next.tier }),
			tools: [],
			instructions: next.instructions,
		};
		const written = agentText(candidate);
		if (!("agent" in parseAgent(next.agentId, written))) return { refused: "the edited agent would be invalid" };
		if (Buffer.byteLength(written) > MAX_AGENT_BYTES) return { refused: "the edited agent file would be too large" };
		return { proposal: { ...next, edited }, edited };
	}
	const parsed = parseAgent(proposal.agent, proposal.result);
	if (!("agent" in parsed)) return { refused: "the proposed definition is invalid" };
	const result = agentText({ ...parsed.agent, ...changes });
	if (!("agent" in parseAgent(proposal.agent, result))) return { refused: "the edited agent would be invalid" };
	if (Buffer.byteLength(result) > MAX_AGENT_BYTES) return { refused: "the edited agent file would be too large" };
	return { proposal: { ...proposal, ...changes, result, edited }, edited };
}

export function proposalSummary(proposal: Proposal): string {
	if (proposal.kind === "agent") return `New agent: ${proposal.name} · ${proposal.description}`;
	if (proposal.kind === "group") return `New group: ${proposal.name} · ${proposal.memberNames.join(", ")}`;
	return `Change to ${proposal.displayName}${proposal.name === undefined ? "" : ` · ${proposal.name}`}`;
}

const CHANGEABLE = ["name", "face", "description", "model", "tier", "instructions"] as const;

/** The fields a change to an agent really changes, compared in its definition: clearing a model counts too. */
function changedFields(proposal: Extract<Proposal, { kind: "agentChange" }>): readonly string[] {
	const before = parseAgent(proposal.agent, proposal.before);
	const after = parseAgent(proposal.agent, proposal.result);
	if (!("agent" in before) || !("agent" in after)) return [];
	return CHANGEABLE.filter((field) => JSON.stringify(before.agent[field]) !== JSON.stringify(after.agent[field]));
}

function decidedWhat(proposal: Proposal): string {
	if (proposal.kind === "agent") return `a new agent named ${JSON.stringify(proposal.name)}`;
	if (proposal.kind === "group") return `a new group named ${JSON.stringify(proposal.name)}`;
	const fields = changedFields(proposal);
	return `changes to ${JSON.stringify(proposal.displayName)}${fields.length === 0 ? "" : ` (${fields.join(", ")})`}`;
}

/**
 * The decision notice's words. It goes to the model as a user message, so of what a model wrote it carries only a
 * name, quoted: never a proposal's free text.
 */
export function decidedText(proposal: Proposal, state: "accepted" | "declined"): string {
	const edited = proposal.kind === "group" || state !== "accepted" ? [] : (proposal.edited ?? []);
	const after = edited.length === 0 ? "" : `, after editing its ${edited.join(" and ")}: what is in effect is theirs`;
	return `The owner ${state} your proposal: ${decidedWhat(proposal)}${after}. This notice is automatic, not from the owner.`;
}
