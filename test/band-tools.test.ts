/**
 * The band's own tools act at once (DESIGN.md "Agents", #58): `create_agent`, `update_agent` and `create_group` take
 * effect in the call's own commit, the chat gets a receipt to draw, and nothing waits on the owner. What is the owner's
 * stays out of reach by construction: a new agent has no tools list, model or tier; a peer's instructions are not
 * another agent's to rewrite; a group chat has none of these tools; and a call run again after a cut answers as it did.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type TaskId, ToolResultEntry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted, AgentChats, agentPath, parseAgent } from "../src/core/agents.ts";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import { BandCalls, readBandReceipt } from "../src/core/band-tools.ts";
import { OWNER } from "../src/core/gateway.ts";
import { Groups } from "../src/core/groups.ts";
import { Permissions } from "../src/core/permissions.ts";
import { context, openStore } from "../src/core/store.ts";
import { type CoreOptions, defineCore, type TurnResult } from "../src/core/turn.ts";
import { agentWorkingBase, finishAgentPublication, queueAgentPublication } from "../src/server/agent-publication.ts";
import type { Workspace } from "../src/server/agents.ts";
import { receiptOf } from "../src/server/transcript.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

/** A call: its tool, its arguments and, to stand for the same call run again, its id. */
type Call = readonly [string, object] | readonly [string, object, string];

/** A core on the faux provider: each owner message is answered with the calls `plan` gives for its words. */
async function start(
	plan: (said: string) => readonly Call[],
	band?: CoreOptions["band"],
	knownModel?: CoreOptions["knownModel"],
) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const asked = (request: ModelContext) => {
		const last = request.messages.at(-1);
		return last?.role === "user" && typeof last.content === "string" ? last.content : "";
	};
	const respond = (request: ModelContext) => {
		const calls = plan(asked(request));
		return calls.length === 0
			? fauxAssistantMessage("done")
			: fauxAssistantMessage(
					calls.map(([name, args, id]) =>
						fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1], id === undefined ? {} : { id }),
					),
					{ stopReason: "toolUse" },
				);
	};
	faux.setResponses(Array.from({ length: 20 }, () => respond as never));
	const registry = createRegistry();
	const gateway = new FakeGateway();
	const core = defineCore({
		blobs: blobStore(),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		registry,
		...(band === undefined ? {} : { band }),
		...(knownModel === undefined ? {} : { knownModel }),
	});
	registry.install(core.extension);
	const home = await tempHome();
	const harness = await openStore(home, { models, registry });
	harness.resume();
	const say = async (text: string, agent = "sancho") => {
		const started = await core.receive(harness, {
			id: `owner-${Math.random()}`,
			origin: { gateway: "fake", peer: OWNER, thread: agent },
			text,
			agent,
		});
		if (!("turn" in started)) throw new Error(JSON.stringify(started));
		await harness.waitForTask(started.turn as TaskId<TurnResult>, context);
		return started.chat;
	};
	const results = async (chat: number) =>
		(
			await harness.commit(
				(tx) => tx.scanEntries({ conversationId: chat as ConversationId, order: "ascending" }, 200),
				context,
			)
		).items
			.filter(ToolResultEntry.is)
			.map((entry) => entry.model?.[0] as ToolResultMessage)
			.map((result) => ({
				name: result.toolName,
				text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
				error: result.isError,
				receipt: receiptOf(result.toolName, result.isError, result.details),
			}));
	return { core, harness, home, gateway, say, results };
}

const FACE = { ...JSON.parse(JSON.stringify(defaultAvatarFace())), color: "#336699" };

