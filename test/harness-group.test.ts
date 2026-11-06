/**
 * A harness session a group member started (DESIGN.md "Groups", "Connections"): it ends, and wakes the member in its
 * chat for that group, whose answer reaches the room. A member's chat has no route of its own, so the wake goes the way
 * the room's own input does.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished, vi } from "vitest";
import { connectHarness, Harnesses } from "../src/core/harness.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { harnessesArea } from "../src/server/routes/harnesses.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

const textOf = (content: unknown) =>
	typeof content === "string" ? content : Array.isArray(content) ? JSON.stringify(content) : "";

it("ends a session a group member started, and the member reports it in the room", async () => {
	const home = await tempHome();
	const root = join(home, "code");
	await mkdir(join(root, ".git"), { recursive: true });
	vi.stubEnv(
		"BANDA_HARNESSES",
		JSON.stringify({ fake: `${process.execPath} ${join(import.meta.dirname, "fixtures/fake-acp-agent.ts")}` }),
	);
	onTestFinished(() => {
		vi.unstubAllEnvs();
	});
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const respond = (request: ModelContext) => {
		const last = [...request.messages].reverse().find((message) => message.role !== "system");
		if (last?.role === "user") {
			const text = textOf(last.content);
			if (text.includes("<harness-result"))
				return fauxAssistantMessage([fauxToolCall("message_group", { text: "REPORTED" })], {
					stopReason: "toolUse",
				});
			if (text.includes("GO"))
				return fauxAssistantMessage([fauxToolCall("harness__fake", { prompt: "say finished" })], {
					stopReason: "toolUse",
				});
		}
		return fauxAssistantMessage("Done.");
	};
	faux.setResponses(Array.from({ length: 30 }, () => respond as never));
	const registry = createRegistry();
	const blobs = blobStore();
	const core = defineCore({ blobs, gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
	registry.install(core.extension);
	registry.install(core.groupExtension);
	for (const extension of harnessesArea.install!({
		core,
		blobs,
		config: { model: FAUX_MODEL },
		home,
		root: home,
		log: () => {},
	}))
		registry.install(extension);
	const harness = await openStore(home, { models, registry });
	try {
		await harness.commit((tx) => connectHarness(tx, "fake", root, "sancho"), context);
		harness.resume();
		const room = await core.groups.create(harness, { members: ["sancho"] });
		await core.groups.post(harness, { room, key: "go", text: "GO", mentions: ["sancho"] });
		const session = await until(async () => {
			const found = Object.values((await harness.snapshot(Harnesses, context))?.sessions ?? {}).find(
				(one) => one.ended !== undefined,
			);
			return found;
		});
		expect(session).toMatchObject({ state: "done", outcome: "finished" });
		await until(async () =>
			(await core.groups.messages(harness, room)).find(
				(message) => "agent" in message.author && message.text === "REPORTED",
			),
		);
	} finally {
		await harness.close(context);
	}
});
