/**
 * The process the agent refresh fault suite kills: a helper starts a run on its old accepted definition, that model
 * request accepts a new definition, and the durable refresh waits for the run before changing the chat. On restart,
 * the same input and accepted change are found rather than repeated.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTool,
	type Harness,
} from "@earendil-works/pi-durable";
import { Accepted, agentPath, ChatAgent, ChatTier, shaOf } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, Routes } from "../../src/core/turn.ts";
import { FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const OLD = "---\ndescription: Reads\ntools: [t1]\n---\nOLD MARKER\n";
const NEW = "---\ndescription: Reads better\ntier: quick\ntools: [t2]\n---\nNEW MARKER\n";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
let harness: Harness;
const gateway: Gateway = {
	name: "fake",
	strength: "bearer",
	can: { buttons: false, files: false, threads: true },
	start() {},
	async send() {
		return `out-${process.pid}`;
	},
};
const core = defineCore({
	blobs: new BlobStore(`${home}/blobs`),
	gateway: () => gateway,
	model: () => FAUX_MODEL,
});
const respond = async (request: { messages: readonly { role: string }[] }) => {
	await harness.commit(async (tx) => {
		const accepted = await tx.doc(Accepted);
		if (accepted.files[agentPath("reader")]?.sha === shaOf(NEW)) return;
		accepted.files[agentPath("reader")] = { sha: shaOf(NEW), text: NEW, at: 2 };
		await core.agentChanged(tx, "reader");
	}, context);
	if (request.messages.at(-1)?.role === "user")
		return fauxAssistantMessage([fauxToolCall("message_user", { reaction: "👍" })], { stopReason: "toolUse" });
	return fauxAssistantMessage("done");
};
faux.setResponses(Array.from({ length: 500 }, () => respond as never));

const registry = createRegistry();
registry.install(core.extension);
registry.install(
	defineExtension({
		name: "test",
		tools: ["t1", "t2"].map((name) =>
			defineTool({ name, description: name, parameters: Type.Object({}), execute: async () => ({ output: [] }) }),
		),
	}),
);
harness = await openStore(home, { models, registry, wrapStorage: (storage) => faults.storage(storage) });
await harness.commit(async (tx) => {
	const accepted = await tx.doc(Accepted);
	accepted.files[agentPath("reader")] ??= { sha: shaOf(OLD), text: OLD, at: 1 };
}, context);
harness.resume();

const got = await core.receive(harness, {
	id: "m1",
	origin: { gateway: "fake", peer: OWNER, thread: "reader" },
	text: "work",
	agent: "reader",
});
if (!("chat" in got)) throw new Error(JSON.stringify(got));
const chat = got.chat as ConversationId;

// The owner's chat-specific choice is not replaced by the definition's default on refresh.
await harness.commit(async (tx) => {
	const tier = (await tx.doc(ChatTier)).chats[Number(chat)]!;
	tier.tier = "deep";
	delete tier.inherited;
}, context);
for (let attempt = 0; ; attempt++) {
	const tasks = await harness.commit(async (tx) => {
		const turns = (await tx.scanTasks({ kind: "banda.turn" }, 100)).items;
		const refreshes = (await tx.scanTasks({ kind: "banda.agent-refresh" }, 100)).items;
		return [...turns, ...refreshes].map((task) => ({ kind: task.kind, state: task.state }));
	}, context);
	const effective = (await harness.snapshot(ChatAgent, chat, context))?.agent;
	if (
		effective?.instructions === "NEW MARKER" &&
		tasks.length >= 2 &&
		tasks.every((task) => task.state.status === "terminal")
	)
		break;
	if (attempt === 500) throw new Error(`agent refresh did not settle: ${JSON.stringify({ effective, tasks })}`);
	await new Promise((resolve) => setTimeout(resolve, 10));
}

console.log(
	JSON.stringify({
		agent: (await harness.snapshot(Routes, context))?.chats[Number(chat)]?.agent,
		effective: (await harness.snapshot(ChatAgent, chat, context))?.agent,
		tools: (await harness.snapshot(AgentDoc, chat, context))?.tools,
		tier: (await harness.snapshot(ChatTier, context))?.chats[Number(chat)],
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
