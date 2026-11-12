/** Owner-reviewed proposals agents may make about the band. Pending proposals are data, never definitions in effect. */
import type { Context } from "@earendil-works/chord";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineDoc,
	defineTool,
	type JsonObject,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Agent } from "./agents.ts";
import { Accepted, AGENT_NAME, AgentChats, acceptedAgent, agentText, MAX_AGENT_BYTES, parseAgent } from "./agents.ts";
import { type AvatarFace, defaultAvatarFace, readAvatarFace } from "./avatar-face.ts";
import { GROUP_LIMIT_RANGE, Groups, groupLimitsIn, MAX_GROUP_NAME } from "./groups.ts";
import { context } from "./store.ts";
import type { ModelId, Tier } from "./tiers.ts";

export const PROPOSAL_ENTRY = "banda.meta-proposal";
export const PROPOSAL_RESULT = "banda.meta-proposal-result";
/**
 * The daemon's word to the agent that the owner decided its proposal: a user message in its chat's history, read at
 * its next model request, which starts no turn and is nobody's input. The owner's decision itself is `PROPOSAL_RESULT`.
 */
export const PROPOSAL_DECIDED = "banda.proposal-decided";
export const PROPOSAL_AGENT = "propose_agent";
export const PROPOSAL_GROUP = "propose_group";
export const PROPOSAL_CHANGE = "propose_agent_change";
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

type AgentProposalArgs = {
	id: string;
	name: string;
	face?: AvatarFace;
	description: string;
	model?: ModelId;
	tier?: Tier;
	instructions: string;
};
type GroupProposalArgs = { name: string; members: string[] };
type ChangeProposalArgs = {
	agent?: string;
	name?: string;
	face?: AvatarFace;
	model?: ModelId | null;
	tier?: Tier | null;
	description?: string;
	instructions?: string;
};
type ProposalArgs = AgentProposalArgs | GroupProposalArgs | ChangeProposalArgs;
type MakeProposal = (
	api: ToolExecutionApi,
	kind: Proposal["kind"],
	args: ProposalArgs,
	ctx: Context,
) => Promise<ToolExecutionResult>;

const result = (text: string, error = false): ToolExecutionResult => ({
	output: [{ type: "text", text }],
	...(error ? { isError: true } : {}),
});

const singleLine = (value: string) => value !== "" && !/\p{Cc}/u.test(value);

function checkedFace(value: unknown): AvatarFace | undefined {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) return undefined;
	const checked = readAvatarFace(encoded);
	return checked.ok ? checked.face : undefined;
}

function checkedModel(value: ModelId): ModelId | undefined {
	const { provider, modelId } = value;
	if (
		provider.trim() === "" ||
		modelId.trim() === "" ||
		/\p{Cc}/u.test(provider) ||
		/\p{Cc}/u.test(modelId) ||
		provider.includes("/")
	)
		return undefined;
	return { provider: provider.trim(), modelId: modelId.trim() };
}

function tool<P extends TSchema>(
	name: string,
	description: string,
	parameters: P,
	kind: Proposal["kind"],
	make: MakeProposal,
): ToolRegistration {
	return defineTool({
		name,
		description,
		parameters,
		replay: "safe",
		executionMode: "sequential",
		execute: async (args, api, ctx) => make(api, kind, args as ProposalArgs, ctx),
	});
}

const avatarSchema = Type.Object({
	definition: Type.Object({
		version: Type.Literal(1),
		id: Type.String({ minLength: 1, maxLength: 64 }),
		name: Type.String({ minLength: 1, maxLength: 100 }),
		body: Type.Object({ path: Type.String({ minLength: 1, maxLength: 16_000 }) }),
		eyes: Type.Object({ x: Type.Number(), y: Type.Number(), spacing: Type.Number(), scale: Type.Number() }),
	}),
	color: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
});
const modelSchema = Type.Object({
	provider: Type.String({ minLength: 1, maxLength: 100 }),
	modelId: Type.String({ minLength: 1, maxLength: 200 }),
});
const tierSchema = Type.Union([Type.Literal("quick"), Type.Literal("balanced"), Type.Literal("deep")]);

