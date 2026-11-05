import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	answerAsk,
	applyUpdate,
	defineHarnesses,
	diffOf,
	folderPath,
	Harnesses,
	type HarnessStep,
	steer,
} from "../src/core/harness.ts";
import { context, openStore } from "../src/core/store.ts";
import { echoModels } from "./fixtures/models.ts";
import { tempHome, until } from "./helpers.ts";

describe("diffOf", () => {
	it("counts the lines between the common start and end", () => {
		const before = "a\nif (x < Date.now()) {\n  go();\n}";
		const after = "a\nconst now = Math.floor(Date.now() / 1000);\nif (x < now) {\n  go();\n}";
		expect(diffOf(before, after)).toEqual({
			added: 2,
			removed: 1,
			diff: "-if (x < Date.now()) {\n+const now = Math.floor(Date.now() / 1000);\n+if (x < now) {",
		});
		expect(diffOf("", "one\ntwo")).toMatchObject({ added: 2, removed: 0 });
	});
});

describe("folderPath", () => {
	it("takes a folder in the home, never the home or the root", () => {
		expect(folderPath("~/sancho")).toBe(join(homedir(), "sancho"));
		expect(folderPath("~")).toBeUndefined();
		expect(folderPath("/")).toBeUndefined();
		expect(folderPath("code/x")).toBeUndefined();
	});
});

describe("applyUpdate", () => {
	it("follows a call from pending to done, and gathers words", () => {
		const steps: HarnessStep[] = [];
		// as claude-agent-acp sends them (spike, 2026-11-05)
		applyUpdate(steps, {
			sessionUpdate: "tool_call",
			toolCallId: "t1",
			title: "Terminal",
			kind: "execute",
			status: "pending",
			rawInput: {},
		});
		applyUpdate(steps, { sessionUpdate: "tool_call_update", toolCallId: "t1", rawInput: { command: "npm test" } });
		applyUpdate(steps, {
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "6 passed" } }],
		});
		applyUpdate(steps, {
			sessionUpdate: "tool_call",
			toolCallId: "t2",
			title: "Write",
			kind: "edit",
			status: "pending",
			rawInput: { file_path: "/w/hello.txt" },
			content: [{ type: "diff", path: "/w/hello.txt", oldText: null, newText: "banda" }],
		});
		applyUpdate(steps, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "do" } });
		applyUpdate(steps, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ne" } });
		expect(steps).toEqual([
			{ kind: "run", command: "npm test", output: "6 passed", running: false, call: "t1" },
			{ kind: "edit", path: "/w/hello.txt", added: 1, removed: 0, diff: "+banda", call: "t2" },
			{ kind: "said", text: "done" },
		]);
	});
});

describe("a harness session", () => {
	const FAKE = join(import.meta.dirname, "fixtures/fake-acp-agent.ts");

	async function setup() {
		const home = await tempHome();
		const folder = await mkdtemp(join(homedir(), ".banda-test-folder-"));
		onTestFinished(() => rm(folder, { recursive: true, force: true }));
		const woke: { chat: number; key: string; text: string; state: unknown }[] = [];
		const made = defineHarnesses({
			definitions: () =>
				new Map([
					[
						"fake",
						{ name: "fake", service: "Fake Code", command: process.execPath, args: [FAKE], mode: "acceptEdits" },
					],
				]),
			followUp: async (_tx, chat, input) => {
				woke.push({ chat, key: input.key, text: input.text, state: input.entry.data.state });
				return 0;
			},
			log: () => {},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test.harness", tasks: [made.Session] }));
		const { models } = echoModels();
		const harness = await openStore(home, { models, registry });
		harness.resume();
		const chat = await harness.commit(
			async (tx) => Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id),
			context,
		);
		const session = async () => (await harness.snapshot(Harnesses, context))?.sessions ?? {};
		return { harness, made, chat, folder, woke, session };
	}

	it("runs the ask once, answers its ask from the owner, takes a note, and wakes the agent at the end", async () => {
		const s = await setup();
		const task = await s.harness.commit(
			(tx) =>
				s.made.begin(tx, {
					chat: s.chat,
					call: "c1",
					agent: "sancho",
					harness: "fake",
					folder: s.folder,
					ask: "edit src/a.ts +2 -1\nask npm test\nsay fixed",
				}),
			context,
		);
		await until(async () => (await s.session())[task]?.asking);
		const asking = (await s.session())[task]?.asking;
		expect(asking?.command).toBe("npm test");
		await s.harness.commit(async (tx) => {
			await steer(tx, task, "say also the changelog", Date.now());
			await answerAsk(tx, task, asking?.id ?? "", true);
		}, context);
		await until(() => s.woke.length > 0);
		const ended = (await s.session())[task];
		expect(ended?.state).toBe("done");
		expect(ended?.call).toBe("c1");
		expect(ended?.steps.map((step) => step.kind)).toEqual(["asked", "edit", "run", "steered", "said"]);
		expect(s.woke).toEqual([expect.objectContaining({ chat: s.chat, key: `harness:${task}`, state: "done" })]);
		await s.harness.close(context);
	});

	it("never sends the ask again after a restart past it: the session is interrupted", async () => {
		const s = await setup();
		const task = await s.harness.commit(async (tx) => {
			const id = await s.made.begin(tx, {
				chat: s.chat,
				agent: "sancho",
				harness: "fake",
				folder: s.folder,
				ask: "say hi",
			});
			(await tx.doc(Harnesses)).sessions[id]!.prompted = true;
			return id;
		}, context);
		await until(() => s.woke.length > 0);
		expect((await s.session())[task]?.state).toBe("interrupted");
		await s.harness.close(context);
	});
});