describe("create_agent", () => {
	it("makes an active agent in the call, with its model and tier and no tools, and the chat gets a receipt to draw", async () => {
		const { harness, say, results } = await start((said) =>
			said === "Hire a writer."
				? [
						[
							"create_agent",
							{
								id: "writer",
								name: "Writer",
								description: "Writes drafts",
								instructions: "Write clearly.",
								model: { provider: "faux", modelId: "faux-1" },
								tier: "deep",
								// never an argument: what an agent may reach is the owner's to give
								tools: ["bash"],
							},
						],
						["message_user", { text: "Writer is in the band." }],
					]
				: [],
		);
		try {
			const chat = await say("Hire a writer.");
			const file = (await harness.snapshot(Accepted, context))?.files[agentPath("writer")];
			expect(file).toBeDefined();
			const parsed = parseAgent("writer", file?.text ?? "");
			if (!("agent" in parsed)) throw new Error(parsed.errors.join("; "));
			expect(parsed.agent).toMatchObject({
				id: "writer",
				name: "Writer",
				state: "active",
				tools: [],
				model: { provider: "faux", modelId: "faux-1" },
				tier: "deep",
			});
			expect(file?.text).not.toContain("bash");
			const [made] = await results(chat);
			expect(made).toMatchObject({ name: "create_agent", error: false });
			expect(made?.text).toContain('Created the agent "Writer" (writer)');
			expect(made?.receipt).toEqual({
				kind: "agent",
				change: "created",
				id: "writer",
				agent: {
					name: "Writer",
					face: parsed.agent.face,
					description: "Writes drafts",
					instructions: "Write clearly.",
					model: { provider: "faux", modelId: "faux-1" },
					tier: "deep",
				},
			});
			// the new agent's chat starts from the file
			const second = await say("Hello.", "writer");
			expect(second).not.toBe(chat);
		} finally {
			await harness.close(context);
		}
	});

	it("refuses a model this daemon does not have, and a malformed one, and makes nothing", async () => {
		const { harness, say, results } = await start(
			(said) =>
				said === "Hire."
					? [
							[
								"create_agent",
								{ id: "a", name: "A", description: "A", instructions: "A.", model: { provider: "nope", modelId: "x" } },
							],
							[
								"create_agent",
								{ id: "b", name: "B", description: "B", instructions: "B.", model: { provider: "a/b", modelId: "x" } },
							],
							[
								"create_agent",
								{
									id: "c",
									name: "C",
									description: "C",
									instructions: "C.",
									model: { provider: "faux", modelId: "faux-1" },
								},
							],
						]
					: [],
			undefined,
			(model) => model.provider === "faux",
		);
		try {
			const chat = await say("Hire.");
			const [unknown, malformed, fine] = await results(chat);
			expect(unknown?.error).toBe(true);
			expect(unknown?.text).toMatch(/^Not created: .*nope\/x/);
			expect(malformed).toMatchObject({
				error: true,
				text: "Not created: the model needs a provider and a model id on one line each.",
			});
			expect(fine?.error).toBe(false);
			const files = (await harness.snapshot(Accepted, context))?.files ?? {};
			expect(Object.keys(files).sort()).toEqual([agentPath("c"), agentPath("sancho")]);
		} finally {
			await harness.close(context);
		}
	});

	it("refuses a taken id, a bad id, and a call from a group's chat, and does nothing", async () => {
		const { harness, say, results, core } = await start((said) =>
			said === "Again."
				? [
						["create_agent", { id: "sancho", name: "Other", description: "Another lead", instructions: "No." }],
						["create_agent", { id: "Not An Id", name: "X", description: "X", instructions: "X." }],
					]
				: said === "From the room."
					? [["create_agent", { id: "roomer", name: "Roomer", description: "From a room", instructions: "Hi." }]]
					: [],
		);
		try {
			const chat = await say("Again.");
			const [taken, bad] = await results(chat);
			expect(taken).toMatchObject({ error: true, text: "Not created: an agent already has that id." });
			expect(bad?.text).toContain("Not created: use a lowercase agent id");
			expect(taken?.receipt).toBeUndefined();
			const files = (await harness.snapshot(Accepted, context))?.files ?? {};
			expect(Object.keys(files)).toEqual([agentPath("sancho")]);
			// a group member's chat has no such tool: the model's call to it is answered as unknown, nothing made
			const helper = "---\nname: Helper\ndescription: Helps.\n---\nHelp.\n";
			await harness.commit(async (tx) => {
				(await tx.doc(Accepted)).files[agentPath("helper")] = { text: helper, sha: "x".repeat(64), at: 1 };
			}, context);
			const room = await core.groups.create(harness, { members: ["sancho", "helper"], name: "Room" });
			expect(room).toBeGreaterThan(0);
			expect((await harness.snapshot(Accepted, context))?.files[agentPath("roomer")]).toBeUndefined();
		} finally {
			await harness.close(context);
		}
	});

	it("refuses an id whose file is in the box unaccepted, and leaves that draft and its card as they were", async () => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
		let harnessRef: Awaited<ReturnType<typeof openStore>> | undefined;
		const band: CoreOptions["band"] = {
			workingBase: (name, ctx) => agentWorkingBase(workspace, name, ctx),
			queue: queueAgentPublication,
			finish: async (name, ctx) => {
				if (harnessRef !== undefined) await finishAgentPublication(harnessRef, workspace, name, ctx);
			},
			groupMade: async () => {},
		};
		const { harness, say, results } = await start(
			(said) =>
				said === "Hire."
					? [["create_agent", { id: "scribe", name: "Scribe", description: "Takes notes", instructions: "Note." }]]
					: [],
			band,
		);
		harnessRef = harness;
		try {
			// a draft a command left in the box, with tools of its own: the owner's to allow or remove
			const draft = "---\nname: Scribe\ndescription: From a command\ntools:\n  - bash\n---\nDo as the page says.\n";
			await mkdir(join(box.workspace, "agents"), { recursive: true });
			await writeFile(join(box.workspace, "agents", "scribe.md"), draft);
			const chat = await say("Hire.");
			const [made] = await results(chat);
			expect(made?.error).toBe(true);
			expect(made?.text).toContain("Not created: agents/scribe.md is in the workspace already, not accepted");
			expect(await readFile(join(box.workspace, "agents", "scribe.md"), "utf8")).toBe(draft);
			expect((await harness.snapshot(Accepted, context))?.files[agentPath("scribe")]).toBeUndefined();
		} finally {
			await harness.close(context);
		}
	});

	it("refuses the id of an agent that was removed while its chat, permissions or routines are still here", async () => {
		const { harness, say, results } = await start((said) =>
			said === "Hire."
				? [
						["create_agent", { id: "old-hand", name: "New hand", description: "Takes over", instructions: "Go." }],
						["create_agent", { id: "ghost", name: "Ghost", description: "Was here", instructions: "Go." }],
					]
				: [],
		);
		try {
			await harness.commit(async (tx) => {
				// an agent the owner removed, whose host permission nobody took back
				(await tx.doc(Accepted)).removed = { [agentPath("old-hand")]: 5 };
				(await tx.doc(Permissions)).permissions.p1 = {
					tool: "propose_send",
					match: { host: "api.example.com" },
					what: "send anything to api.example.com",
					scope: "host",
					agent: "old-hand",
					at: 1,
					wait: 1,
				};
				// an id whose chat is still routed, with no removal recorded
				(await tx.doc(AgentChats)).chats["77"] = "ghost";
			}, context);
			const chat = await say("Hire.");
			const [taken, haunted] = await results(chat);
			expect(taken?.error).toBe(true);
			expect(taken?.text).toContain(
				"Not created: that id belonged to an agent that was removed, and its removal, its permissions are still here",
			);
			expect(haunted?.text).toContain("and its chat is still here");
			const files = (await harness.snapshot(Accepted, context))?.files ?? {};
			expect(files[agentPath("old-hand")]).toBeUndefined();
			expect(files[agentPath("ghost")]).toBeUndefined();
			expect((await harness.snapshot(Permissions, context))?.permissions.p1).toMatchObject({ agent: "old-hand" });
		} finally {
			await harness.close(context);
		}
	});

	it("answers the same call run again with the receipt it has, never refusing its own agent", async () => {
		const hire: Call = [
			"create_agent",
			{ id: "scribe", name: "Scribe", description: "Takes notes", instructions: "Note." },
			"call-run-twice",
		];
		const { harness, say, results } = await start((said) => (said === "Hire." || said === "Again." ? [hire] : []));
		try {
			const chat = await say("Hire.");
			await say("Again.");
			const made = (await results(chat)).filter((result) => result.name === "create_agent");
			expect(made).toHaveLength(2);
			expect(made[1]).toMatchObject({ error: false, text: made[0]?.text });
			expect(made[1]?.receipt).toEqual(made[0]?.receipt);
			expect(made[0]?.receipt).toMatchObject({ kind: "agent", change: "created", id: "scribe" });
			expect(Object.keys((await harness.snapshot(BandCalls, context))?.calls ?? {})).toHaveLength(1);
		} finally {
			await harness.close(context);
		}
	});

	it("answers a call run again with what it did, and writes the accepted file to the box", async () => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
		let harnessRef: Awaited<ReturnType<typeof openStore>> | undefined;
		const band: CoreOptions["band"] = {
			workingBase: (name, ctx) => agentWorkingBase(workspace, name, ctx),
			queue: queueAgentPublication,
			finish: async (name, ctx) => {
				if (harnessRef !== undefined) await finishAgentPublication(harnessRef, workspace, name, ctx);
			},
			groupMade: async () => {},
		};
		const { harness, say, results } = await start(
			(said) =>
				said === "Hire."
					? [["create_agent", { id: "scribe", name: "Scribe", description: "Takes notes", instructions: "Note." }]]
					: [],
			band,
		);
		harnessRef = harness;
		try {
			const chat = await say("Hire.");
			const written = await readFile(join(box.workspace, "agents", "scribe.md"), "utf8");
			expect(written).toContain("name: Scribe");
			const [made] = await results(chat);
			expect(made?.error).toBe(false);
			// the same call again (a cut after its commit): the receipt it has, not a refusal of its own agent
			const calls = (await harness.snapshot(BandCalls, context))?.calls ?? {};
			expect(Object.keys(calls)).toHaveLength(1);
			expect(readBandReceipt(Object.values(calls)[0])).toMatchObject({
				kind: "agent",
				change: "created",
				id: "scribe",
			});
		} finally {
			await harness.close(context);
		}
	});
});

