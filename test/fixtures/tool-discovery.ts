import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	Type,
} from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type ConversationId,
	defineExtension,
	defineTool,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { Accepted, agentPath, shaOf } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { OWNER } from "../../src/core/gateway.ts";
import { context, openStore } from "../../src/core/store.ts";
import { toolDiscoveryExtension, toolRegistry } from "../../src/core/tool-discovery.ts";
import { defineCore } from "../../src/core/turn.ts";
import { FAUX_MODEL } from "./models.ts";

export async function discoveryFixture(
	home: string,
	wrapStorage?: (storage: Storage) => Storage,
	modelBoundary: () => void = () => {},
) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 100 }, () => (request) => {
			modelBoundary();
			if (JSON.stringify(request.messages.at(-1)?.content).includes("Create a structured context checkpoint summary"))
				return fauxAssistantMessage("The owner requested a calendar lookup, which was completed.");
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			const offered = getCurrentTools(request.messages).map((tool) => tool.name);
			const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			if (last?.role === "toolResult" && last.toolName === "message_user") return fauxAssistantMessage("done");
			if (last?.role === "toolResult" && last.toolName === "lookup")
				return call("message_user", { text: "Looked it up." });
			if (offered.includes("lookup")) return call("lookup", {});
			if (last?.role === "toolResult" && last.toolName === "tool_search")
				return call("message_user", { text: "No available lookup tool." });
			return call("tool_search", { query: "lookup", limit: 2 });
		}),
	);
	const registry = toolRegistry();
	const core = defineCore({
		blobs: new BlobStore(join(home, "blobs")),
		model: () => FAUX_MODEL,
		gateway: () => ({
			name: "fake",
			strength: "bearer",
			can: { buttons: false, files: false, threads: true },
			start() {},
			async send() {
				return "sent";
			},
		}),
	});
	registry.install(core.extension);
	registry.install(toolDiscoveryExtension);
	registry.install(
		defineExtension({
			name: "test.discovery",
			tools: ["lookup", "secret__lookup"].map((name) =>
				defineTool({
					name,
					description: name === "lookup" ? "Look up a calendar entry" : "SECRET UNAVAILABLE DESCRIPTION",
					parameters: Type.Object({}),
					replay: "safe",
					execute: async () => ({ output: [{ type: "text", text: "entry" }] }),
				}),
			),
		}),
	);
	const harness = await openStore(home, {
		settings: { compaction: { keepRecentTokens: 1 } },
		models,
		registry,
		...(wrapStorage ? { wrapStorage } : {}),
	});
	const setAllowed = async (allowed: boolean, seed = false) =>
		harness.commit(async (tx) => {
			const files = (await tx.doc(Accepted)).files;
			const path = agentPath("reader");
			if (seed && files[path]) return;
			const text = `---\ndescription: Reader\ntools: [${allowed ? "lookup" : ""}]\n---\nHelp the owner.`;
			files[path] = { text, sha: shaOf(text), at: 1 };
			if (!seed) await core.agentChanged(tx, "reader");
		}, context);
	await setAllowed(true, true);
	harness.resume();
	return {
		harness,
		setAllowed,
		async run(id = "discovery") {
			const got = await core.receive(harness, {
				id,
				agent: "reader",
				origin: { gateway: "fake", peer: OWNER },
				text: "Look up a calendar entry",
			});
			if (!("turn" in got)) throw new Error("input refused");
			const outcome = await harness.waitForTask(got.turn as TaskId, context);
			const chat = got.chat as ConversationId;
			const conversation = (await harness.conversation(chat, context))!;
			return {
				chat,
				outcome,
				state: await harness.snapshot(AgentDoc, chat, context),
				entries: (await conversation.entries({}, 200, undefined, context)).items,
				messages: (await conversation.context(context)).messages,
			};
		},
	};
}
