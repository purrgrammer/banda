import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTool,
	LiveDoc,
	type TaskId,
} from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	Accepted,
	agentPath,
	agentText,
	ChatAgent,
	ChatTier,
	EVERY_AGENT,
	LEAD_TEXT,
	parseAgent,
	shaOf,
	toolsOf,
} from "../src/core/agents.ts";
import { writeAvatarFace } from "../src/core/avatar-face.ts";
import { DEFAULT_FACE } from "../src/core/choices.ts";
import { type Inbound, OWNER } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, Routes, type TurnResult } from "../src/core/turn.ts";
import { allowTools, blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const errorsOf = (text: string, name = "helper", options?: Parameters<typeof parseAgent>[2]) => {
	const parsed = parseAgent(name, text, options);
	return "errors" in parsed ? parsed.errors : [];
};

describe("agent files", () => {
	it("the lead's file parses, and the lead gets every tool; another agent, what every agent gets and what it names", () => {
		const parsed = parseAgent("sancho", LEAD_TEXT);
		if (!("agent" in parsed)) throw new Error(parsed.errors.join("; "));
		expect(toolsOf(parsed.agent, ["read", "bash", "message_user"])).toEqual([...EVERY_AGENT, "read", "bash"]);
		expect(parsed.agent.instructions).toMatch(/^You are the owner's lead agent\./);
		expect(errorsOf("---\ndescription: x\ntools: [read]\n---\n", "sancho")).toEqual([
			`the lead gets every tool: drop "tools"`,
		]);
		const helper = parseAgent("helper", "---\ndescription: x\ntools: [read, bash, read]\n---\n");
		if (!("agent" in helper)) throw new Error(helper.errors.join("; "));
		// it runs commands, so it may ask about what its proxy held
		expect(toolsOf(helper.agent, ["write"])).toEqual([...EVERY_AGENT, "read", "bash", "propose_send", "ask_hosts"]);
		expect(toolsOf({ ...helper.agent, tools: [] }, [])).toEqual([...EVERY_AGENT]);
	});

	it("every agent gets routines, whatever its file says; a file that lists them parses, and repeats them", () => {
		const helper = parseAgent("helper", "---\ndescription: x\n---\n");
		if (!("agent" in helper)) throw new Error(helper.errors.join("; "));
		for (const tool of ["schedule"]) expect(toolsOf(helper.agent, []), tool).toContain(tool);
		const always = ["schedule"];
		const listed = parseAgent("helper", `---\ndescription: x\ntools: [${always.join(", ")}, read]\n---\n`, {
			tools: [...always, "read"],
		});
		if (!("agent" in listed)) throw new Error(listed.errors.join("; "));
		expect(toolsOf(listed.agent, [])).toEqual([...EVERY_AGENT, "read"]);
	});

	it("takes lists both ways, quotes, a model, and keeps the body as instructions", () => {
		const parsed = parseAgent(
			"researcher",
			`---\ndescription: "Finds things out"\nmodel: anthropic/claude-sonnet-5-5\ntools:\n  - read\n---\n\nDig.\n`,
		);
		expect(parsed).toEqual({
			agent: {
				id: "researcher",
				name: "researcher",
				face: DEFAULT_FACE,
				state: "active",
				description: "Finds things out",
				model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
				tools: ["read"],
				instructions: "Dig.",
			},
		});
	});

	it("refuses emoji, SVG, extra fields and oversized avatar data instead of defaulting invalid faces", () => {
		for (const face of [
			"🦉",
			"<svg onload='alert(1)'/>",
			JSON.stringify({ emoji: "🦉" }),
			JSON.stringify({ ...DEFAULT_FACE, svg: "<svg/>" }),
			JSON.stringify({ ...DEFAULT_FACE, color: "url(https://example.com)" }),
			JSON.stringify({ ...DEFAULT_FACE, definition: { ...DEFAULT_FACE.definition, body: { path: "<svg/>" } } }),
			" ".repeat(16_385),
		]) {
			expect(errorsOf(`---\ndescription: x\nface: ${face}\n---\n`), face.slice(0, 80)).not.toEqual([]);
		}
		expect(errorsOf(`---\ndescription: x\n---\n${"x".repeat(65_537)}`)).toEqual(["An agent file is at most 64 KB."]);
	});

	it("reports every problem, each saying what to write instead", () => {
		expect(errorsOf("no frontmatter")).toEqual(["an agent file starts with its frontmatter between two --- lines"]);
		const errors = errorsOf(
			`---\nname: other\ncolour: red\nmodel: sonnet\ntools: [read, mail]\ntools: [bash]\n---\n`,
			"helper",
			{ tools: ["read", "bash"] },
		);
		expect(errors).toEqual([
			`"tools" is given twice`,
			`add a "description:", which is how the owner and other agents choose it`,
			`"model: sonnet" is not a model: write provider/model, such as anthropic/claude-sonnet-5-5`,
			`"mail" is not a tool: use read, bash`,
		]);
		expect(errorsOf("---\ndescription: x\n---\n", "Bad Name")[0]).toMatch(/is not an agent name/);
		expect(parseAgent("a", "---\ndescription: x\nmodel: p/m\n---\n", { known: () => false })).toEqual({
			errors: [`"model: p/m" is not a model this daemon knows`],
		});
	});

	it("keeps a stable id while identity and settings round-trip through canonical text; a colour or skills are ignored", () => {
		const parsed = parseAgent(
			"travel",
			`---\nname: Maya\nface: ${writeAvatarFace({ ...DEFAULT_FACE, color: "#abcdef" })}\ncolour: blue\nstate: active\ndescription: Plans careful trips\ntier: deep\nskills: [travel-planning]\ntools: [read]\nconnections: [calendar]\n---\nBe practical.\n`,
		);
		if (!("agent" in parsed)) throw new Error(parsed.errors.join("; "));
		expect(parsed.agent).toMatchObject({
			id: "travel",
			name: "Maya",
			face: { ...DEFAULT_FACE, color: "#abcdef" },
			state: "active",
			tier: "deep",
		});
		expect(parsed.agent).not.toHaveProperty("skills");
		expect(agentText(parsed.agent)).not.toMatch(/colour|skills/);
		expect(parseAgent("travel", agentText(parsed.agent))).toEqual(parsed);
		// the first agent is ordinary: archivable like any other (the last active one is the daemon's to refuse)
		expect(errorsOf("---\nstate: archived\ndescription: Default\n---\n", "sancho")).toEqual([]);
	});
});

describe("a chat runs its agent", () => {
	const TOOLS = ["t1", "t2", "t3", "t4"];

	it("never runs a tool its accepted file does not give it", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.subarray(TOOLS),
				fc.array(fc.constantFrom(...TOOLS), { minLength: 1, maxLength: 4 }),
				async (given, calls) => {
					const ran: string[] = [];
					const faux = fauxProvider();
					const models = createModels();
					models.setProvider(faux.provider);
					faux.setResponses([
						fauxAssistantMessage(
							calls.map((name, i) => fauxToolCall(name, {}, { id: `c${i}` })),
							{ stopReason: "toolUse" },
						),
						fauxAssistantMessage("done"),
					]);
					const core = defineCore({
						blobs: blobStore(),
						gateway: () => new FakeGateway(),
						model: () => FAUX_MODEL,
					});
					const registry = createRegistry();
					registry.install(core.extension);
					registry.install(
						defineExtension({
							name: "test",
							tools: TOOLS.map((name) =>
								defineTool({
									name,
									description: name,
									parameters: Type.Object({}),
									execute: async () => {
										ran.push(name);
										return { output: [{ type: "text", text: "ran" }] };
									},
								}),
							),
						}),
					);
					const harness = await openStore(await tempHome(), { models, registry });
					await allowTools(harness, "helper", given);
					harness.resume();
					const got = await core.receive(harness, {
						id: "m1",
						origin: { gateway: "fake", peer: OWNER },
						text: "go",
						agent: "helper",
					});
					if (!("turn" in got)) throw new Error(JSON.stringify(got));
					await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
					const allowed = new Set(given);
					for (const name of ran) expect(allowed.has(name)).toBe(true);
					expect(ran.sort()).toEqual(calls.filter((name) => allowed.has(name)).sort());
					await harness.close(context);
				},
			),
			{ numRuns: pbtRuns(10) },
		);
	});

	it("starts with the agent picked and applies an accepted change while idle", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("ok")));
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), { models, registry });
		harness.resume();
		const message = (id: string, agent?: string): Inbound => ({
			id,
			origin: { gateway: "fake", peer: OWNER, thread: id },
			text: "hi",
			...(agent === undefined ? {} : { agent }),
		});
		expect(await core.receive(harness, message("m0", "nobody"))).toEqual({ refused: "there is no agent named nobody" });
		await allowTools(harness, "reader", ["read"]);
		const got = await core.receive(harness, message("m1", "reader"));
		if (!("turn" in got)) throw new Error(JSON.stringify(got));
		await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
		const agentOf = () =>
			harness.commit(async (tx) => {
				const state = await tx.doc(AgentDoc, got.chat as ConversationId);
				return { tools: [...(state.tools as string[])], model: { ...state.model } };
			}, context);
		expect(await agentOf()).toEqual({ tools: [...EVERY_AGENT, "read"], model: FAUX_MODEL });
		expect((await harness.snapshot(Routes, context))?.chats[got.chat]?.agent).toBe("reader");
		const changed = "---\ndescription: reader, changed\ntier: quick\ntools: [read, bash]\n---\nNew instructions.\n";
		await harness.commit(async (tx) => {
			(await tx.doc(Accepted)).files[agentPath("reader")] = { sha: shaOf(changed), text: changed, at: 1 };
			await core.agentChanged(tx, "reader");
		}, context);
		expect((await agentOf()).tools).toEqual([...EVERY_AGENT, "read", "bash", "propose_send", "ask_hosts"]);
		expect((await harness.snapshot(ChatAgent, got.chat as ConversationId, context))?.agent?.instructions).toBe(
			"New instructions.",
		);
		expect((await harness.snapshot(ChatTier, context))?.chats[got.chat]).toEqual({ tier: "quick", inherited: true });
		const lead = await core.receive(harness, message("m2"));
		if (!("chat" in lead)) throw new Error(JSON.stringify(lead));
		expect((await harness.snapshot(Routes, context))?.chats[lead.chat]?.agent).toBe("sancho");
		await harness.close(context);
	});

	it("keeps a busy run on one accepted definition, then refreshes before the next run", async () => {
		const requests: { prompt: string; tools: string[] }[] = [];
		let release = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const inside = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let held = false;
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const respond = async (request: {
			systemPrompt?: string;
			messages: readonly { role: string }[];
			tools?: readonly { name: string }[];
		}) => {
			requests.push({ prompt: request.systemPrompt ?? "", tools: (request.tools ?? []).map(({ name }) => name) });
			if (request.messages.at(-1)?.role === "user") {
				if (!held) {
					held = true;
					entered();
					await hold;
				}
				return fauxAssistantMessage([fauxToolCall("message_user", { reaction: "👍" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage("done");
		};
		faux.setResponses(Array.from({ length: 20 }, () => respond as never));
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(
			defineExtension({
				name: "test",
				tools: ["t1", "t2"].map((name) =>
					defineTool({ name, description: name, parameters: Type.Object({}), execute: async () => ({ output: [] }) }),
				),
			}),
		);
		const harness = await openStore(await tempHome(), { models, registry });
		await allowTools(harness, "reader", ["t1"]);
		harness.resume();
		const got = await core.receive(harness, {
			id: "m1",
			origin: { gateway: "fake", peer: OWNER, thread: "reader" },
			text: "work",
			agent: "reader",
		});
		if (!("turn" in got)) throw new Error(JSON.stringify(got));
		await inside;
		expect((await harness.snapshot(LiveDoc, got.chat as ConversationId, context))?.run).toBeDefined();
		const changed = "---\ndescription: reader, changed\ntier: quick\ntools: [t2]\n---\nNEW MARKER\n";
		await harness.commit(async (tx) => {
			const tier = (await tx.doc(ChatTier)).chats[got.chat]!;
			tier.tier = "deep";
			delete tier.inherited;
			(await tx.doc(Accepted)).files[agentPath("reader")] = { sha: shaOf(changed), text: changed, at: 1 };
			await core.agentChanged(tx, "reader");
		}, context);
		expect((await harness.snapshot(ChatAgent, got.chat as ConversationId, context))?.agent?.tools).toEqual(["t1"]);
		expect((await harness.snapshot(AgentDoc, got.chat as ConversationId, context))?.tools).toContain("t1");
		release();
		await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
		await until(async () =>
			(await harness.snapshot(ChatAgent, got.chat as ConversationId, context))?.agent?.tools[0] === "t2"
				? true
				: undefined,
		);
		expect((await harness.snapshot(ChatTier, context))?.chats[got.chat]?.tier).toBe("deep");
		expect(requests.every(({ prompt, tools }) => !prompt.includes("NEW MARKER") && !tools.includes("t2"))).toBe(true);
		await harness.close(context);
	});
});
