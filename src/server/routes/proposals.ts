/** Owner review and acceptance for agent-authored proposals. Nothing in a pending proposal is effective. */
import type { ConversationId, Harness, JsonObject, Tx } from "@earendil-works/pi-durable";
import { Accepted, type Agent, agentPath, agentText, shaOf } from "../../core/agents.ts";
import { editProposal, PROPOSAL_RESULT, type Proposal, Proposals, proposalSummary } from "../../core/proposals.ts";
import { context } from "../../core/store.ts";
import type { defineCore } from "../../core/turn.ts";
import { supersedeAgentPublication } from "../agent-publication.ts";
import { boxFiles, save, type Workspace } from "../agents.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule } from "./area.ts";

const proposalOf = (value: unknown): Proposal | undefined => {
	if (typeof value !== "object" || value === null || !("id" in value) || !("kind" in value)) return undefined;
	return value as Proposal;
};

type Core = ReturnType<typeof defineCore>;

/**
 * Record the owner's decision: the card's result for the UI, and the daemon's word to the agent, in one commit. An
 * accepted `proposal` with text the owner edited is recorded as they accepted it, their text with it.
 */
async function finish(tx: Tx, proposal: Proposal, state: "accepted" | "declined", core: Core): Promise<boolean> {
	const doc = await tx.doc(Proposals);
	const current = proposalOf(doc.proposals[proposal.id]);
	if (current === undefined || current.state !== "pending") return false;
	const decided = state === "accepted" ? proposal : current;
	const edited = decided.kind === "group" ? [] : (decided.edited ?? []);
	doc.proposals[proposal.id] = { ...decided, state } as unknown as JsonObject;
	await tx.appendEntry(current.chat as ConversationId, {
		kind: PROPOSAL_RESULT,
		data: {
			proposal: proposal.id,
			state,
			...(edited.length === 0 || decided.kind === "group"
				? {}
				: { edited: Object.fromEntries(edited.map((field) => [field, decided[field] ?? ""])) }),
		},
	});
	await core.proposalDecided(tx, decided, state);
	return true;
}

/** The owner's text for a proposal, from a request: absent, or text by field (`editProposal` says which fields). */
function editsOf(value: unknown): { readonly [field: string]: unknown } {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new BadRequest("edits are the proposal's text, by field");
	return value as { readonly [field: string]: unknown };
}

export const proposals: AreaModule = {
	start: (deps) => {
		const { harness, core, workspace } = deps;
		const ready = harness.commit(async (tx) => {
			await tx.doc(Proposals);
		}, context);
		const locks = new Map<string, Promise<unknown>>();
		const serialized = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
			const prior = locks.get(id) ?? Promise.resolve();
			const current = prior.then(action, action);
			locks.set(id, current);
			try {
				return await current;
			} finally {
				if (locks.get(id) === current) locks.delete(id);
			}
		};
		return {
			watch: [Proposals],
			route: async ({ method, path, json }) => {
				const match = /^\/proposals\/([^/]+)$/.exec(path);
				if (match === null || method !== "POST") return undefined;
				await ready;
				let id: string;
				try {
					id = decodeURIComponent(match[1] ?? "");
				} catch {
					throw new BadRequest("invalid proposal id");
				}
				const body = await json();
				if (body.action !== "accept" && body.action !== "decline") throw new BadRequest("action is accept or decline");
				const action = body.action;
				const state = action === "accept" ? "accepted" : "declined";
				const edits = editsOf(body.edits);
				if (action === "decline" && Object.keys(edits).length > 0)
					throw new BadRequest("only an accepted proposal carries edits");
				return serialized(id, async () => {
					const stored = proposalOf((await harness.snapshot(Proposals, context))?.proposals[id]);
					if (stored === undefined) throw new BadRequest("no such proposal", 404);
					if (stored.state !== "pending") return { body: { state: stored.state } };
					// what is accepted is the proposal as the owner edited it, checked as the agent's own text is
					const edited = editProposal(stored, edits);
					if ("refused" in edited) throw new BadRequest(edited.refused);
					const proposal = edited.proposal;
					if (action === "accept") {
						const saved = await accept(proposal, harness, workspace, core);
						if (saved) {
							deps.changed();
							return {
								body: { state: "accepted", summary: proposalSummary(proposal) },
							};
						}
					}
					await harness.commit((tx) => finish(tx, proposal, state, core), context);
					deps.changed();
					return {
						body: {
							state,
							summary: proposalSummary(proposal),
						},
					};
				});
			},
		};
	},
};

async function accept(proposal: Proposal, harness: Harness, workspace: Workspace, core: Core): Promise<boolean> {
	if (proposal.kind === "group") {
		await core.groups.createProposed(harness, proposal.id, { name: proposal.name, members: proposal.members }, context);
		return false;
	}
	let text: string;
	let name: string;
	let base: string | null;
	if (proposal.kind === "agent") {
		const candidate: Agent = {
			id: proposal.agentId,
			name: proposal.name,
			face: proposal.face,
			state: "active",
			description: proposal.description,
			...(proposal.model === undefined ? {} : { model: proposal.model }),
			...(proposal.tier === undefined ? {} : { tier: proposal.tier }),
			tools: [],
			instructions: proposal.instructions,
		};
		text = agentText(candidate);
		name = proposal.agentId;
		base = null;
	} else {
		text = proposal.result;
		name = proposal.agent;
		base = proposal.base;
	}
	const accepted = (await harness.snapshot(Accepted, context))?.files[agentPath(name)];
	if (proposal.kind === "agentChange" && accepted?.sha !== proposal.base)
		throw new BadRequest(`agents/${name}.md changed since the proposal was made; review the current definition`, 409);
	if (accepted?.text === text) return false;
	if (proposal.kind === "agentChange") {
		const box = (await boxFiles(workspace, context)).files.get(name);
		if (box !== undefined && "text" in box && box.text === text) {
			await harness.commit(async (tx) => {
				const files = await tx.doc(Accepted);
				if (files.files[agentPath(name)]?.sha !== proposal.base)
					throw new BadRequest(
						`agents/${name}.md changed since the proposal was made; review the current definition`,
						409,
					);
				files.files[agentPath(name)] = { text, sha: shaOf(text), at: Date.now() };
				await supersedeAgentPublication(tx, name);
				await core.agentChanged(tx, name);
				await finish(tx, proposal, "accepted", core);
			}, context);
			return true;
		}
	}
	await save(
		harness,
		workspace,
		name,
		text,
		base,
		async (tx, id) => {
			await core.agentChanged(tx, id);
			await finish(tx, proposal, "accepted", core);
		},
		context,
	);
	return true;
}
