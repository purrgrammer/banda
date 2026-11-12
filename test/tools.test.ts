/**
 * The box's tools in a chat (DESIGN.md "The box"): they run freely in the box, `bash` with colour off.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import { afterAll, describe, expect, it } from "vitest";
import { type Box, type BoxSetup, openBox } from "../src/box/box.ts";
import { containerBox, dockerAvailable, removeContainerBox } from "../src/box/container.ts";
import { attachmentsIn, boxEnv, boxTools } from "../src/box/tools.ts";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { type Origin, OWNER, type Received } from "../src/core/gateway.ts";
import { openWaits } from "../src/core/status.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { maxFileBytes } from "../src/home.ts";
import type { AgentView } from "../src/server/api.ts";
import { items } from "../src/server/transcript.ts";
import { view } from "../web/src/lib/chat.ts";
import { changeWords } from "../web/src/lib/segments/changes.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, FAUX_MODEL, FakeGateway } from "./helpers.ts";

const docker = await dockerAvailable();
const owner: Origin = { gateway: "fake", peer: OWNER };

const homes: string[] = [];
const boxes: Box[] = [];
afterAll(async () => {
	for (const box of boxes) await box.close();
	for (const home of homes) {
		if (docker) await removeContainerBox(home);
		rmSync(home, { recursive: true, force: true });
	}
});

/** A core and a store over `setup`'s box, with a scripted model that records the tools each request offered. */
async function open(setup: (home: string) => BoxSetup, maxFileBytes?: number) {
	const home = mkdtempSync(join(tmpdir(), "banda-tools-test-"));
	homes.push(home);
	const box = openBox(setup(home), () => {});
	boxes.push(box);
	const gateway = new FakeGateway();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const offered: string[][] = [];
	/** Each request's system prompt and system messages, as text. */
	const prompts: string[] = [];
	const blobs = blobStore();
	const core = defineCore({
		blobs,
		box: attachmentsIn(box),
		...(maxFileBytes === undefined ? {} : { maxFileBytes }),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
	});
	const registry = createRegistry();
	registry.install(core.extension);
	registry.install(boxTools({ workspace: box.workspace }));
	const harness = await openStore(home, { models, registry, env: boxEnv(box) });
	harness.resume();
	const script = (...replies: ReturnType<typeof fauxAssistantMessage>[]) =>
		faux.setResponses(
			replies.map((reply) => (request: ModelContext) => {
				prompts.push(JSON.stringify([request.systemPrompt, request.messages.filter((m) => m.role === "system")]));
				offered.push(
					request.messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []).map((tool) => tool.name) : [])),
				);
				return reply;
			}),
		);
	const call = (tool: string, args: JsonObject) =>
		fauxAssistantMessage([fauxToolCall(tool, args, { id: "c1" })], { stopReason: "toolUse" });
	const receive = async (text: string, origin = owner) => {
		const received: Received = await core.receive(harness, { id: crypto.randomUUID(), origin, text });
		if (!("turn" in received)) throw new Error(JSON.stringify(received));
		return received;
	};
	return { home, box, harness, gateway, blobs, script, call, receive, offered, prompts };
}

async function results(harness: Harness, chat: number): Promise<{ text: string; error: boolean }[]> {
	const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
		{ order: "ascending" },
		1000,
		undefined,
		context,
	);
	return page.items
		.filter((e) => e.kind === "pi.tool-result")
		.map((e) => {
			const message = e.model?.[0] as (Message & { content: { text?: string }[]; isError?: boolean }) | undefined;
			return { text: (message?.content ?? []).map((p) => p.text).join(""), error: message?.isError === true };
		});
}

const finished = (harness: Harness, turn: number) => harness.waitForTask(turn as never, context);

