/** Cut the durable message delivery commit, reopen, and retry the same owner input; the recipient gets one entry. */
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Storage, type TaskId } from "@earendil-works/pi-durable";
import { Accepted, AgentChats, agentPath, shaOf } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import type { Gateway } from "../../src/core/gateway.ts";
import { OWNER } from "../../src/core/gateway.ts";
import { context, openStore } from "../../src/core/store.ts";
import { AGENT_MESSAGE, defineCore, type TurnResult } from "../../src/core/turn.ts";
import { FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults, InjectedFault } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2);
if (!home || !scheduleJson) throw new Error("home and fault schedule required");
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const injected = (error: unknown): boolean => {
	for (let current = error; current instanceof Error; current = current.cause)
		if (current instanceof InjectedFault) return true;
	return false;
};
let armed = false;
const wrapStorage = (storage: Storage): Storage => {
	const faulted = faults.storage(storage);
	return new Proxy(storage, {
		get(target, key) {
			if (key === "commit") {
				const commit: Storage["commit"] = (...args) => (armed ? faulted : target).commit(...args);
				return commit;
			}
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};
const gateway: Gateway = {
	name: "fake",
	strength: "bearer",
	can: { buttons: false, files: false, threads: true },
	start() {},
	async send() {
		return "sent";
	},
};
const registry = createRegistry();
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const respond = (request: ModelContext) => {
	const last = request.messages.at(-1);
	const input = last?.role === "user" ? last.content : "";
	const words =
		typeof input === "string" ? input : input.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	if (words.includes("send a note to reader"))
		return fauxAssistantMessage(
			[fauxToolCall("message_agent", { agent: "reader", text: "Please review the report." })],
			{ stopReason: "toolUse" },
		);
	return fauxAssistantMessage("done");
};
faux.setResponses(Array.from({ length: 100 }, () => respond as never));
const core = defineCore({
	blobs: new BlobStore(join(home, "blobs")),
	gateway: () => gateway,
	model: () => FAUX_MODEL,
	registry,
});
registry.install(core.extension);

async function run() {
	const harness = await openStore(home!, { models, registry, wrapStorage });
	await harness.commit(async (tx) => {
		const accepted = await tx.doc(Accepted);
		for (const [id, name] of [
			["sancho", "Sancho"],
			["reader", "Reader"],
		]) {
			const text = `---\nname: ${name}\ndescription: ${name} agent\nstate: active\n---\nYou are ${name}.\n`;
			accepted.files[agentPath(id)] ??= { text, sha: shaOf(text), at: 1 };
		}
	}, context);
	harness.resume();
	return harness;
}

let harness = await run();
const inbound = {
	id: "owner-note-1",
	origin: { gateway: "fake", peer: OWNER, thread: "main" },
	text: "send a note to reader",
	agent: "sancho",
} as const;
armed = true;
try {
	const first = await core.receive(harness, inbound);
	if ("turn" in first) await harness.waitForTask(first.turn as TaskId<TurnResult>, context);
	const retry = await core.receive(harness, inbound);
	if ("turn" in retry) await harness.waitForTask(retry.turn as TaskId<TurnResult>, context);
} catch (error) {
	if (!injected(error)) throw error;
	await harness.close(context).catch(() => {});
	armed = false;
	harness = await run();
	armed = true;
	const retry = await core.receive(harness, inbound);
	if ("turn" in retry) await harness.waitForTask(retry.turn as TaskId<TurnResult>, context);
}
armed = false;
const target = Object.entries((await harness.snapshot(AgentChats, context))?.chats ?? {}).find(
	([, agent]) => agent === "reader",
)?.[0];
if (target === undefined) throw new Error("recipient chat was not created");
let deliveries = 0;
for (;;) {
	const entries = await harness.commit(
		(tx) => tx.scanEntries({ conversationId: Number(target) as ConversationId, order: "descending" }, 50),
		context,
	);
	const delivered = entries.items.some((entry) => entry.kind === AGENT_MESSAGE);
	const answered = entries.items.some(
		(entry) =>
			entry.model?.[0]?.role === "assistant" &&
			entry.model[0].content.some((part) => part.type === "text" && part.text === "done"),
	);
	if (delivered && answered) {
		deliveries = entries.items.filter((entry) => entry.kind === AGENT_MESSAGE).length;
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 10));
}
console.log(
	JSON.stringify({
		deliveries,
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
