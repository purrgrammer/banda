import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
} from "@earendil-works/pi-ai";
import type { ConversationId, PromptInput, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { AVATAR_INSTRUCTIONS, avatarInstructionsExtension, avatarSection } from "../src/core/avatar-instructions.ts";
import { BlobStore } from "../src/core/blobs.ts";
import { OWNER } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { toolDiscoveryExtension, toolRegistry, toolSearchExtension } from "../src/core/tool-discovery.ts";
import { PROPOSE_AVATAR } from "../src/core/toolsets.ts";
import { defineCore } from "../src/core/turn.ts";
import { FAUX_MODEL, tempHome } from "./helpers.ts";

describe("shipped avatar instructions", () => {
	it("fits the bound a face definition is held to, and leaves acceptance to the owner", () => {
		expect(Buffer.byteLength(AVATAR_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(16_384);
		expect(AVATAR_INSTRUCTIONS).toContain("at most 16,384 UTF-8 bytes");
		expect(AVATAR_INSTRUCTIONS).toContain("Do not write agents/ files");
		expect(AVATAR_INSTRUCTIONS).toContain("explicitly accept");
	});
});

describe("the face guide as a section", () => {
	const render = (offered: boolean, shown: Record<string, string>) =>
		avatarSection.render(
			{ agent: { tools: offered ? [{ name: PROPOSE_AVATAR }] : [] }, shown } as unknown as PromptInput,
			context,
		);

	it("joins only a prompt written whole, and stays while propose_avatar does", () => {
		// a prompt in effect: loading the tool adds no section, which would re-add every one
		expect(render(true, { instructions: "<instructions>…</instructions>" })).toBeUndefined();
		// a prompt written whole, as after a compaction
		expect(render(true, {})).toBe(AVATAR_INSTRUCTIONS);
		expect(render(true, { now: "<now>…</now>" })).toBe(AVATAR_INSTRUCTIONS);
		// once in, it stays
		expect(render(true, { instructions: "…", avatar_design: "…" })).toBe(AVATAR_INSTRUCTIONS);
		// without the tool, never
		expect(render(false, {})).toBeUndefined();
		expect(render(false, { avatar_design: "…" })).toBeUndefined();
	});
});

/** A chat of an agent that asks for a face: it searches for propose_avatar, then answers. */
async function faceChat(home: string) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 100 }, () => (request) => {
			if (JSON.stringify(request.messages.at(-1)?.content).includes("Create a structured context checkpoint summary"))
				return fauxAssistantMessage("The owner asked for a face; propose_avatar was loaded.");
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			if (last?.role === "toolResult" && last.toolName === "message_user") return fauxAssistantMessage("done");
			if (last?.role === "toolResult") return call("message_user", { text: "Designing it." });
			if (getCurrentTools(request.messages).some((tool) => tool.name === PROPOSE_AVATAR))
				return call("message_user", { text: "Still here." });
			return call("tool_search", { query: "propose_avatar", limit: 1 });
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
	registry.install(toolSearchExtension);
	registry.install(avatarInstructionsExtension);
	registry.install(toolDiscoveryExtension);
	const harness = await openStore(home, { settings: { compaction: { keepRecentTokens: 1 } }, models, registry });
	await harness.commit(async (tx) => {
		const text = "---\ndescription: Painter\n---\nHelp the owner.";
		(await tx.doc(Accepted)).files[agentPath("painter")] = { text, sha: shaOf(text), at: 1 };
	}, context);
	harness.resume();
	return {
		harness,
		async run(id: string) {
			const got = await core.receive(harness, {
				id,
				agent: "painter",
				origin: { gateway: "fake", peer: OWNER },
				text: "Make yourself a face",
			});
			if (!("turn" in got)) throw new Error("input refused");
			await harness.waitForTask(got.turn as TaskId, context);
			const chat = got.chat as ConversationId;
			const messages = (await (await harness.conversation(chat, context))!.context(context)).messages;
			return { chat, messages };
		},
	};
}

const searchResult = (messages: readonly Message[]) =>
	messages
		.filter((message) => message.role === "toolResult" && message.toolName === "tool_search")
		.flatMap((message) => (message as { content: { type: string; text?: string }[] }).content)
		.map((part) => part.text ?? "")
		.join("");

describe("the face guide", () => {
	it("comes whole with the search that loads propose_avatar, and is still there after a compaction", async () => {
		const chat = await faceChat(await tempHome());
		try {
			const loaded = await chat.run("face");
			expect(getCurrentTools(loaded.messages).map((tool) => tool.name)).toContain(PROPOSE_AVATAR);
			expect(searchResult(loaded.messages)).toContain(AVATAR_INSTRUCTIONS);
			expect(getCurrentSystemPrompt(loaded.messages)).not.toContain("Avatar geometry designer");

			const conversation = (await chat.harness.conversation(loaded.chat, context))!;
			await chat.harness.waitForTask(await conversation.compact(undefined, context), context);
			const after = await chat.run("after-compaction");
			// the summary replaced the search result; the prompt written whole after it carries the guide instead
			expect(searchResult(after.messages)).not.toContain("Avatar geometry designer");
			expect(getCurrentTools(after.messages).map((tool) => tool.name)).toContain(PROPOSE_AVATAR);
			expect(getCurrentSystemPrompt(after.messages)).toContain(AVATAR_INSTRUCTIONS);
		} finally {
			await chat.harness.close(context);
		}
	});
});
