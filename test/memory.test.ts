/** Scoped memory: caller-bound prompts, recall and mutations; shared facts; exact-word corrections; rebuildable search. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	type JsonObject,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Box, openBox } from "../src/box/box.ts";
import { boxEnv, boxTools } from "../src/box/tools.ts";
import { OWNER } from "../src/core/gateway.ts";
import { Groups } from "../src/core/groups.ts";
import {
	agentMemoryPath,
	factId,
	GLOBAL_MEMORY,
	lineOf,
	MAX_MEMORY_CHARS,
	type MemoryFiles,
	MemoryLock,
	memoryExtension,
	memorySection,
	parseFacts,
	withoutFact,
} from "../src/core/memory.ts";
import { Search } from "../src/core/search.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { add, boxMemory, edit, memory, remove } from "../src/server/memory.ts";
import { items } from "../src/server/transcript.ts";
import { view } from "../web/src/lib/chat.ts";
import { memoryWords } from "../web/src/lib/segments/memory.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { allowTools, blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const boxes: Box[] = [];
afterAll(() => {
	for (const box of boxes) box.close();
});

const textOf = (message: Message | undefined): string =>
	message === undefined
		? ""
		: typeof message.content === "string"
			? message.content
			: (message.content as readonly { type: string; text?: string }[]).map((part) => part.text ?? "").join("");

/**
 * A core over a box on the host, with memory; the owner's `call:<tool>:<json>` makes the model call it, and each
 * request's system prompt and system messages are kept.
 */
async function open() {
	const home = await tempHome();
	const box = openBox(hostBox(home), () => {});
	boxes.push(box);
	await mkdir(join(box.workspace, "memory"), { recursive: true });
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const requests: { system: string; messages: string[]; results: string[] }[] = [];
	const respond = (ctx: ModelContext) => {
		requests.push({
			system: ctx.systemPrompt ?? "",
			messages: ctx.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m)),
			results: ctx.messages.flatMap((m) =>
				m.role === "toolResult" && m.toolName !== "message_user" ? [textOf(m as Message)] : [],
			),
		});
		const last = ctx.messages.filter((message) => message.role !== "system").at(-1);
		if (last?.role === "toolResult" && last.toolName === "message_user") return fauxAssistantMessage("done");
		const call = last?.role === "toolResult" ? null : /^call:([a-z_]+):([\s\S]+)$/.exec(textOf(last as Message));
		return fauxAssistantMessage(
			[
				call === null
					? fauxToolCall("message_user", { text: "Noted." })
					: fauxToolCall(call[1]!, JSON.parse(call[2]!) as JsonObject),
			],
			{ stopReason: "toolUse" },
		);
	};
	faux.setResponses(Array.from({ length: 500 }, () => respond as never));
	const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
	const files = boxMemory({ env: () => box.env(), root: box.workspace });
	const search = new Search(join(home, "search.db"));
	const lock = new MemoryLock();
	const registry = createRegistry();
	registry.install(core.extension);
	const groups = core.groups;
	registry.install(boxTools({ workspace: box.workspace }));
	registry.install(memoryExtension({ files, search, lock }));
	const harness = await openStore(home, { models, registry, env: boxEnv(box) });
	harness.resume();
	const desk = { harness, files, search, lock };
	/** Say `text` on `thread` (a new one by default) and wait for its run; its chat. */
	const say = async (text: string, thread: string = crypto.randomUUID(), agent = "sancho") => {
		const got = await core.receive(harness, {
			id: crypto.randomUUID(),
			origin: { gateway: "fake", peer: OWNER, thread },
			text,
			agent,
		});
		if (!("turn" in got)) throw new Error(JSON.stringify(got));
		await harness.waitForTask(got.turn as never, context);
		return got.chat;
	};
	const call = (tool: string, args: JsonObject, thread?: string, agent?: string) =>
		say(`call:${tool}:${JSON.stringify(args)}`, thread, agent);
	const lastResult = () => requests.at(-1)?.results.at(-1) ?? "";
	const read = (path: string) => {
		try {
			return readFileSync(join(box.workspace, path), "utf8");
		} catch {
			return "";
		}
	};
	return { home, box, harness, core, groups, files, search, lock, desk, requests, say, call, lastResult, read };
}

