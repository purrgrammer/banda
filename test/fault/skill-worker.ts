/** Inject a cut before/after the durable skill write and each store commit; redelivery must pair it with its owner input once. */
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	type Harness,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { Accepted, shaOf } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { skillsExtension } from "../../src/core/skills.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, Routes } from "../../src/core/turn.ts";
import { FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults, InjectedFault } from "./faults.ts";

const [home, words, schedule] = process.argv.slice(2);
if (!home || !words || !schedule) throw new Error("home, owner message and schedule required");
const faults = new Faults(JSON.parse(schedule) as Fault[]);
const text = "---\nname: research\ndescription: Check sources\n---\n\n# Research\nCite every source.";
const gateway: Gateway = {
	name: "fake",
	strength: "bearer",
	can: { buttons: false, files: false, threads: true },
	start() {},
	async send() {
		return "sent";
	},
};
let armed = false;
const wrapStorage = (storage: Storage): Storage => {
	const faulted = faults.storage(storage);
	return new Proxy(storage, {
		get(target, key) {
			if (key === "commit")
				return (...args: Parameters<Storage["commit"]>) => (armed ? faulted : target).commit(...args);
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};
const injected = (error: unknown): boolean => {
	for (let current = error; current instanceof Error; current = current.cause)
		if (current instanceof InjectedFault) return true;
	return false;
};
async function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from(
			{ length: 8 },
			(_, n) =>
				(() =>
					n === 0
						? fauxAssistantMessage([fauxToolCall("message_user", { text: "Done" })], { stopReason: "toolUse" })
						: fauxAssistantMessage("Finished.")) as never,
		),
	);
	const registry = createRegistry();
	let harness: Harness;
	const core = defineCore({
		blobs: new BlobStore(join(home!, "blobs")),
		gateway: (name) => (name === gateway.name ? gateway : undefined),
		model: () => FAUX_MODEL,
		tools: () =>
			registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool.name),
		writeSkill: async (chat, requestId, entry, ctx) => {
			if (armed) faults.hit("skill:write:before");
			await (await harness.conversation(chat as ConversationId, ctx))!.submit({ type: "write", requestId, entry }, ctx);
			if (armed) faults.hit("skill:write:after");
		},
	});
	registry.install(core.extension);
	registry.install(skillsExtension);
	harness = await openStore(home!, { models, registry, wrapStorage });
	await harness.commit(async (tx) => {
		(await tx.doc(Accepted)).files["skills/research/SKILL.md"] ??= { text, sha: shaOf(text), at: 1 };
	}, context);
	harness.resume();
	return { harness, core };
}
let run = await setup();
armed = true;
const inbound = { id: "skill-owner", origin: { gateway: "fake", peer: OWNER }, text: words };
async function finish() {
	const received = await run.core.receive(run.harness, inbound);
	if (!("turn" in received)) throw new Error("not admitted");
	await run.harness.waitForTask(received.turn as TaskId, context);
}
try {
	await finish();
} catch (error) {
	if (!injected(error)) throw error;
	await run.harness.close(context).catch(() => {});
	armed = false;
	run = await setup();
	armed = true;
	await finish();
}
armed = false;
const routes = await run.harness.snapshot(Routes, context);
const chat = Object.values(routes?.routes ?? {})[0]?.chat;
if (chat === undefined) throw new Error("no chat after admission");
const conversation = (await run.harness.conversation(chat as ConversationId, context))!;
const entries = (await conversation.entries({}, 100, undefined, context)).items;
const loads = entries.filter((entry) => entry.kind === "banda.skill-load");
const owner = entries.filter((entry) => entry.kind === "banda.inbound");
const { messages } = await conversation.context(context);
console.log(
	JSON.stringify({
		loads: loads.length,
		owner: owner.length,
		order: entries.map((entry) => entry.kind).reverse(),
		context: messages.map((message) => message.role),
		commits: faults.hits("commit:after"),
		writes: faults.hits("skill:write:after"),
	}),
);
await run.harness.close(context);