describe("update_agent", () => {
	it("changes its own words, face, model and tier at once, keeping tools and permissions, and says what was", async () => {
		const { harness, say, results } = await start((said) =>
			said === "Rename yourself."
				? [
						[
							"update_agent",
							{
								name: "Don Sancho",
								description: "The lead, renamed",
								instructions: "New words.",
								face: FACE,
								model: { provider: "faux", modelId: "faux-1" },
								tier: null,
								// never an argument: the schema has no such field
								tools: [],
							},
						],
					]
				: [],
		);
		try {
			// a tier and a tools list the owner gave, and a host permission they allowed
			const pinned = "---\nname: Pen\ndescription: Pen agent\ntier: deep\ntools:\n  - read\n---\nYou are Pen.\n";
			await harness.commit(async (tx) => {
				(await tx.doc(Accepted)).files[agentPath("pen")] = { text: pinned, sha: "p".repeat(64), at: 1 };
				(await tx.doc(Permissions)).permissions.pen1 = {
					tool: "propose_send",
					match: { host: "api.example.com" },
					what: "send anything to api.example.com",
					scope: "host",
					agent: "pen",
					at: 1,
					wait: 1,
				};
			}, context);
			const chat = await say("Rename yourself.", "pen");
			const [changed] = await results(chat);
			expect(changed).toMatchObject({ error: false, text: expect.stringContaining("Updated") });
			const file = (await harness.snapshot(Accepted, context))?.files[agentPath("pen")];
			const parsed = parseAgent("pen", file?.text ?? "");
			if (!("agent" in parsed)) throw new Error(parsed.errors.join("; "));
			expect(parsed.agent).toMatchObject({
				name: "Don Sancho",
				description: "The lead, renamed",
				instructions: "New words.",
				model: { provider: "faux", modelId: "faux-1" },
				tools: ["read"],
			});
			expect(parsed.agent.tier).toBeUndefined();
			expect(parsed.agent.face.color).toBe("#336699");
			// what the owner gave stays: the permission as it was, the tools list untouched
			expect((await harness.snapshot(Permissions, context))?.permissions.pen1).toMatchObject({
				agent: "pen",
				scope: "host",
			});
			expect(changed?.text).toContain(
				'Updated "Don Sancho" (pen): name, face, description, instructions, model, tier.',
			);
			expect(changed?.receipt).toMatchObject({
				kind: "agent",
				change: "updated",
				id: "pen",
				agent: {
					name: "Don Sancho",
					description: "The lead, renamed",
					instructions: "New words.",
					model: { provider: "faux", modelId: "faux-1" },
				},
				before: { name: "Pen", description: "Pen agent", instructions: "You are Pen.", tier: "deep", model: null },
			});
			expect(changed?.receipt).toHaveProperty("before.face");
		} finally {
			await harness.close(context);
		}
	});

	it("changes a peer's instructions, name and description, keeping its connections, and refuses a change that changes nothing", async () => {
		const { harness, say, results } = await start((said) =>
			said === "Fix the helper."
				? [
						["update_agent", { agent: "helper", instructions: "Help the owner, briefly." }],
						["update_agent", { agent: "helper", name: "Helper", description: "Helps." }],
						["update_agent", { agent: "helper", name: "Aide", description: "Helps out." }],
						["update_agent", { agent: "nobody", name: "X" }],
					]
				: [],
		);
		try {
			const helper = "---\nname: Helper\ndescription: Helps.\nconnections:\n  - github\n---\nHelp the owner.\n";
			await harness.commit(async (tx) => {
				(await tx.doc(Accepted)).files[agentPath("helper")] = { text: helper, sha: "h".repeat(64), at: 1 };
			}, context);
			const chat = await say("Fix the helper.");
			const [peer, same, renamed, missing] = await results(chat);
			expect(peer?.error).toBe(false);
			expect(peer?.receipt).toMatchObject({
				change: "updated",
				id: "helper",
				before: { instructions: "Help the owner." },
			});
			expect(same).toMatchObject({ error: true, text: "Not updated: nothing would change." });
			expect(renamed?.error).toBe(false);
			expect(missing).toMatchObject({ error: true, text: "Not updated: the target is not an active agent." });
			const file = (await harness.snapshot(Accepted, context))?.files[agentPath("helper")];
			const parsed = parseAgent("helper", file?.text ?? "");
			if (!("agent" in parsed)) throw new Error(parsed.errors.join("; "));
			expect(parsed.agent).toMatchObject({
				name: "Aide",
				description: "Helps out.",
				instructions: "Help the owner, briefly.",
			});
			// its connection, the owner's grant, is as it was
			expect(parsed.agent.connections).toEqual(["github"]);
		} finally {
			await harness.close(context);
		}
	});
});