describe("the box's tools run freely", () => {
	it("bash runs in the box without asking; read and write too", async () => {
		const s = await open(hostBox);
		s.script(
			s.call("bash", { command: "echo made > made.txt && cat made.txt" }),
			s.call("write", { path: "notes.md", content: "hello" }),
			s.call("read", { path: "notes.md" }),
			fauxAssistantMessage("Done."),
		);
		const { turn, chat } = await s.receive("make a file");
		await finished(s.harness, turn);
		expect(await openWaits(s.harness)).toEqual([]);
		expect(readFileSync(join(s.home, "workspace/made.txt"), "utf8")).toBe("made\n");
		expect(readFileSync(join(s.home, "workspace/notes.md"), "utf8")).toBe("hello");
		const [bash, , read] = await results(s.harness, chat);
		expect(bash).toEqual({ text: "made\n", error: false });
		expect(read?.text).toContain("hello");
		expect(s.offered[0]).toEqual(expect.arrayContaining(["message_user", "bash", "read", "write", "edit"]));
		await s.harness.close(context);
	});

	it("a write or edit to an agent's file says it takes effect once the owner accepts it; one elsewhere, nothing", async () => {
		const s = await open(hostBox);
		mkdirSync(join(s.home, "workspace", "agents"), { recursive: true });
		s.script(
			s.call("write", { path: "agents/reader.md", content: "---\ndescription: Reads\n---\n" }),
			s.call("edit", {
				path: `${s.box.workspace}/agents/reader.md`,
				edits: [{ oldText: "Reads", newText: "Reads well" }],
			}),
			s.call("write", { path: "notes.md", content: "hello" }),
			fauxAssistantMessage("Done."),
		);
		const { turn, chat } = await s.receive("change the reader");
		await finished(s.harness, turn);
		const [write, edit, note] = await results(s.harness, chat);
		for (const result of [write, edit]) {
			expect(result?.error).toBe(false);
			expect(result?.text).toContain("agents/reader.md takes effect only once the owner accepts it in the app");
		}
		expect(note?.text).not.toContain("takes effect");
	});

	it("a write to an agent's file is a feed line read from the agent as the daemon reports it, never from the write", async () => {
		const s = await open(hostBox);
		mkdirSync(join(s.home, "workspace", "agents"), { recursive: true });
		s.script(
			s.call("write", { path: "agents/weather.md", content: "---\ndescription: Weather\n---\n" }),
			fauxAssistantMessage("Done."),
		);
		const { turn, chat } = await s.receive("make a weather agent");
		await finished(s.harness, turn);
		const page = (await items(s.harness, chat, {}))?.items ?? [];
		const lines = (agents?: AgentView[], removed?: { [path: string]: number }) =>
			view(
				page,
				[],
				{ busy: false, running: [], thinking: false },
				{
					...(agents === undefined ? {} : { agents }),
					...(removed === undefined ? {} : { removed }),
				},
			).flatMap((segment) => (segment.kind === "change" ? [[segment.state, changeWords(segment)]] : []));
		const agent = { name: "weather" } as unknown as AgentView;
		expect(lines([{ ...agent, change: { kind: "added", sha: "a" } } as unknown as AgentView])).toEqual([
			["pending", "Allow this change? The agent weather"],
		]);
		expect(lines([{ ...agent, accepted: { sha: "a" } } as unknown as AgentView])).toEqual([
			["done", "Allowed: the agent weather"],
		]);
		expect(lines([])).toEqual([["declined", "Not allowed: the agent weather"]]);
		expect(lines([], { "agents/weather.md": Date.now() + 1000 })).toEqual([
			["removed", "Removed since: the agent weather"],
		]);
		await s.harness.close(context);
	});

	it("a command that changes a before file says so, file by file, and draws its feed line; one that changes none, nothing", async () => {
		const s = await open(hostBox);
		mkdirSync(join(s.home, "workspace", "agents"), { recursive: true });
		// the reader is in effect as "x"
		await s.harness.commit(async (tx) => {
			(await tx.doc(Accepted)).files["agents/reader.md"] = { sha: shaOf("x\n"), text: "x\n", at: 0 };
		}, context);
		const bash = (id: string, command: string) =>
			fauxAssistantMessage([fauxToolCall("bash", { command }, { id })], { stopReason: "toolUse" });
		s.script(
			bash(
				"b1",
				"mkdir -p routines && printf -- '---\\ndescription: Tea\\nevery: 1d\\n---\\nTea.\\n' > routines/tea.md && echo x > agents/reader.md && echo y > notes.txt",
			),
			bash("b2", "cat routines/tea.md > /dev/null && echo z > notes.txt"),
			// it fails, and still removed the reader's file, which is in effect: its removal waits for the owner
			bash("b3", "rm agents/reader.md && exit 3"),
			fauxAssistantMessage("Done."),
		);
		const { turn, chat } = await s.receive("set up tea");
		await finished(s.harness, turn);
		const [made, read, removed] = await results(s.harness, chat);
		expect(made?.text).toContain("routines/tea.md takes effect only once the owner accepts it in the app");
		// written as the version in effect: nothing waits for the owner
		expect(made?.text).not.toContain("agents/reader.md");
		expect(made?.text).not.toContain("notes.txt takes effect");
		expect(read?.text).not.toContain("takes effect");
		expect(removed?.error).toBe(true);
		expect(removed?.text).toContain("agents/reader.md takes effect only once");
		expect(removed?.text).not.toContain("routines/tea.md");

		// the feed draws each file's line where the chat last changed it, read from what the daemon reports
		const page = (await items(s.harness, chat, {}))?.items ?? [];
		const summary = { description: "Tea", when: "Every day", schedule: "every 1d", runsADay: 24, ask: "Tea." };
		const lines = view(
			page,
			[],
			{ busy: false, running: [], thinking: false },
			{
				routines: [
					{ agent: "sancho", name: "tea", state: "allow", change: { kind: "added", sha: "a", routine: summary } },
				],
				agents: [],
			},
		).flatMap((segment) => (segment.kind === "change" ? [[segment.key, segment.state, changeWords(segment)]] : []));
		expect(lines).toEqual([
			[expect.stringMatching(/:b1$/), "pending", "Allow this change? The routine Tea"],
			[expect.stringMatching(/:b3$/), "declined", "Not allowed: the agent reader"],
		]);
		await s.harness.close(context);
	});

	it("bash runs with colour off, and what it prints in colour anyway reaches the model as text", async () => {
		const s = await open(hostBox);
		const command = String.raw`echo "$NO_COLOR $FORCE_COLOR"; printf '\033[2m Test Files \033[22m \033[1m\033[32m1 passed\033[39m\033[22m\n'`;
		s.script(s.call("bash", { command }), fauxAssistantMessage("Done."));
		const { turn, chat } = await s.receive("run the tests");
		await finished(s.harness, turn);
		expect(await results(s.harness, chat)).toEqual([{ text: "1 0\n Test Files  1 passed\n", error: false }]);
		await s.harness.close(context);
	});
});

