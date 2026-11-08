import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted, AgentChats, agentPath, LEAD_TEXT, shaOf } from "../src/core/agents.ts";
import { AGENT_MESSAGE, readForeign } from "../src/core/foreign.ts";
import { OWNER } from "../src/core/gateway.ts";
import { errandOf } from "../src/core/permissions.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, type TurnResult } from "../src/core/turn.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

/** Whether `chat`'s task now read foreign content. */
const foreign = (harness: Harness, chat: number) =>
	harness.commit(async (tx) => readForeign(tx, chat, (await errandOf(tx, chat)).input), context);

const asText = (content: ModelContext["messages"][number]["content"]): string =>
	typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

describe("agent meta tools", () => {
	it("delivers a direct agent message to the recipient's chat as an untrusted feed entry", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		let sent = false;
		const respond = (request: ModelContext) => {
			const last = request.messages.at(-1);
			if (last?.role === "user" && asText(last.content).includes("contact reader") && !sent) {
				sent = true;
				return fauxAssistantMessage(
					[fauxToolCall("message_agent", { agent: "reader", text: "Please look into the issue." })],
					{ stopReason: "toolUse" },
				);
			}
			if (last?.role === "toolResult" && last.toolName === "react") return fauxAssistantMessage("done");
			if (last?.role === "toolResult")
				return fauxAssistantMessage([fauxToolCall("react", { reaction: "👍" })], { stopReason: "toolUse" });
			return fauxAssistantMessage("I will decide what to do with that message.");
		};
		faux.setResponses(Array.from({ length: 30 }, () => respond as never));
		const registry = createRegistry();
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), { models, registry });
		await harness.commit(async (tx) => {
			const accepted = await tx.doc(Accepted);
			const reader = "---\nname: Reader\ndescription: Reads things\n---\nYou are Reader.\n";
			accepted.files[agentPath("reader")] = { sha: shaOf(reader), text: reader, at: 1 };
			const lead = accepted.files[agentPath("sancho")];
			if (lead === undefined) throw new Error("missing lead definition");
			accepted.files[agentPath("sancho")] = { ...lead, text: LEAD_TEXT, sha: shaOf(LEAD_TEXT) };
		}, context);
		harness.resume();
		const started = await core.receive(harness, {
			id: "owner-1",
			origin: { gateway: "fake", peer: OWNER, thread: "main" },
			text: "contact reader",
			agent: "sancho",
		});
		if (!("turn" in started)) throw new Error(JSON.stringify(started));
		await harness.waitForTask(started.turn as TaskId<TurnResult>, context);
		const readerChat = await until(async () => {
			const chats = (await harness.snapshot(AgentChats, context))?.chats ?? {};
			const id = Object.entries(chats).find(([, agent]) => agent === "reader")?.[0];
			if (id === undefined) return undefined;
			const entry = await harness.commit(
				(tx) => tx.scanEntries({ conversationId: Number(id) as ConversationId, order: "descending" }, 30),
				context,
			);
			return entry.items.some((item) => item.kind === AGENT_MESSAGE) ? Number(id) : undefined;
		});
		const delivered = await harness.commit(
			(tx) => tx.scanEntries({ conversationId: readerChat as ConversationId, order: "descending" }, 30),
			context,
		);
		const message = delivered.items.find((item) => item.kind === AGENT_MESSAGE);
		expect(message?.data).toMatchObject({ from: "sancho", text: "Please look into the issue." });
		// another agent's message is foreign wherever it lands; sending one reads nothing
		expect(await foreign(harness, readerChat)).toBe(true);
		expect(await foreign(harness, started.chat)).toBe(false);
		await harness.close(context);
	});

	it("lets agents read only visible messages from another direct chat", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		let contacted = false;
		const respond = (request: ModelContext) => {
			const last = request.messages.at(-1);
			if (last?.role === "toolResult" && last.toolName === "read_agent_chat")
				return fauxAssistantMessage([fauxToolCall("message_user", { text: "I found the reply." })], {
					stopReason: "toolUse",
				});
			if (last?.role === "toolResult" && last.toolName === "message_user")
				return fauxAssistantMessage("PRIVATE MODEL NOTES");
			const input = last?.role === "user" ? asText(last.content) : "";
			if (input.includes("contact reader") && !contacted) {
				contacted = true;
				return fauxAssistantMessage(
					[fauxToolCall("message_agent", { agent: "reader", text: "Please check the report." })],
					{ stopReason: "toolUse" },
				);
			}
			if (input.includes("Another agent sent you a message"))
				return fauxAssistantMessage([fauxToolCall("message_user", { text: "The report is ready." })], {
					stopReason: "toolUse",
				});
			if (input.includes("read reader's chat"))
				return fauxAssistantMessage([fauxToolCall("read_agent_chat", { agent: "reader", limit: 20 })], {
					stopReason: "toolUse",
				});
			return fauxAssistantMessage("done");
		};
		faux.setResponses(Array.from({ length: 40 }, () => respond as never));
		const registry = createRegistry();
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), { models, registry });
		await harness.commit(async (tx) => {
			const accepted = await tx.doc(Accepted);
			const reader = "---\nname: Reader\ndescription: Reads things\n---\nYou are Reader.\n";
			accepted.files[agentPath("reader")] = { sha: shaOf(reader), text: reader, at: 1 };
			const lead = accepted.files[agentPath("sancho")];
			if (lead === undefined) throw new Error("missing lead definition");
			accepted.files[agentPath("sancho")] = { ...lead, text: LEAD_TEXT, sha: shaOf(LEAD_TEXT) };
		}, context);
		harness.resume();
		const first = await core.receive(harness, {
			id: "owner-1",
			origin: { gateway: "fake", peer: OWNER, thread: "main" },
			text: "contact reader",
			agent: "sancho",
		});
		if (!("turn" in first)) throw new Error(JSON.stringify(first));
		await harness.waitForTask(first.turn as TaskId<TurnResult>, context);
		await until(async () => {
			const chats = (await harness.snapshot(AgentChats, context))?.chats ?? {};
			const target = Object.entries(chats).find(([, agent]) => agent === "reader")?.[0];
			if (target === undefined) return false;
			const entries = await harness.commit(
				(tx) => tx.scanEntries({ conversationId: Number(target) as ConversationId, order: "descending" }, 30),
				context,
			);
			return entries.items.some(
				(entry) =>
					entry.model?.[0]?.role === "assistant" &&
					entry.model[0].content.some((part) => part.type === "toolCall" && part.name === "message_user"),
			);
		});
		expect(await foreign(harness, first.chat)).toBe(false);
		const second = await core.receive(harness, {
			id: "owner-2",
			origin: { gateway: "fake", peer: OWNER, thread: "main" },
			text: "read reader's chat",
			agent: "sancho",
		});
		if (!("turn" in second)) throw new Error(JSON.stringify(second));
		await harness.waitForTask(second.turn as TaskId<TurnResult>, context);
		const source = first.chat as ConversationId;
		const result = await until(async () => {
			const entries = await harness.commit(
				(tx) => tx.scanEntries({ conversationId: source, order: "descending" }, 50),
				context,
			);
			return entries.items.find(
				(entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "read_agent_chat",
			);
		});
		const readResult = result.model?.[0];
		if (readResult?.role !== "toolResult") throw new Error("missing chat read result");
		const words = asText(readResult.content);
		expect(words).toContain("The report is ready.");
		expect(words).not.toContain("PRIVATE MODEL NOTES");
		expect(await foreign(harness, first.chat)).toBe(true);
		await harness.close(context);
	});
});
