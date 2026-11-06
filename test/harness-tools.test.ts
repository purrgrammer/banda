import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished, vi } from "vitest";
import { OWNER } from "../src/core/gateway.ts";
import { connectHarness, Harnesses } from "../src/core/harness.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, type TurnResult } from "../src/core/turn.ts";
import { harnessesArea } from "../src/server/routes/harnesses.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

it("refuses to resume a session outside the harness's newly connected folder", async () => {
	const home = await tempHome();
	const oldRoot = join(home, "old");
	const newRoot = join(home, "new");
	await mkdir(join(oldRoot, "app", ".git"), { recursive: true });
	await mkdir(join(newRoot, "app", ".git"), { recursive: true });
	const log = join(home, "acp.jsonl");
	vi.stubEnv(
		"BANDA_HARNESSES",
		JSON.stringify({ fake: `${process.execPath} ${join(import.meta.dirname, "fixtures/fake-acp-agent.ts")}` }),
	);
	vi.stubEnv("FAKE_ACP_LOG", log);
	onTestFinished(() => {
		vi.unstubAllEnvs();
	});
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let first: number | undefined;
	const replies: string[] = [];
	const respond = (request: ModelContext) => {
		const last = [...request.messages].reverse().find((message) => message.role !== "system");
		if (last?.role === "toolResult" && last.toolName === "harness__fake") {
			const text = JSON.stringify(last.content);
			replies.push(text);
			return fauxAssistantMessage([fauxToolCall("message_user", { text })], { stopReason: "toolUse" });
		}
		if (last?.role === "user") {
			const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
			if (text === "start" || text === "continue")
				return fauxAssistantMessage(
					[
						fauxToolCall("harness__fake", {
							prompt: "say done",
							...(first === undefined ? { project: "app" } : { session: first }),
						}),
					],
					{ stopReason: "toolUse" },
				);
		}
		return fauxAssistantMessage("Done.");
	};
	faux.setResponses(Array.from({ length: 30 }, () => respond as never));
	const registry = createRegistry();
	const blobs = blobStore();
	const core = defineCore({ blobs, gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
	registry.install(core.extension);
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
		await harness.commit((tx) => connectHarness(tx, "fake", oldRoot, "sancho"), context);
		harness.resume();
		const send = async (text: string) => {
			const received = await core.receive(harness, {
				id: text,
				origin: { gateway: "fake", peer: OWNER, thread: "main" },
				text,
				agent: "sancho",
			});
			if (!("turn" in received)) throw new Error(JSON.stringify(received));
			await harness.waitForTask(received.turn as TaskId<TurnResult>, context);
		};
		await send("start");
		first = await until(async () => {
			const found = Object.entries((await harness.snapshot(Harnesses, context))?.sessions ?? {}).find(
				([, session]) => session.ended !== undefined,
			);
			return found && Number(found[0]);
		});
		await harness.commit((tx) => connectHarness(tx, "fake", newRoot, "sancho"), context);
		await send("continue");
		expect(replies.at(-1)).toContain("It did not start");
		expect(Object.keys((await harness.snapshot(Harnesses, context))?.sessions ?? {})).toHaveLength(1);
		const calls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(calls.filter((entry) => entry.prompt !== undefined)).toHaveLength(1);
	} finally {
		await harness.close(context);
	}
});
