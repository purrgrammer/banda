import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineExtension,
	defineTool,
	type PromptInput,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { AVATAR_INSTRUCTIONS, avatarInstructionsExtension, avatarSection } from "../src/core/avatar-instructions.ts";
import { BlobStore } from "../src/core/blobs.ts";
import { OWNER } from "../src/core/gateway.ts";
import { skillsExtension } from "../src/core/skills.ts";
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
	const render = (tools: string[], deferred: string[]) =>
		avatarSection.render(
			{
				agent: { tools: tools.map((name) => ({ name })), deferred: deferred.map((name) => ({ name })) },
				shown: {},
			} as unknown as PromptInput,
			context,
		);

	it("is empty while propose_avatar waits to load, the whole guide once it has, and absent where it never can", () => {
		expect(render([], [PROPOSE_AVATAR])).toBe("");
		expect(render([PROPOSE_AVATAR], [])).toBe(`<avatar_design>\n${AVATAR_INSTRUCTIONS}\n</avatar_design>`);
		expect(render([], [])).toBeUndefined();
	});
});

const LOOKUP = "lookup";

/**
 * A chat of an agent whose file names `lookup`, a tool not installed yet: the owner's "face" makes it search for
 * propose_avatar, "connect" for connect; anything else it answers.
 */
async function faceChat(home: string) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 200 }, () => (request) => {
			if (JSON.stringify(request.messages.at(-1)?.content).includes("Create a structured context checkpoint summary"))
				return fauxAssistantMessage("The owner asked for a face; propose_avatar was loaded.");
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			if (last?.role === "toolResult" && last.toolName === "message_user") return fauxAssistantMessage("done");
			if (last?.role === "toolResult") return call("message_user", { text: "Done." });
			const said = JSON.stringify(last?.content ?? "");
			if (said.includes("ASK-FACE")) return call("tool_search", { query: PROPOSE_AVATAR, limit: 1 });
			if (said.includes("ASK-CONNECT")) return call("tool_search", { query: "connect", limit: 1 });
			return call("message_user", { text: "Hello." });
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
	// the daemon's order: the guide's section before skills, discovery's after
	registry.install(core.extension);
	registry.install(toolSearchExtension);
	registry.install(avatarInstructionsExtension);
	registry.install(skillsExtension);
	registry.install(toolDiscoveryExtension);
	const harness = await openStore(home, { settings: { compaction: { keepRecentTokens: 1 } }, models, registry });
	const accept = (path: string, text: string) =>
		harness.commit(async (tx) => {
			(await tx.doc(Accepted)).files[path] = { text, sha: shaOf(text), at: 1 };
		}, context);
	await accept(agentPath("painter"), `---\ndescription: Painter\ntools: [${LOOKUP}]\n---\nHelp the owner.`);
	harness.resume();
	let chat: ConversationId | undefined;
	return {
		harness,
		accept,
		/** Install `lookup`, which the agent's file names: a tool to load on demand that was not there before. */
		installLookup: () =>
			registry.install(
				defineExtension({
					name: "test.lookup",
					tools: [
						defineTool({
							name: LOOKUP,
							description: "Look up a calendar entry",
							parameters: Type.Object({}),
							replay: "safe",
							execute: async () => ({ output: [{ type: "text", text: "entry" }] }),
						}),
					],
				}),
			),
		async compact() {
			const conversation = (await harness.conversation(chat!, context))!;
			await harness.waitForTask(await conversation.compact(undefined, context), context);
		},
		/** Say `text` to the agent, wait for its run, and give the context its last request was sent. */
		async say(text: string) {
			const got = await core.receive(harness, {
				id: crypto.randomUUID(),
				agent: "painter",
				origin: { gateway: "fake", peer: OWNER },
				text,
			});
			if (!("turn" in got)) throw new Error("input refused");
			await harness.waitForTask(got.turn as TaskId, context);
			chat = got.chat as ConversationId;
			return (await (await harness.conversation(chat, context))!.context(context)).messages;
		},
	};
}

type Sections = { readonly [key: string]: string | null };
const sectionsOf = (messages: readonly Message[]) =>
	messages.flatMap((message) =>
		message.role === "system" && (message as { sections?: Sections }).sections !== undefined
			? [(message as { sections: Sections }).sections]
			: [],
	);
/** Whether `after` re-added every section since `before`: removed `instructions`, which is always there, and set it again. */
const reAdded = (before: readonly Message[], after: readonly Message[]) =>
	sectionsOf(after)
		.slice(sectionsOf(before).length)
		.some((patch) => patch.instructions === null);
const offered = (messages: readonly Message[]) => getCurrentTools(messages).map((tool) => tool.name);

describe("the face guide, once propose_avatar has loaded", () => {
	it("loads without re-adding every section, and stays through a re-add for the first skill and a compaction", async () => {
		const chat = await faceChat(await tempHome());
		try {
			const start = await chat.say("hello");
			expect(getCurrentSystemPrompt(start)).not.toContain("Avatar geometry designer");
			const loaded = await chat.say("ASK-FACE");
			expect(offered(loaded)).toContain(PROPOSE_AVATAR);
			expect(reAdded(start, loaded)).toBe(false);
			expect(getCurrentSystemPrompt(loaded)).toContain(AVATAR_INSTRUCTIONS);

			// the first accepted skill re-adds every section; the next request still has the whole guide
			await chat.accept(
				"skills/research/SKILL.md",
				"---\nname: research\ndescription: Research with citations\n---\n\nCite.",
			);
			const skilled = await chat.say("hello again");
			expect(reAdded(loaded, skilled)).toBe(true);
			expect(getCurrentSystemPrompt(skilled)).toContain("research: Research with citations");
			expect(getCurrentSystemPrompt(skilled)).toContain(AVATAR_INSTRUCTIONS);

			// a compaction after that re-add writes the prompt whole again, guide included
			await chat.compact();
			const compacted = await chat.say("after compaction");
			expect(offered(compacted)).toContain(PROPOSE_AVATAR);
			expect(getCurrentSystemPrompt(compacted)).toContain(AVATAR_INSTRUCTIONS);
		} finally {
			await chat.harness.close(context);
		}
	});

	it("stays through a re-add for tool discovery coming back, and a compaction after it", async () => {
		const chat = await faceChat(await tempHome());
		try {
			await chat.say("ASK-FACE");
			// nothing left to load: discovery's words go
			const none = await chat.say("ASK-CONNECT");
			expect(offered(none)).toEqual(expect.arrayContaining([PROPOSE_AVATAR, "connect"]));
			expect(getCurrentSystemPrompt(none)).not.toContain("More tools load on demand");
			expect(getCurrentSystemPrompt(none)).toContain(AVATAR_INSTRUCTIONS);

			// a tool to load appears, discovery's words come back and every section is re-added
			chat.installLookup();
			const back = await chat.say("hello");
			expect(reAdded(none, back)).toBe(true);
			expect(getCurrentSystemPrompt(back)).toContain("More tools load on demand");
			expect(getCurrentSystemPrompt(back)).toContain(AVATAR_INSTRUCTIONS);

			await chat.compact();
			const compacted = await chat.say("after compaction");
			expect(getCurrentSystemPrompt(compacted)).toContain(AVATAR_INSTRUCTIONS);
		} finally {
			await chat.harness.close(context);
		}
	});
});
