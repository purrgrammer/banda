import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type JsonObject, type TaskId } from "@earendil-works/pi-durable";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import { OWNER } from "../src/core/gateway.ts";
import { Groups } from "../src/core/groups.ts";
import { decidedText, PROPOSAL_DECIDED, PROPOSAL_ENTRY, type Proposal, Proposals } from "../src/core/proposals.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, NUDGE, type TurnResult } from "../src/core/turn.ts";
import type { Workspace } from "../src/server/agents.ts";
import { proposalView } from "../src/server/proposals.ts";
import type { Deps } from "../src/server/routes/area.ts";
import { proposals as proposalArea } from "../src/server/routes/proposals.ts";
import { itemOf } from "../src/server/transcript.ts";
import { ProposalCard } from "../web/src/chat/Proposal.tsx";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

describe("agent proposals", () => {
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

	it("stores an owner-reviewed proposal as a feed entry without making it effective", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		let first = true;
		let answered = false;
		const respond = (_request: ModelContext) => {
			if (first) {
				first = false;
				return fauxAssistantMessage(
					[
						fauxToolCall("propose_agent", {
							id: "writer",
							name: "Writer",
							face: JSON.parse(JSON.stringify(defaultAvatarFace())),
							description: "Writes drafts",
							model: { provider: "openai", modelId: "gpt-6.1-sol" },
							tier: "deep",
							instructions: "Write clearly and wait for review.",
						}),
						fauxToolCall("propose_agent_change", { description: "The lead agent." }),
						fauxToolCall("message_user", { text: "I proposed a writer agent for your review." }),
					],
					{ stopReason: "toolUse" },
				);
			}
			if (!answered) {
				answered = true;
				return fauxAssistantMessage([fauxToolCall("react", { reaction: "👍" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage("done");
		};
		faux.setResponses(Array.from({ length: 10 }, () => respond as never));
		const registry = createRegistry();
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), { models, registry });
		harness.resume();
		const started = await core.receive(harness, {
			id: "owner-1",
			origin: { gateway: "fake", peer: OWNER, thread: "main" },
			text: "Propose a writer agent.",
			agent: "sancho",
		});
		if (!("turn" in started)) throw new Error(JSON.stringify(started));
		await harness.waitForTask(started.turn as TaskId<TurnResult>, context);
		const doc = await harness.snapshot(Proposals, context);
		const allProposals = Object.values(doc?.proposals ?? {});
		const proposal = allProposals.find((item) => item.kind === "agent");
		const selfChange = allProposals.find((item) => item.kind === "agentChange");
		expect(selfChange).toMatchObject({ kind: "agentChange", agent: "sancho", description: "The lead agent." });
		expect(selfChange).not.toHaveProperty("beforeAgent");
		expect(selfChange).not.toHaveProperty("proposedAgent");
		expect(proposal).toMatchObject({
			kind: "agent",
			agentId: "writer",
			name: "Writer",
			tier: "deep",
			state: "pending",
		});
		const accepted = await harness.snapshot(Accepted, context);
		expect(accepted?.files[agentPath("writer")]).toBeUndefined();
		const items = await harness.commit(
			(tx) => tx.scanEntries({ conversationId: started.chat as ConversationId, order: "descending" }, 30),
			context,
		);
		expect(items.items.some((item) => item.kind === PROPOSAL_ENTRY)).toBe(true);
		await harness.close(context);
	});

	it("accepts a proposed agent into the accepted file and marks its card in the same save", async () => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("done") as never));
		const registry = createRegistry();
		const core = defineCore({
			blobs: blobStore(),
			gateway: () => new FakeGateway(),
			model: () => FAUX_MODEL,
			registry,
		});
		registry.install(core.extension);
		const harness = await openStore(home, { models, registry });
		const workspace: Workspace = {
			env: () => box.env(),
			root: box.workspace,
			tools: () => [],
			known: () => true,
		};
		try {
			let proposal!: Proposal;
			await harness.commit(async (tx) => {
				const chat = await tx.createConversation({ ownership: { kind: "ownerless" } });
				proposal = {
					id: "agent-1",
					chat: Number(chat.id),
					from: "sancho",
					kind: "agent",
					agentId: "writer",
					name: "Writer",
					face: defaultAvatarFace(),
					description: "Writes drafts",
					model: { provider: "openai", modelId: "gpt-6.1-sol" },
					tier: "deep",
					instructions: "Write clearly.",
					at: 1,
					state: "pending",
				};
				(await tx.doc(Proposals)).proposals[proposal.id] = proposal as unknown as JsonObject;
			}, context);
			const area = proposalArea.start?.({ harness, core, workspace, changed() {} } as unknown as Deps);
			if (area?.route === undefined) throw new Error("proposal route is missing");
			const answer = await area.route({
				method: "POST",
				path: "/proposals/agent-1",
				url: new URL("http://localhost/api/proposals/agent-1"),
				json: async () => ({ action: "accept" }),
				signal: AbortSignal.abort(),
			});
			expect(answer).toMatchObject({ body: { state: "accepted" } });
			expect((await harness.snapshot(Proposals, context))?.proposals[proposal.id]).toMatchObject({ state: "accepted" });
			const accepted = (await harness.snapshot(Accepted, context))?.files[agentPath("writer")];
			expect(accepted?.text).toContain("name: Writer");
			expect(accepted?.text).toContain("model: openai/gpt-6.1-sol");
			expect(accepted?.text).toContain("tier: deep");
			expect(accepted?.text).toContain("Write clearly.");
			expect(await readFile(join(box.workspace, "agents", "writer.md"), "utf8")).toBe(accepted?.text);
			const resultEntries = await harness.commit(
				(tx) => tx.scanEntries({ conversationId: proposal.chat as ConversationId, order: "descending" }, 10),
				context,
			);
			expect(resultEntries.items.filter((entry) => entry.kind === "banda.meta-proposal-result")).toHaveLength(1);
			// the agent is told in its chat's history, in the daemon's words, not the owner's
			const decided = resultEntries.items.filter((entry) => entry.kind === PROPOSAL_DECIDED);
			expect(decided).toHaveLength(1);
			expect(decided[0]?.model).toEqual([
				{
					role: "user",
					content:
						"The owner accepted your proposal: New agent: Writer · Writes drafts. This notice is automatic, not from the owner.",
					timestamp: expect.any(Number),
				},
			]);
			expect(itemOf(decided[0]!)).toMatchObject({ role: "instruction", text: decidedText(proposal, "accepted") });
		} finally {
			await harness.close(context);
			box.close();
		}
	});

	it("refuses an existing-agent proposal after its accepted base changes", async () => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("done") as never));
		const registry = createRegistry();
		const core = defineCore({
			blobs: blobStore(),
			gateway: () => new FakeGateway(),
			model: () => FAUX_MODEL,
			registry,
		});
		registry.install(core.extension);
		const harness = await openStore(home, { models, registry });
		const before = "---\nname: Reader\ndescription: Reads things\n---\nRead carefully.\n";
		const changed = "---\nname: Reader\ndescription: Reads things\n---\nRead carefully and verify claims.\n";
		const workspace: Workspace = {
			env: () => box.env(),
			root: box.workspace,
			tools: () => [],
			known: () => true,
		};
		try {
			await mkdir(join(box.workspace, "agents"), { recursive: true });
			await writeFile(join(box.workspace, "agents", "reader.md"), before);
			let proposal!: Proposal;
			await harness.commit(async (tx) => {
				const accepted = await tx.doc(Accepted);
				accepted.files[agentPath("reader")] = { text: before, sha: shaOf(before), at: 1 };
				const chat = await tx.createConversation({ ownership: { kind: "ownerless" } });
				proposal = {
					id: "change-1",
					chat: Number(chat.id),
					from: "sancho",
					kind: "agentChange",
					agent: "reader",
					displayName: "Reader",
					base: shaOf(before),
					before,
					result: changed,
					at: 1,
					state: "pending",
				};
				(await tx.doc(Proposals)).proposals[proposal.id] = proposal as unknown as JsonObject;
			}, context);
			await harness.commit(async (tx) => {
				(await tx.doc(Accepted)).files[agentPath("reader")] = { text: changed, sha: shaOf(changed), at: 2 };
			}, context);
			const area = proposalArea.start?.({ harness, core, workspace, changed() {} } as unknown as Deps);
			if (area?.route === undefined) throw new Error("proposal route is missing");
			await expect(
				area.route({
					method: "POST",
					path: "/proposals/change-1",
					url: new URL("http://localhost/api/proposals/change-1"),
					json: async () => ({ action: "accept" }),
					signal: AbortSignal.abort(),
				}),
			).rejects.toThrow(/changed since the proposal was made/);
			expect((await harness.snapshot(Proposals, context))?.proposals[proposal.id]).toMatchObject({ state: "pending" });
			expect(await readFile(join(box.workspace, "agents", "reader.md"), "utf8")).toBe(before);
		} finally {
			await harness.close(context);
			box.close();
		}
	});

	it("accepts a group proposal once, with group creation and its dedupe key in one commit", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("done") as never));
		const registry = createRegistry();
		const core = defineCore({
			blobs: blobStore(),
			gateway: () => new FakeGateway(),
			model: () => FAUX_MODEL,
			registry,
		});
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), { models, registry });
		let proposal!: Proposal;
		await harness.commit(async (tx) => {
			const reader = "---\nname: Reader\ndescription: Reads things\n---\nRead carefully.\n";
			(await tx.doc(Accepted)).files[agentPath("reader")] = { text: reader, sha: shaOf(reader), at: 1 };
			const chat = await tx.createConversation({ ownership: { kind: "ownerless" } });
			proposal = {
				id: "task-1:call-1",
				chat: Number(chat.id),
				from: "sancho",
				kind: "group",
				name: "Research",
				members: ["sancho", "reader"],
				memberNames: ["Sancho", "Reader"],
				at: 1,
				state: "pending",
			};
			(await tx.doc(Proposals)).proposals[proposal.id] =
				proposal as unknown as import("@earendil-works/pi-durable").JsonObject;
		}, context);
		let changed = 0;
		const area = proposalArea.start?.({
			harness,
			core,
			workspace: {} as Deps["workspace"],
			changed: () => changed++,
		} as unknown as Deps);
		if (area?.route === undefined) throw new Error("proposal route is missing");
		const request = {
			method: "POST",
			path: `/proposals/${encodeURIComponent(proposal.id)}`,
			url: new URL("http://localhost/api/proposals/task-1%3Acall-1"),
			json: async () => ({ action: "accept" }),
			signal: AbortSignal.abort(),
		};
		await area.route(request);
		await area.route(request);
		const groups = await harness.snapshot(Groups, context);
		expect(Object.keys(groups?.groups ?? {})).toHaveLength(1);
		expect(groups?.proposalRooms?.[proposal.id]).toBe(Number(Object.keys(groups?.groups ?? {})[0]));
		expect(changed).toBe(1);
		await harness.close(context);
	});

	it("tells the agent the owner's decision in its next turn, starting no turn and owing the owner nothing", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const seen: ModelContext[] = [];
		/** The user text the model has not answered yet: what ends the request's messages. */
		const asked = (request: ModelContext) => {
			const last = request.messages.at(-1);
			return last?.role === "user" && typeof last.content === "string" ? last.content : "";
		};
		const respond = (request: ModelContext) => {
			seen.push(request);
			if (asked(request) === "Propose a change.")
				return fauxAssistantMessage(
					[
						fauxToolCall("propose_agent_change", { description: "The lead agent." }),
						fauxToolCall("message_user", { text: "I proposed a change for your review." }),
					],
					{ stopReason: "toolUse" },
				);
			if (asked(request) === "Thanks.")
				return fauxAssistantMessage([fauxToolCall("message_user", { text: "Noted, thanks." })], {
					stopReason: "toolUse",
				});
			return fauxAssistantMessage("done");
		};
		faux.setResponses(Array.from({ length: 10 }, () => respond as never));
		const registry = createRegistry();
		const gateway = new FakeGateway();
		const core = defineCore({ blobs: blobStore(), gateway: () => gateway, model: () => FAUX_MODEL });
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), { models, registry });
		harness.resume();
		try {
			const origin = { gateway: "fake", peer: OWNER, thread: "main" };
			const first = await core.receive(harness, { id: "owner-1", origin, text: "Propose a change.", agent: "sancho" });
			if (!("turn" in first)) throw new Error(JSON.stringify(first));
			await harness.waitForTask(first.turn as TaskId<TurnResult>, context);
			const proposal = Object.values((await harness.snapshot(Proposals, context))?.proposals ?? {}).find(
				(item) => item.kind === "agentChange",
			) as unknown as Proposal;
			expect(proposal).toMatchObject({ state: "pending", chat: first.chat });
			const area = proposalArea.start?.({
				harness,
				core,
				workspace: {} as Deps["workspace"],
				changed() {},
			} as unknown as Deps);
			if (area?.route === undefined) throw new Error("proposal route is missing");
			const answer = await area.route({
				method: "POST",
				path: `/proposals/${encodeURIComponent(proposal.id)}`,
				url: new URL(`http://localhost/api/proposals/${encodeURIComponent(proposal.id)}`),
				json: async () => ({ action: "decline" }),
				signal: AbortSignal.abort(),
			});
			expect(answer).toMatchObject({ body: { state: "declined" } });
			const entries = async () =>
				(
					await harness.commit(
						(tx) => tx.scanEntries({ conversationId: first.chat as ConversationId, order: "ascending" }, 100),
						context,
					)
				).items;
			const notice = decidedText(proposal, "declined");
			expect(notice).toBe(
				"The owner declined your proposal: Change to sancho. This notice is automatic, not from the owner.",
			);
			const decided = (await entries()).filter((entry) => entry.kind === PROPOSAL_DECIDED);
			expect(decided).toHaveLength(1);
			expect(decided[0]?.model?.[0]).toMatchObject({ role: "user", content: notice });
			// the decision starts no turn: no model request, and still the one Turn
			const turns = async () =>
				(await harness.commit((tx) => tx.scanTasks({ kind: "banda.turn" }, 100), context)).items;
			const requestsBefore = seen.length;
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(seen).toHaveLength(requestsBefore);
			expect(await turns()).toHaveLength(1);
			// the agent reads the notice in its next turn, after the decision and before the owner's next words
			const second = await core.receive(harness, { id: "owner-2", origin, text: "Thanks.", agent: "sancho" });
			if (!("turn" in second)) throw new Error(JSON.stringify(second));
			await harness.waitForTask(second.turn as TaskId<TurnResult>, context);
			const next = seen[requestsBefore];
			if (next === undefined) throw new Error("the next turn asked the model nothing");
			const prompt = next.messages.map((message) =>
				message.role === "user" && typeof message.content === "string" ? message.content : undefined,
			);
			expect(prompt.indexOf(notice)).toBeGreaterThan(0);
			expect(prompt.indexOf(notice)).toBeLessThan(prompt.indexOf("Thanks."));
			// the notice is the daemon's, so it neither answered the owner nor is owed an answer: no nudge, no notice
			const kinds = (await entries()).map((entry) => entry.kind);
			expect(kinds.filter((kind) => kind === NUDGE)).toHaveLength(0);
			expect(kinds.filter((kind) => kind === "banda.notice")).toHaveLength(0);
			expect(await turns()).toHaveLength(2);
			expect(gateway.sent.map((sent) => sent.out.text)).toEqual([
				"I proposed a change for your review.",
				"Noted, thanks.",
			]);
		} finally {
			await harness.close(context);
		}
	});
});
