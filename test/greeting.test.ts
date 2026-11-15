/** An agent's first message is its own (DESIGN.md "The app"): asked for once, said by its run, kept in its chat. */
import { type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { OWNER } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, GREET, GREETING, type TurnResult } from "../src/core/turn.ts";
import { itemOf } from "../src/server/transcript.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

const asText = (content: Context["messages"][number]["content"]): string =>
	typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

const HELLO = "I'm Sancho, and I plan things.";
const ASKED = "What shall we start with?";
const OFFERS = ["Plan my week", "Find a flat in Porto"];

/**
 * A band whose model greets when asked to (its own words, and what it offers), does what the owner picked, and
 * otherwise answers "noted"; and what every request to it carried.
 */
async function band() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const requests: string[][] = [];
	const respond = (request: Context) => {
		requests.push(request.messages.map((message) => (message.role === "assistant" ? "" : asText(message.content))));
		const last = request.messages.at(-1);
		const say = (text: string) =>
			fauxAssistantMessage([fauxToolCall("message_user", { text })], { stopReason: "toolUse" });
		if (last?.role === "toolResult" && last.toolName === "ask_user") return say(`on it: ${asText(last.content)}`);
		if (last?.role === "toolResult") return fauxAssistantMessage("notes");
		if (last?.role === "user" && asText(last.content) === GREET)
			return fauxAssistantMessage(
				[fauxToolCall("message_user", { text: HELLO }), fauxToolCall("ask_user", { question: ASKED, options: OFFERS })],
				{ stopReason: "toolUse" },
			);
		return say("noted");
	};
	faux.setResponses(Array.from({ length: 40 }, () => respond as never));
	const gateway = new FakeGateway();
	const registry = createRegistry();
	const core = defineCore({
		blobs: blobStore(),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		agentOrigin: (agent) => ({ gateway: "fake", peer: OWNER, thread: agent }),
	});
	registry.install(core.extension);
	const harness = await openStore(await tempHome(), { models, registry });
	harness.resume();
	const entries = (chat: number) =>
		harness.commit(async (tx) => (await tx.scanEntries({ conversationId: chat as ConversationId }, 50)).items, context);
	const settle = (turn: number) => harness.waitForTask(turn as TaskId<TurnResult>, context);
	const write = (id: string, text: string) =>
		core.receive(harness, { id, origin: { gateway: "fake", peer: OWNER, thread: "sancho" }, text });
	return { core, harness, gateway, requests, entries, settle, write };
}

describe("an agent's first message", () => {
	it("is the agent's own words, then its question with what it offers, and the owner's pick is what it does", async () => {
		const { core, harness, gateway, requests, entries, settle, write } = await band();
		const greeted = await core.greet(harness, "sancho");
		if (greeted?.turn === undefined) throw new Error("the greeting started no turn");
		// the agent asked, in its words, with its offers
		await until(() => gateway.sent.length === 2);
		expect(gateway.sent[0]?.out.text).toBe(HELLO);
		expect(gateway.sent[1]?.out.ask?.ask).toMatchObject({ question: ASKED, options: OFFERS });
		// the chat holds the daemon's instruction, never as the owner's message, and then the agent's question
		const items = (await entries(greeted.chat)).flatMap((entry) => itemOf(entry) ?? []);
		expect(items.find((item) => item.role === "instruction")).toMatchObject({ text: GREET });
		expect(items.some((item) => item.role === "user")).toBe(false);
		expect(items.flatMap((item) => (item.role === "assistant" ? (item.calls ?? []) : []))).toMatchObject([
			{ name: "message_user", args: { text: HELLO } },
			{ name: "ask_user", args: { question: ASKED, options: OFFERS } },
		]);

		// the owner picks one: it answers the question, and the same run goes on with it
		const answered = await write("owner-1", "Plan my week");
		expect(answered).toMatchObject({ chat: greeted.chat });
		expect("answered" in answered).toBe(true);
		expect(await settle(greeted.turn)).toMatchObject({ state: { outcome: { result: { ended: "answered" } } } });
		expect(gateway.sent.at(-1)?.out.text).toContain("on it: The owner answered:\nPlan my week");

		// a later message runs on a transcript that holds the greeting
		const next = await write("owner-2", "And the weekend");
		if (!("turn" in next)) throw new Error(JSON.stringify(next));
		await settle(next.turn);
		expect(requests.find((request) => request.at(-1) === "And the weekend")).toContain(GREET);
		await harness.close(context);
	});

	it("is asked for once, however often the chat is opened", async () => {
		const { core, harness, gateway, entries } = await band();
		const [first, second] = await Promise.all([core.greet(harness, "sancho"), core.greet(harness, "sancho")]);
		expect([first, second].filter((greeted) => greeted?.turn !== undefined)).toHaveLength(1);
		expect(second?.chat).toBe(first?.chat);
		await until(() => gateway.sent.length === 2);
		expect(await core.greet(harness, "sancho")).toEqual({ chat: first?.chat });
		expect((await entries(first?.chat as number)).filter((entry) => entry.kind === GREETING)).toHaveLength(1);
		expect(gateway.sent).toHaveLength(2);
		await harness.close(context);
	});

	it("is not asked for in a chat the owner started", async () => {
		const { core, harness, gateway, entries, settle, write } = await band();
		const started = await write("owner-1", "Plan my week");
		if (!("turn" in started)) throw new Error(JSON.stringify(started));
		await settle(started.turn);
		expect(await core.greet(harness, "sancho")).toEqual({ chat: started.chat });
		expect((await entries(started.chat)).some((entry) => entry.kind === GREETING)).toBe(false);
		expect(gateway.sent.map(({ out }) => out.text)).toEqual(["noted"]);
		await harness.close(context);
	});

	it("greets each agent in its own chat, and no agent that is not active", async () => {
		const { core, harness, gateway } = await band();
		await harness.commit(async (tx) => {
			const reader = "---\nname: Reader\ndescription: Reads things\n---\nYou are Reader.\n";
			(await tx.doc(Accepted)).files[agentPath("reader")] = { sha: shaOf(reader), text: reader, at: 1 };
		}, context);
		const lead = await core.greet(harness, "sancho");
		const reader = await core.greet(harness, "reader");
		expect(reader?.chat).not.toBe(lead?.chat);
		expect(reader?.turn).toBeDefined();
		await until(() => gateway.sent.length === 4);
		expect(gateway.sent.map(({ to }) => to.thread).sort()).toEqual(["reader", "reader", "sancho", "sancho"]);
		expect(await core.greet(harness, "nobody")).toBeUndefined();
		await harness.close(context);
	});
});