describe("a message's files", () => {
	it("are read from the box once and sent with the message; a missing one is refused, and nothing is sent", async () => {
		const s = await open(hostBox);
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
		s.script(
			s.call("bash", {
				command: `printf '${[...png].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("")}' > chart.png; echo a,b > data.csv`,
			}),
			fauxAssistantMessage(
				[fauxToolCall("message_user", { text: "Here.", files: ["chart.png", "data.csv"] }, { id: "c2" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxToolCall("message_user", { files: ["missing.txt"] }, { id: "c3" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done."),
		);
		const { turn, chat } = await s.receive("send me the chart");
		await finished(s.harness, turn);
		expect(s.gateway.sent).toHaveLength(1);
		expect(s.gateway.sent[0]?.out).toMatchObject({
			text: "Here.",
			files: [
				{ name: "chart.png", mimeType: "image/png", size: png.length, sha: expect.stringMatching(/^[0-9a-f]{64}$/) },
				{ name: "data.csv", mimeType: "text/csv", size: 4, sha: expect.stringMatching(/^[0-9a-f]{64}$/) },
			],
		});
		// the bytes are blobs, the same that were in the box
		const [chart] = s.gateway.sent[0]?.out.files ?? [];
		expect(await s.blobs.read(chart!.sha)).toEqual(png);
		const [, sent, missing] = await results(s.harness, chat);
		expect(sent?.error).toBe(false);
		expect(sent?.text).toMatch(
			/^Sent, with:\n- \[chart\.png\]\(sha256:[0-9a-f]{64}\) \(image\/png, 1 KB\)\n- \[data\.csv\]\(sha256:/,
		);
		expect(missing?.error).toBe(true);
		expect(missing?.text).toMatch(/^Not sent: missing\.txt: /);
		await s.harness.close(context);
	});
});

describe("the file limit", () => {
	it("a file past it is refused by its size, before it is read or sent", async () => {
		const s = await open(hostBox, 1024);
		s.script(
			s.call("bash", { command: "head -c 4096 /dev/zero > big.bin" }),
			fauxAssistantMessage([fauxToolCall("message_user", { text: "here", files: ["big.bin"] }, { id: "c2" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Too big."),
		);
		const { turn, chat } = await s.receive("send it");
		await finished(s.harness, turn);
		expect(s.gateway.sent).toEqual([]);
		expect((await results(s.harness, chat))[1]).toEqual({
			text: "Not sent: big.bin is 4 KB; a file may be 1 KB at most.",
			error: true,
		});
		await s.harness.close(context);
	});

	it("the config's limit is a positive whole number of bytes, else the daemon says so", () => {
		const model = { provider: "faux", modelId: "faux-1" };
		expect(maxFileBytes({ model })).toBe(50 * 1024 * 1024);
		expect(maxFileBytes({ model, files: { maxBytes: 2048 } })).toBe(2048);
		expect(() => maxFileBytes({ model, files: { maxBytes: -1 } })).toThrow(/files\.maxBytes must be a positive/);
		expect(() => maxFileBytes({ model, files: { maxBytes: 1.5 } })).toThrow(/files\.maxBytes/);
	});
});

describe.skipIf(!docker)("the container box", () => {
	it("bash runs in the box without asking", async () => {
		const s = await open(containerBox);
		s.script(s.call("bash", { command: "id -u; pwd; echo note > n.txt" }), fauxAssistantMessage("Done."));
		const { turn, chat } = await s.receive("where are you?");
		await finished(s.harness, turn);
		expect(await openWaits(s.harness)).toEqual([]);
		expect(await results(s.harness, chat)).toEqual([{ text: `${process.getuid?.()}\n/workspace\n`, error: false }]);
		const read = await s.box.env().readTextFile("/workspace/n.txt", context);
		expect(read.ok && read.value).toBe("note\n");
		await s.harness.close(context);
	}, 120_000);
});