function invocation(
	s: Awaited<ReturnType<typeof open>>,
	chat: number,
	name: string,
	args: JsonObject,
	files: MemoryFiles = s.files,
) {
	const tool = memoryExtension({ ...s.desk, files }).tools!.find((tool) => tool.name === name)!;
	const memos = new Map<string, unknown>();
	const api = {
		conversationId: chat,
		now: () => 2,
		commit: s.harness.commit.bind(s.harness),
		memo: async (key: string, value: unknown, ctx?: unknown) => {
			if (ctx !== undefined && !memos.has(key)) memos.set(key, structuredClone(value));
			return memos.get(key);
		},
	} as ToolExecutionApi;
	return () => tool.execute(args, api, context);
}

describe("memory files", () => {
	it("agent facts do not cross agents in prompts, recall, or forget; global facts do", async () => {
		const s = await open();
		await allowTools(s.harness, "mara", ["remember", "recall", "forget"]);
		await allowTools(s.harness, "atlas", ["remember", "recall", "forget"]);
		await s.call("remember", { fact: "zqscope Mara research preference", scope: "agent" }, undefined, "mara");
		const saved = (await memory(s.desk, Date.now())).facts.find((f) => f.text.includes("Mara research"));
		expect(saved).toMatchObject({ scope: "agent", agent: "mara" });
		await s.call("remember", { fact: "zqscope Use metric units", scope: "global" }, undefined, "mara");
		await s.call("recall", { query: "zqscope" }, undefined, "atlas");
		expect(s.lastResult()).toContain("Use metric units");
		expect(s.lastResult()).not.toContain("Mara research");
		expect(s.requests.at(-1)?.messages.join()).not.toContain("Mara research");
		await s.call("forget", { id: saved!.id }, undefined, "atlas");
		expect((await memory(s.desk, Date.now())).facts.some((f) => f.id === saved!.id)).toBe(true);
	});
	it("a group execution has its own agent's context, not the lead's or another member's", async () => {
		const s = await open();
		await allowTools(s.harness, "mara", []);
		await allowTools(s.harness, "atlas", []);
		await add(s.desk, { scope: "global", text: "Metric units" }, 1);
		await add(s.desk, { scope: "agent", agent: "mara", text: "Prefer direct trains" }, 1);
		await add(s.desk, { scope: "agent", agent: "atlas", text: "Primary sources" }, 1);
		const room = await s.groups.create(s.harness, { members: ["mara", "atlas"] });
		const executions = (await s.harness.snapshot(Groups, context))!.groups[room]!.executions;
		const render = (chat: number) =>
			memorySection(s.files).render({ conversationId: chat, read: s.harness } as never, context);
		const mara = await render(executions.mara!.chat);
		expect(mara).toContain("Metric units");
		expect(mara).toContain("Prefer direct trains");
		expect(mara).not.toContain("Primary sources");
		expect(await render(executions.atlas!.chat)).not.toContain("Prefer direct trains");
		expect(await render(999999)).toBeUndefined();
		const call = (chat: number, name: string, args: JsonObject) => invocation(s, chat, name, args)();
		await call(executions.mara!.chat, "remember", { scope: "agent", fact: "zqgroup trains" });
		const fact = (await memory(s.desk, 1)).facts.find((fact) => fact.text === "zqgroup trains")!;
		expect(fact).toMatchObject({ scope: "agent", agent: "mara" });
		expect(JSON.stringify(await call(executions.atlas!.chat, "recall", { query: "zqgroup" }))).not.toContain(
			"zqgroup trains",
		);
		await call(executions.atlas!.chat, "forget", { id: fact.id });
		expect((await memory(s.desk, 1)).facts.some((one) => one.id === fact.id)).toBe(true);
		await call(executions.mara!.chat, "forget", { id: fact.id });
		expect((await memory(s.desk, 1)).facts.some((one) => one.id === fact.id)).toBe(false);
		for (const [name, args] of [
			["remember", { scope: "global", fact: "Unknown" }],
			["recall", { query: "Metric" }],
			["forget", { id: fact.id }],
		] as const) {
			const refused = await call(999999, name, args);
			expect(refused.isError).toBe(true);
			expect(JSON.stringify(refused)).toContain("no agent for memory");
		}
	});

	it("shared updates reach a different agent's existing chat at its next boundary", async () => {
		const s = await open();
		await allowTools(s.harness, "mara", []);
		await allowTools(s.harness, "atlas", []);
		const thread = crypto.randomUUID();
		await s.say("hello", thread, "atlas");
		const before = s.requests.at(-1)!;
		await s.call("remember", { fact: "Always use metric units", scope: "global" }, undefined, "mara");
		await s.say("again", thread, "atlas");
		const after = s.requests.at(-1)!;
		expect(after.messages[0]).toBe(before.messages[0]);
		expect(after.messages.slice(1).join()).toContain("Always use metric units");
	});

	it("corrections bind both the scope and exact old words, and replay without duplicating", async () => {
		const s = await open();
		await allowTools(s.harness, "mara", []);
		const first = await add(s.desk, { scope: "agent", agent: "mara", text: "Window seats" }, 1);
		await s.call("remember", { scope: "global", replaces: first.id, fact: "Aisle seats" }, undefined, "mara");
		expect(s.lastResult()).toContain("outside this scope");
		const update = { scope: "agent", replaces: first.id, fact: "Aisle seats" };
		await s.call("remember", update, undefined, "mara");
		await s.call("remember", update, undefined, "mara");
		expect(s.lastResult()).toContain("Already remembered");
		await expect(edit(s.desk, first.id, "Middle seats", 2)).rejects.toThrow("changed or was removed");
		expect((await memory(s.desk, 3)).facts).toEqual([
			expect.objectContaining({ text: "Aisle seats", scope: "agent", agent: "mara" }),
		]);
	});

	it.each(["add", "correct", "forget"] as const)(
		"an interrupted %s never undoes a later owner edit on replay",
		async (act) => {
			const s = await open();
			const chat = await s.say("remember seating");
			const original = act === "add" ? undefined : await add(s.desk, { scope: "global", text: "Window seats" }, 1);
			const pristine = s.read(GLOBAL_MEMORY).replace("\n\n", "\n");
			if (act === "forget") await s.files.write(GLOBAL_MEMORY, pristine, context);
			let interrupted = false;
			const args: JsonObject =
				act === "forget"
					? { id: original!.id }
					: { scope: "global", fact: "Aisle seats", ...(original === undefined ? {} : { replaces: original.id }) };
			const invoke = invocation(s, chat, act === "forget" ? "forget" : "remember", args, {
				...s.files,
				write: async (path, text, ctx) => {
					await s.files.write(path, text, ctx);
					if (!interrupted) {
						interrupted = true;
						throw new Error("interrupted after write");
					}
				},
			});
			await expect(invoke()).rejects.toThrow("interrupted after write");
			if (act === "forget") {
				// Even identical words, provenance, timestamps and formatting cannot undo the operation mark.
				await add(s.desk, { scope: "global", text: "Window seats" }, 1);
				expect(s.read(GLOBAL_MEMORY).replace(/^<!-- banda memory-operation [a-z0-9-]+ -->\n/, "")).toBe(
					pristine.replace(/^<!-- banda memory-operation [a-z0-9-]+ -->\n/, ""),
				);
			} else await edit(s.desk, factId(GLOBAL_MEMORY, "Aisle seats"), "Window seats", 3);
			const before = s.read(GLOBAL_MEMORY);
			await invoke();
			expect(s.read(GLOBAL_MEMORY)).toBe(before);
			expect((await memory(s.desk, 4)).facts.map((fact) => fact.text)).toEqual(["Window seats"]);
		},
	);

	it("a pre-write interruption cannot replay over owner changes that restore the same file contents", async () => {
		const s = await open();
		const chat = await s.say("hello");
		await add(s.desk, { scope: "global", text: "Anchor" }, 1);
		const original = s.read(GLOBAL_MEMORY);
		let interrupted = false;
		const remember = invocation(
			s,
			chat,
			"remember",
			{ scope: "global", fact: "Window seats" },
			{
				...s.files,
				write: async (path, text, ctx) => {
					if (!interrupted) {
						interrupted = true;
						throw new Error("interrupted before write");
					}
					await s.files.write(path, text, ctx);
				},
			},
		);
		await expect(remember()).rejects.toThrow("interrupted before write");
		const added = await add(s.desk, { scope: "global", text: "Window seats" }, 1);
		await remove(s.desk, added.id);
		const stripMark = (text: string) => text.replace(/^<!-- banda memory-operation [a-z0-9-]+ -->\n/, "");
		expect(stripMark(s.read(GLOBAL_MEMORY))).toBe(stripMark(original));
		const before = s.read(GLOBAL_MEMORY);
		await remember();
		expect(s.read(GLOBAL_MEMORY)).toBe(before);
		expect((await memory(s.desk, 2)).facts.map((fact) => fact.text)).toEqual(["Anchor"]);
	});

	it("replaying a no-op does not add a since-deleted fact or forget a since-created one", async () => {
		const s = await open();
		const chat = await s.say("hello");
		const original = await add(s.desk, { scope: "global", text: "Window seats" }, 1);
		const remember = invocation(s, chat, "remember", { scope: "global", fact: "Window seats" });
		await remember();
		await remove(s.desk, original.id);
		await remember();
		expect((await memory(s.desk, 2)).facts).toEqual([]);
		const forget = invocation(s, chat, "forget", { id: original.id });
		await forget();
		await add(s.desk, { scope: "global", text: "Window seats" }, 3);
		await forget();
		expect((await memory(s.desk, 4)).facts.map((fact) => fact.text)).toEqual(["Window seats"]);
	});

	it("scope comes from canonical paths, not forged metadata; overflow is refused, not silently lost", async () => {
		const s = await open();
		await allowTools(s.harness, "mara", []);
		await s.files.write(
			agentMemoryPath("mara"),
			'- Only Mara <!-- banda {"scope":"global","agent":"atlas"} -->\n',
			context,
		);
		expect((await memory(s.desk, 1)).facts[0]).toMatchObject({ scope: "agent", agent: "mara" });
		await expect(add(s.desk, { scope: "agent", agent: "../atlas", text: "bad" }, 1)).rejects.toThrow();
		await expect(add(s.desk, { text: "no scope" }, 1)).rejects.toThrow();
		for (let i = 0; i < 12; i++) await add(s.desk, { scope: "global", text: `${i} ${"x".repeat(290)}` }, 1);
		const before = s.read(GLOBAL_MEMORY);
		await expect(add(s.desk, { scope: "global", text: "y".repeat(300) }, 1)).rejects.toThrow("Memory is full");
		expect(s.read(GLOBAL_MEMORY)).toBe(before);
		const section = await memorySection(s.files).render(
			{ conversationId: await s.say("hi"), read: s.harness } as never,
			context,
		);
		expect(section!.length).toBeLessThan(MAX_MEMORY_CHARS + 500);
		await add(s.desk, { scope: "agent", agent: "mara", text: "y".repeat(300) }, 1);
		const short = await add(s.desk, { scope: "global", text: "Short" }, 1);
		const full = s.read(GLOBAL_MEMORY);
		await s.call("remember", { scope: "global", replaces: short.id, fact: "z".repeat(300) });
		expect(s.lastResult()).toContain("Memory is full");
		await expect(edit(s.desk, short.id, "z".repeat(300), 2)).rejects.toThrow("Memory is full");
		expect(s.read(GLOBAL_MEMORY)).toBe(full);
		await s.files.write(GLOBAL_MEMORY, `${full}\n- ${"overlong".repeat(50)}\n`, context);
		const bounded = await memorySection(s.files).render(
			{ conversationId: await s.say("hi"), read: s.harness } as never,
			context,
		);
		expect(bounded).toContain("Some file-written facts exceed the memory budget");
		expect(bounded).not.toContain("overlong");
	});

	it("concurrent owner saves share one writer and stale concurrent edits cannot overwrite the winner", async () => {
		const s = await open();
		await Promise.all(
			Array.from({ length: 10 }, (_, i) => add(s.desk, { scope: "global", text: `Shared fact ${i}` }, i + 1)),
		);
		const facts = (await memory(s.desk, 20)).facts;
		expect(facts).toHaveLength(10);
		const results = await Promise.allSettled([
			edit(s.desk, facts[0]!.id, "First correction", 21),
			edit(s.desk, facts[0]!.id, "Other correction", 21),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect((await memory(s.desk, 22)).facts).toHaveLength(10);
	});

	it("hidden metadata is refused rather than reporting a save that its parser cannot read", async () => {
		const s = await open();
		await s.call("remember", { scope: "agent", fact: "Ana likes tea", about: "Ana\u200b", task: "Dinner" });
		expect(s.lastResult()).toContain("Not remembered");
		expect((await memory(s.desk, 1)).facts).toEqual([]);
	});

	it("recall scopes before its limit and global recall never includes direct chat history", async () => {
		const s = await open();
		await allowTools(s.harness, "mara", []);
		await allowTools(s.harness, "atlas", []);
		for (let i = 0; i < 15; i++) await add(s.desk, { scope: "agent", agent: "mara", text: `zqrank hidden ${i}` }, 1);
		await add(s.desk, { scope: "agent", agent: "atlas", text: "zqrank eligible" }, 1);
		await s.call("recall", { query: "zqrank", limit: 1 }, undefined, "atlas");
		expect(s.lastResult()).toContain("zqrank eligible");
		expect(s.lastResult()).not.toContain("hidden");
		await s.say("zqhistory told to atlas", undefined, "atlas");
		await s.call("recall", { query: "zqhistory", scope: "global" }, undefined, "atlas");
		expect(s.lastResult()).not.toContain("told to atlas");
	});

	it("a fact is one line whose comment says where it came from; its id names its file and words", () => {
		const line = lineOf({ text: "Prefers window seats", from: { chat: 3, entry: 41 }, at: 1 });
		const [fact] = parseFacts("memory/travel.md", `# travel\n\n${line}\nnot a fact\n`);
		expect(fact).toEqual({
			id: factId("memory/travel.md", "Prefers window seats"),
			path: "memory/travel.md",
			text: "Prefers window seats",
			from: { chat: 3, entry: 41 },
			at: 1,
		});
		// no value can end the comment early
		const tricky = lineOf({ text: "x", about: "a --> b", for: "<!-- c" });
		expect(parseFacts("memory/a.md", tricky)[0]).toMatchObject({ about: "a --> b", for: "<!-- c" });
		// a line the agent wrote by hand is a fact without a source
		expect(parseFacts("memory/a.md", "- likes tea")[0]).toEqual({
			id: factId("memory/a.md", "likes tea"),
			path: "memory/a.md",
			text: "likes tea",
		});
		expect(withoutFact("memory/a.md", `# a\n- one\n${tricky}\n- two\n`, factId("memory/a.md", "x"))).toBe(
			"# a\n- one\n- two\n",
		);
	});

	it("remember keeps where a fact came from: the owner's message its run answered", async () => {
		const s = await open();
		const chat = await s.call("remember", { fact: "Prefers window seats", scope: "agent" });
		expect(s.lastResult()).toMatch(/^Remembered \[m[0-9a-f]{10}\]\.$/);
		const [fact] = parseFacts(agentMemoryPath("sancho"), s.read(agentMemoryPath("sancho")));
		const owner = await (await s.harness.conversation(chat as ConversationId, context))!.entries(
			{ order: "ascending" },
			5,
			undefined,
			context,
		);
		const said = owner.items.find((entry) => entry.kind === "banda.inbound");
		expect(fact).toMatchObject({ text: "Prefers window seats", from: { chat, entry: Number(said!.id) } });
		// again, the same words: kept once
		await s.call("remember", { fact: "Prefers window seats", scope: "agent" });
		expect(s.lastResult()).toMatch(/^Already remembered/);
		expect(parseFacts(agentMemoryPath("sancho"), s.read(agentMemoryPath("sancho")))).toHaveLength(1);
		await s.call("recall", { query: "window seat" });
		expect(s.lastResult()).toContain(`[${fact!.id}] Prefers window seats (agent)`);
		expect(s.lastResult()).toContain("From your chats:");
	});

	it("keeps no global profile of anyone else: a fact about another person needs an agent task", async () => {
		const s = await open();
		await s.call("remember", { fact: "Sarah is vegetarian", about: "Sarah", scope: "agent" });
		expect(s.lastResult()).toMatch(/only for a task of the owner's/);
		await s.call("remember", {
			fact: "Sarah is vegetarian",
			about: "Sarah",
			task: "dinner on Friday",
			scope: "global",
		});
		expect(s.lastResult()).toMatch(/facts about other people stay with this agent/);
		expect(s.read(GLOBAL_MEMORY)).toBe("");
		await s.call("remember", {
			fact: "Sarah is vegetarian",
			about: "Sarah",
			task: "dinner on Friday",
			scope: "agent",
		});
		expect(parseFacts(agentMemoryPath("sancho"), s.read(agentMemoryPath("sancho")))[0]).toMatchObject({
			text: "Sarah is vegetarian",
			about: "Sarah",
			for: "dinner on Friday",
		});
	});

	it("the owner declares whom a fact is about; provenance is the owner's metadata, never the agent's context", async () => {
		const s = await open();
		await allowTools(s.harness, "mara", []);
		// declared when adding, never detected from the words; shared memory refuses and points to an agent's own
		await expect(
			add(s.desk, { scope: "global", text: "Sarah is vegetarian", about: "Sarah", task: "dinner" }, 1),
		).rejects.toThrow(/stays with an agent/);
		await expect(
			add(s.desk, { scope: "agent", agent: "mara", text: "Sarah is vegetarian", about: "Sarah" }, 1),
		).rejects.toThrow(/names the task/);
		const saved = await add(
			s.desk,
			{ scope: "agent", agent: "mara", text: "Sarah is vegetarian", about: "Sarah", task: "dinner on Friday" },
			1,
		);
		expect(saved).toMatchObject({
			about: "Sarah",
			for: "dinner on Friday",
			from: { owner: true },
			size: expect.any(Number),
		});
		// the agent writes one from a chat: the owner's view says where each fact came from, and the budget as it fills
		await s.call("remember", { fact: "Prefers window seats", scope: "agent" }, undefined, "mara");
		const view = await memory(s.desk, 2);
		expect(view.budget).toBe(MAX_MEMORY_CHARS);
		expect(view.facts.find((fact) => fact.text === "Prefers window seats")?.from).toMatchObject({
			chat: expect.any(Number),
		});
		// the agent's context carries the facts and whom they are about, never who wrote them
		const section = await memorySection(s.files).render(
			{ conversationId: await s.say("hi", undefined, "mara"), read: s.harness } as never,
			context,
		);
		expect(section).toContain("Sarah is vegetarian (agent; about Sarah, for dinner on Friday)");
		expect(section).toContain("Prefers window seats");
		expect(section).not.toContain("owner");
		expect(section).not.toContain("from");
		expect(section).not.toContain("banda");
	});

	it("a global fact is in effect at once, and reaches running chats as an entry", async () => {
		const s = await open();
		const thread = crypto.randomUUID();
		await s.say("hello", thread);
		const first = s.requests.at(-1)!;
		expect(first.messages.join()).not.toContain("<memory>");
		await s.call("remember", { fact: "Never books flights before 9am", scope: "global" });
		const id = factId(GLOBAL_MEMORY, "Never books flights before 9am");
		expect(s.lastResult()).toBe(`Remembered [${id}].`);
		expect((await memory(s.desk, Date.now())).facts).toEqual([expect.objectContaining({ id, scope: "global" })]);
		// the running chat: its prompt's start unchanged, the fact a system entry after it
		await s.say("and now", thread);
		const later = s.requests.at(-1)!;
		expect(later.system).toBe(first.system);
		expect(later.messages[0]).toBe(first.messages[0]);
		expect(later.messages.slice(1).some((m) => m.includes(`[${id}] Never books flights before 9am`))).toBe(true);
		// a new chat has it from its start
		await s.say("fresh");
		expect(s.requests.at(-1)!.messages[0]).toContain(`[${id}] Never books flights before 9am`);
		// forgotten, it leaves at once
		await s.call("forget", { id }, thread);
		expect(s.lastResult()).toBe(`Forgot [${id}].`);
		expect((await memory(s.desk, Date.now())).facts).toEqual([]);
		await s.say("later still");
		expect(s.requests.at(-1)!.messages[0]).not.toContain(`[${id}]`);
	});

	it("the owner's own changes are in effect at once; an edit keeps where the fact came from", async () => {
		const s = await open();
		const added = await add(s.desk, { text: "Likes oat milk", scope: "global" }, 5);
		expect(added).toMatchObject({ text: "Likes oat milk", from: { owner: true }, scope: "global" });
		const edited = await edit(s.desk, added.id, "Likes oat milk, never soy", 7);
		expect(edited).toMatchObject({ from: { owner: true }, edited: 7, scope: "global" });
		const view = await memory(s.desk, 8);
		expect(view.facts.map((fact) => fact.text)).toEqual(["Likes oat milk, never soy"]);
		await s.say("hi");
		expect(s.requests.at(-1)!.messages[0]).toContain("Likes oat milk, never soy");
	});
});

/** Every byte under `dir`, as text: what a deletion must leave no trace in. */
function bytesUnder(dir: string): string {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1"))
		.join("\n");
}

type Op =
	| { op: "add"; scope: "global" | "agent" }
	| { op: "agent"; scope: "global" | "agent" }
	| { op: "delete"; pick: number }
	| { op: "edit"; pick: number }
	| { op: "catchUp" }
	| { op: "say" };

const ops: fc.Arbitrary<Op[]> = fc.array(
	fc.oneof(
		fc.record({
			op: fc.constant("add" as const),
			scope: fc.constantFrom("global" as const, "agent" as const),
		}),
		fc.record({ op: fc.constant("agent" as const), scope: fc.constantFrom("global" as const, "agent" as const) }),
		fc.record({ op: fc.constant("delete" as const), pick: fc.nat() }),
		fc.record({ op: fc.constant("edit" as const), pick: fc.nat() }),
		fc.constant({ op: "catchUp" as const }),
		fc.constant({ op: "say" as const }),
	),
	{ minLength: 1, maxLength: 10 },
);

describe("search", () => {
	it("property: a deletion leaves no trace in the files or the index; caught up bit by bit equals rebuilt", async () => {
		const s = await open();
		let run = 0;
		await fc.assert(
			fc.asyncProperty(ops, async (steps) => {
				run++;
				for (const fact of (await memory(s.desk, Date.now())).facts) await remove(s.desk, fact.id);
				let n = 0;
				const marker = () => `zq${run}x${++n}marker`;
				const deleted: string[] = [];
				for (const step of steps) {
					const facts = (await memory(s.desk, Date.now())).facts;
					const picked = facts.length === 0 ? undefined : facts[("pick" in step ? step.pick : 0) % facts.length];
					switch (step.op) {
						case "add":
							await add(
								s.desk,
								{
									text: `likes ${marker()}`,
									scope: step.scope,
									...(step.scope === "agent" ? { agent: "sancho" } : {}),
								},
								Date.now(),
							);
							break;
						case "agent": {
							// the agent writes a line by hand, with no source
							const path = step.scope === "global" ? GLOBAL_MEMORY : agentMemoryPath("sancho");
							await mkdir(join(s.box.workspace, "memory/agents"), { recursive: true });
							writeFileSync(join(s.box.workspace, path), `${s.read(path)}\n- noted ${marker()}\n`);
							break;
						}
						case "delete":
							if (picked === undefined) break;
							await remove(s.desk, picked.id);
							deleted.push(...(picked.text.match(/zq\d+x\d+marker/g) ?? []));
							break;
						case "edit": {
							if (picked === undefined) break;
							await edit(s.desk, picked.id, `now ${marker()}`, Date.now());
							deleted.push(...(picked.text.match(/zq\d+x\d+marker/g) ?? []));
							break;
						}
						case "catchUp":
							await s.search.memory(s.files, context);
							await s.search.messages(s.harness, context);
							break;
						case "say":
							await s.say(`about ${marker()}`);
							break;
					}
				}
				await s.search.memory(s.files, context);
				await s.search.messages(s.harness, context);
				// what the owner deleted or edited away is nowhere: not in the workspace, not in search.db
				const workspace = bytesUnder(join(s.box.workspace, "memory"));
				const index = readFileSync(join(s.home, "search.db")).toString("latin1");
				for (const gone of deleted) {
					expect(workspace.includes(gone), `${gone} in the files`).toBe(false);
					expect(index.includes(gone), `${gone} in search.db`).toBe(false);
					expect(s.search.find(gone, 5), `${gone} found`).toEqual([]);
				}
				// the index caught up bit by bit is the index rebuilt from scratch
				const incremental = s.search.rows();
				const fresh = new Search(join(s.home, `rebuilt-${run}.db`));
				await fresh.memory(s.files, context);
				await fresh.messages(s.harness, context);
				expect(incremental).toEqual(fresh.rows());
				fresh.close();
				s.search.rebuild();
				await s.search.memory(s.files, context);
				await s.search.messages(s.harness, context);
				expect(s.search.rows()).toEqual(incremental);
			}),
			{ numRuns: pbtRuns(15) },
		);
	}, 600_000);
});

describe("memory in the chat's feed, from what memory holds", () => {
	const lines = async (s: Awaited<ReturnType<typeof open>>, chat: number) => {
		const page = await items(s.harness, chat, {});
		const known = await memory(s.desk, Date.now());
		return view(page?.items ?? [], [], { busy: false, running: [], thinking: false }, { memory: known }).flatMap(
			(segment) => (segment.kind === "memory" ? [{ state: segment.state, words: memoryWords(segment) }] : []),
		);
	};

	it("a fact written reads Remembered; a refused call never does; forgetting it turns the line", async () => {
		const s = await open();
		const thread = crypto.randomUUID();
		const chat = await s.call("remember", { fact: "Prefers window seats", scope: "agent" }, thread);
		// refused by the daemon (someone else, with no task): its words do not matter
		await s.call("remember", { fact: "Ana loves jazz", about: "Ana", scope: "agent" }, thread);
		expect(await lines(s, chat)).toEqual([
			{ state: "done", words: "Remembered: Prefers window seats" },
			{ state: "refused", words: "Not remembered" },
		]);
		const id = factId(agentMemoryPath("sancho"), "Prefers window seats");
		await s.call("forget", { id }, thread);
		expect(await lines(s, chat)).toEqual([
			{ state: "removed", words: "Forgotten since: Prefers window seats" },
			{ state: "refused", words: "Not remembered" },
			{ state: "done", words: "Forgot: Prefers window seats" },
		]);
		// a forget of nothing changed nothing
		await s.call("forget", { id }, thread);
		expect((await lines(s, chat)).at(-1)).toEqual({ state: "refused", words: "Nothing forgotten" });
	});

	it("a global fact reads Remembered at once", async () => {
		const s = await open();
		const chat = await s.call("remember", { fact: "Vegetarian", scope: "global" });
		expect(await lines(s, chat)).toEqual([{ state: "done", words: "Remembered: Vegetarian" }]);
	});
});