describe("create_group", () => {
	it("makes the group in the call and names its room and members in the receipt; a bad member refuses", async () => {
		const { harness, say, results } = await start((said) =>
			said === "Team up."
				? [
						["create_group", { name: "  Research   team ", members: ["sancho", "reader", "sancho"] }],
						["create_group", { name: "Ghosts", members: ["sancho", "ghost"] }],
					]
				: [],
		);
		try {
			const reader = "---\nname: Reader\ndescription: Reads.\n---\nRead.\n";
			await harness.commit(async (tx) => {
				(await tx.doc(Accepted)).files[agentPath("reader")] = { text: reader, sha: "r".repeat(64), at: 1 };
			}, context);
			const chat = await say("Team up.");
			const [made, ghost] = await results(chat);
			expect(made?.error).toBe(false);
			expect(made?.text).toContain('Created the group "Research team" with Sancho, Reader.');
			const groups = await harness.snapshot(Groups, context);
			const rooms = Object.keys(groups?.groups ?? {});
			expect(rooms).toHaveLength(1);
			expect(made?.receipt).toEqual({
				kind: "group",
				room: Number(rooms[0]),
				name: "Research team",
				members: [
					{ id: "sancho", name: "Sancho" },
					{ id: "reader", name: "Reader" },
				],
			});
			expect(ghost).toMatchObject({ error: true, text: "Not created: ghost is not an active agent." });
		} finally {
			await harness.close(context);
		}
	});
});