export function proposalTools(make: MakeProposal): readonly ToolRegistration[] {
	return [
		tool(
			PROPOSAL_AGENT,
			"Propose an agent definition. The owner reviews it; no agent is created unless accepted. Name, face, description, model, tier and instructions follow the agent definition. New agents start active; tools and connections remain owner-controlled.",
			Type.Object({
				id: Type.String({
					minLength: 1,
					maxLength: 64,
					description: "Stable lowercase id with words joined by dashes, such as analyst.",
				}),
				name: Type.String({ minLength: 1, maxLength: 60, description: "The name shown to the owner." }),
				face: Type.Optional(avatarSchema),
				description: Type.String({ minLength: 1, maxLength: 240 }),
				model: Type.Optional(modelSchema),
				tier: Type.Optional(tierSchema),
				instructions: Type.String({ minLength: 1, maxLength: MAX_PROPOSAL_TEXT }),
			}),
			"agent",
			make,
		),
		tool(
			PROPOSAL_GROUP,
			"Propose a group of two or more active agents, up to as many as the owner's Settings allow. The owner reviews it; " +
				"the group is not created unless accepted.",
			Type.Object({
				name: Type.String({ minLength: 1, maxLength: 60 }),
				members: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
					minItems: 2,
					maxItems: GROUP_LIMIT_RANGE.members[1],
				}),
			}),
			"group",
			make,
		),
		tool(
			PROPOSAL_CHANGE,
			"Propose a change to an existing agent's name, face, description, model, tier or instructions. The owner reviews the resulting definition. Tools, connections, state and permissions cannot be changed.",
			Type.Object({
				agent: Type.Optional(
					Type.String({
						minLength: 1,
						maxLength: 64,
						description: "Stable id of the active agent to change. Omit this to propose changes to yourself.",
					}),
				),
				name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
				face: Type.Optional(avatarSchema),
				model: Type.Optional(Type.Union([modelSchema, Type.Null()])),
				tier: Type.Optional(Type.Union([tierSchema, Type.Null()])),
				description: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
				instructions: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROPOSAL_TEXT })),
			}),
			"agentChange",
			make,
		),
	];
}

