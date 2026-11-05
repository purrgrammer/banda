import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
	Type,
} from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { EVERY_AGENT } from "../src/core/agents.ts";
import { OWNER } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, type TurnResult } from "../src/core/turn.ts";
import { allowTools, blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

const plain = (name: string) =>
	defineTool({ name, description: name, parameters: Type.Object({}), execute: async () => ({ output: [] }) });

/**
 * A daemon over `home` with the core and `extra` tools installed, as `daemon.ts` wires it: the lead gets every tool
 * installed, and what it installed reaches every chat before the store resumes. Each request records the tools sent.
 */
async function daemon(home: string, extra: readonly string[], sent: string[][]) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const respond = (request: ModelContext) => {
		// the tools a request offers: its own, then each system entry's removed and added, in order
		const offered = new Set((request.tools ?? []).map(({ name }) => name));
		for (const message of request.messages)
			if (message.role === "system") {
				for (const tool of message.toolsRemoved ?? []) offered.delete(tool.name);
				for (const tool of message.toolsAdded ?? []) offered.add(tool.name);
			}
		sent.push([...offered]);
		return request.messages.at(-1)?.role === "user"
			? fauxAssistantMessage([fauxToolCall("message_user", { reaction: "👍" })], { stopReason: "toolUse" })
			: fauxAssistantMessage("done");
	};
	faux.setResponses(Array.from({ length: 20 }, () => respond as never));
	const registry = createRegistry();
	const core = defineCore({
		blobs: blobStore(),
		gateway: () => new FakeGateway(),
		model: () => FAUX_MODEL,
		tools: () =>
			registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool.name),
	});
	registry.install(core.extension);
	registry.install(defineExtension({ name: "upgrade", tools: extra.map(plain) }));
	const harness = await openStore(home, { models, registry });
	await core.reconcileTools(harness);
	harness.resume();
	return { core, harness };
}

async function say(core: ReturnType<typeof defineCore>, harness: Harness, thread: string, agent?: string) {
	const got = await core.receive(harness, {
		id: `${thread}:${Math.random()}`,
		origin: { gateway: "fake", peer: OWNER, thread },
		text: "hi",
		...(agent === undefined ? {} : { agent }),
	});
	if (!("turn" in got)) throw new Error(JSON.stringify(got));
	await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
}

describe("a chat's tools are what is in effect now", () => {
	it("a tool a daemon upgrade installs, renames or removes reaches chats that began before it", async () => {
		const home = await tempHome();
		const sent: string[][] = [];
		const before = await daemon(home, ["old_name", "kept"], sent);
		await say(before.core, before.harness, "main");
		expect(sent.at(-1)).toEqual(expect.arrayContaining(["old_name", "kept"]));
		await before.harness.close(context);

		// the upgrade: old_name is renamed new_name, and added is new
		const after = await daemon(home, ["new_name", "kept", "added"], sent);
		await say(after.core, after.harness, "main");
		const tools = sent.at(-1) ?? [];
		expect(tools).toEqual(expect.arrayContaining(["new_name", "kept", "added"]));
		expect(tools).not.toContain("old_name");
		await after.harness.close(context);
	});

	it("another agent's chat still gets only its file's tools and every agent's", async () => {
		const home = await tempHome();
		const sent: string[][] = [];
		const before = await daemon(home, ["kept"], sent);
		await allowTools(before.harness, "reader", ["kept"]);
		await say(before.core, before.harness, "reader", "reader");
		await before.harness.close(context);

		const after = await daemon(home, ["kept", "added"], sent);
		await say(after.core, after.harness, "reader");
		const tools = sent.at(-1) ?? [];
		// every agent's tools that this daemon installs (the routines), and its file's: not the new one
		const installed = [
			"message_user",
			"message_agent",
			"read_agent_chat",
			"propose_agent",
			"propose_group",
			"propose_agent_change",
			"schedule",
			"kept",
		];
		expect(EVERY_AGENT).toEqual(expect.arrayContaining(installed.slice(0, 2)));
		expect(new Set(tools)).toEqual(new Set(installed));
		await after.harness.close(context);
	});
});
