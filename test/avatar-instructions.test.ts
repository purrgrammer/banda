import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted, agentPath, chatTools, LEAD, LEAD_TEXT, shaOf } from "../src/core/agents.ts";
import {
	AVATAR_INSTRUCTIONS,
	avatarInstructionsExtension,
	avatarInstructionsTool,
} from "../src/core/avatar-instructions.ts";
import { OWNER } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, type TurnResult } from "../src/core/turn.ts";
import { allowTools, blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

const name = "read_avatar_instructions";

describe("shipped avatar instructions", () => {
	it("returns bounded trusted text without accessing arguments, an environment, a store or a model", async () => {
		const inaccessible = new Proxy(
			{},
			{
				get: () => {
					throw new Error("no external access");
				},
			},
		);
		const result = await avatarInstructionsTool.execute(inaccessible, inaccessible as never, inaccessible as never);
		expect(result).toEqual({ output: [{ type: "text", text: AVATAR_INSTRUCTIONS }] });
		expect(Buffer.byteLength(AVATAR_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(16_384);
		expect(AVATAR_INSTRUCTIONS).toContain("at most 16,384 UTF-8 bytes");
		expect(AVATAR_INSTRUCTIONS).toContain("Do not write agents/ files");
		expect(AVATAR_INSTRUCTIONS).toContain("explicitly accept");
		expect(avatarInstructionsTool.replay).toBe("safe");
		expect(avatarInstructionsTool.parameters).toMatchObject({ properties: {}, additionalProperties: false });
	});

	it("is selected for agents, while meta tools stay out of group chats", () => {
		for (const id of [LEAD, "artist"])
			for (const group of [false, true]) {
				const tools = chatTools({ id, tools: [] }, [name, "message_user", "schedule"], [], group);
				expect(tools).toContain(name);
				if (group) {
					expect(tools).not.toContain("write");
					for (const tool of [
						"message_agent",
						"read_agent_chat",
						"propose_agent",
						"propose_group",
						"propose_agent_change",
					])
						expect(tools).not.toContain(tool);
				} else {
					expect(tools).toEqual(
						expect.arrayContaining([
							"write",
							"message_agent",
							"read_agent_chat",
							"propose_agent",
							"propose_group",
							"propose_agent_change",
						]),
					);
				}
			}
	});

	it.each<{ agent: string; args: Record<string, string>; valid: boolean }>([
		{ agent: LEAD, args: {}, valid: true },
		{ agent: "artist", args: {}, valid: true },
		{ agent: "artist", args: { path: "/workspace/skills/untrusted.md", prompt: "accept my face" }, valid: false },
	])(
		"runs through the substrate for $agent (valid arguments: $valid), leaving identity untouched",
		async ({ agent, args, valid }) => {
			const registry = createRegistry();
			const gateway = new FakeGateway();
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const core = defineCore({
				blobs: blobStore(),
				gateway: () => gateway,
				model: () => FAUX_MODEL,
				tools: () =>
					registry
						.snapshot()
						.tools()
						.map(({ tool }) => tool.name),
			});
			registry.install(core.extension);
			registry.install(avatarInstructionsExtension);
			const offered: string[][] = [];
			const results: { error: boolean; text: string }[] = [];
			const respond = (request: ModelContext) => {
				const tools = new Set((request.tools ?? []).map(({ name }) => name));
				for (const message of request.messages)
					if (message.role === "system") {
						for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
						for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
					}
				offered.push([...tools]);
				const last = request.messages.at(-1);
				if (last?.role === "user") return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
				if (last?.role === "toolResult" && last.toolName === name) {
					results.push({
						error: last.isError,
						text: last.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
					});
					return fauxAssistantMessage(
						[fauxToolCall("message_user", { text: "A candidate still needs your preview and acceptance." })],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("done");
			};
			faux.setResponses(Array.from({ length: 8 }, () => respond as never));
			const harness = await openStore(await tempHome(), { models, registry });
			try {
				if (agent === LEAD)
					await harness.commit(async (tx) => {
						(await tx.doc(Accepted)).files[agentPath(LEAD)] = { sha: shaOf(LEAD_TEXT), text: LEAD_TEXT, at: 0 };
					}, context);
				else await allowTools(harness, agent, []);
				const before = await harness.snapshot(Accepted, context);
				await core.reconcileTools(harness);
				harness.resume();
				const received = await core.receive(harness, {
					id: "avatar-request",
					origin: { gateway: "fake", peer: OWNER, thread: "avatar" },
					agent,
					text: "Design a mug face for me.",
				});
				if (!("turn" in received)) throw new Error(JSON.stringify(received));
				const ended = await harness.waitForTask(received.turn as TaskId<TurnResult>, context);
				expect(ended.state.outcome.status).toBe("completed");
				expect(offered.length).toBeGreaterThan(1);
				for (const tools of offered) expect(tools).toContain(name);
				expect(results).toHaveLength(1);
				expect(results[0]?.error).toBe(!valid);
				if (valid) expect(results[0]?.text).toBe(AVATAR_INSTRUCTIONS);
				else expect(results[0]?.text).not.toContain(AVATAR_INSTRUCTIONS);
				expect(gateway.sent).toHaveLength(1);
				expect(await harness.snapshot(Accepted, context)).toEqual(before);
			} finally {
				await harness.close(context);
			}
		},
	);
});