/** Record a proposal and its feed entry together, once per tool call. */
export async function makeProposal(
	api: ToolExecutionApi,
	kind: Proposal["kind"],
	args: ProposalArgs,
	ctx: Context = context,
): Promise<ToolExecutionResult> {
	return api.commit(async (tx) => {
		const source = Number(api.conversationId);
		const author = (await tx.doc(AgentChats)).chats[source];
		if (author === undefined || (await tx.doc(Groups)).byExecution[source] !== undefined)
			return result("Not proposed: proposals can be made only from a direct agent chat.", true);
		const id = `${api.taskId}:${api.callId}`;
		const doc = await tx.doc(Proposals);
		if (doc.proposals[id] !== undefined) return result("Proposal sent to the owner for review.");
		let proposal: Proposal;
		if (kind === "agent") {
			const value = args as AgentProposalArgs;
			if (!AGENT_NAME.test(value.id))
				return result("Not proposed: use a lowercase agent id with words joined by dashes.", true);
			if ((await tx.doc(Accepted)).files[`agents/${value.id}.md`] !== undefined)
				return result("Not proposed: an agent already has that id.", true);
			const name = value.name.trim();
			const description = value.description.trim();
			const instructions = value.instructions.trim();
			if (!singleLine(name) || !singleLine(description) || instructions === "")
				return result("Not proposed: give the agent a one-line name and description, and instructions.", true);
			const face = value.face === undefined ? defaultAvatarFace() : checkedFace(value.face);
			if (face === undefined) return result("Not proposed: the face is invalid.", true);
			const model = value.model === undefined ? undefined : checkedModel(value.model);
			if (value.model !== undefined && model === undefined)
				return result("Not proposed: the model needs a provider and model id without line breaks.", true);
			const candidate: Agent = {
				id: value.id,
				name,
				face,
				state: "active",
				description,
				...(model === undefined ? {} : { model }),
				...(value.tier === undefined ? {} : { tier: value.tier }),
				tools: [],
				instructions,
			};
			const proposedText = agentText(candidate);
			const checked = parseAgent(value.id, proposedText);
			if (!("agent" in checked)) return result(`Not proposed: ${checked.errors.join("; ")}`, true);
			if (Buffer.byteLength(proposedText) > MAX_AGENT_BYTES)
				return result("Not proposed: the resulting agent file would be too large.", true);
			proposal = {
				id,
				chat: source,
				from: author,
				kind,
				agentId: value.id,
				name,
				face: checked.agent.face,
				description,
				...(checked.agent.model === undefined ? {} : { model: checked.agent.model }),
				...(checked.agent.tier === undefined ? {} : { tier: checked.agent.tier }),
				instructions,
				at: api.now(),
				state: "pending",
			};
		} else if (kind === "group") {
			const value = args as GroupProposalArgs;
			const members = [...new Set(value.members)];
			const name = value.name.replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_NAME);
			if (name === "") return result("Not proposed: give the group a name.", true);
			const most = (await groupLimitsIn(tx)).members;
			if (members.length < 2 || members.length > most)
				return result(`Not proposed: choose two to ${most} different agents.`, true);
			const memberNames: string[] = [];
			for (const member of members) {
				const agent = await acceptedAgent(tx, member);
				if (agent === undefined) return result(`Not proposed: ${member} is not an active agent.`, true);
				memberNames.push(agent.name);
			}
			proposal = {
				id,
				chat: source,
				from: author,
				kind,
				name,
				members,
				memberNames,
				at: api.now(),
				state: "pending",
			};
		} else {
			const value = args as ChangeProposalArgs;
			const agent = await acceptedAgent(tx, value.agent ?? author);
			if (agent === undefined) return result("Not proposed: the target is not an active agent.", true);
			if (
				value.name === undefined &&
				value.face === undefined &&
				value.model === undefined &&
				value.tier === undefined &&
				value.description === undefined &&
				value.instructions === undefined
			)
				return result("Not proposed: give at least one change.", true);
			if ([value.name, value.description].some((field) => field !== undefined && !singleLine(field.trim())))
				return result("Not proposed: name and description must be nonblank single lines.", true);
			if (value.instructions !== undefined && value.instructions.trim() === "")
				return result("Not proposed: changed instructions cannot be blank.", true);
			const face = value.face === undefined ? undefined : checkedFace(value.face);
			if (value.face !== undefined && face === undefined) return result("Not proposed: the face is invalid.", true);
			const model = value.model == null ? undefined : checkedModel(value.model);
			if (value.model != null && model === undefined)
				return result("Not proposed: the model needs a provider and model id without line breaks.", true);
			const accepted = (await tx.doc(Accepted)).files[`agents/${agent.id}.md`];
			if (accepted === undefined) return result("Not proposed: the target definition is unavailable.", true);
			const parsed = parseAgent(agent.id, accepted.text);
			if (!("agent" in parsed)) return result("Not proposed: the target definition is invalid.", true);
			const nextModel = value.model === undefined ? parsed.agent.model : value.model === null ? undefined : model;
			const nextTier = value.tier === undefined ? parsed.agent.tier : value.tier === null ? undefined : value.tier;
			const { model: _model, tier: _tier, ...base } = parsed.agent;
			const changed: Agent = {
				...base,
				...(value.name === undefined ? {} : { name: value.name.trim() }),
				...(face === undefined ? {} : { face }),
				...(nextModel === undefined ? {} : { model: nextModel }),
				...(nextTier === undefined ? {} : { tier: nextTier }),
				...(value.description === undefined ? {} : { description: value.description.trim() }),
				...(value.instructions === undefined ? {} : { instructions: value.instructions.trim() }),
			};
			const proposedText = agentText(changed);
			const parsedResult = parseAgent(agent.id, proposedText);
			if (!("agent" in parsedResult))
				return result("Not proposed: the resulting agent definition would be invalid.", true);
			if (Buffer.byteLength(proposedText) > MAX_AGENT_BYTES)
				return result("Not proposed: the resulting agent file would be too large.", true);
			proposal = {
				id,
				chat: source,
				from: author,
				kind,
				agent: agent.id,
				displayName: agent.name,
				base: accepted.sha,
				before: accepted.text,
				result: proposedText,
				at: api.now(),
				state: "pending",
				...(value.name === undefined ? {} : { name: value.name.trim() }),
				...(face === undefined ? {} : { face }),
				...(value.model === undefined || value.model === null || model === undefined ? {} : { model }),
				...(value.tier === undefined || value.tier === null ? {} : { tier: value.tier }),
				...(value.description === undefined ? {} : { description: value.description.trim() }),
				...(value.instructions === undefined ? {} : { instructions: value.instructions.trim() }),
			};
		}
		doc.proposals[id] = proposal as unknown as JsonObject;
		await tx.appendEntry(source as ConversationId, { kind: PROPOSAL_ENTRY, data: proposal as unknown as JsonObject });
		return result("Proposal sent to the owner for review.");
	}, ctx);
}

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
