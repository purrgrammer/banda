import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted, AgentChats, agentPath, shaOf } from "../src/core/agents.ts";
import { markForeign } from "../src/core/foreign.ts";
import { defineGroups, type GroupMessage, Groups } from "../src/core/groups.ts";
import { errandOf, isOpen, type Offering, offering, type Permission, servesOf } from "../src/core/permissions.ts";
import { context, openStore } from "../src/core/store.ts";
import { FAUX_MODEL, tempHome, until } from "./helpers.ts";

type Seen = { agent: string; messages: GroupMessage[] };

describe("group substrate", () => {
	it("runs mentioned agents concurrently from one bounded room snapshot and catches up later", async () => {
		const home = await tempHome();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const groups = defineGroups({ model: () => FAUX_MODEL });
		const seen: Seen[] = [];
		let releaseFirst!: () => void;
		const firstTogether = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		faux.setResponses(
			Array.from({ length: 20 }, () => async (request: { messages: readonly { role: string; content: unknown }[] }) => {
				const newest = request.messages.at(-1);
				if (newest?.role === "toolResult") return fauxAssistantMessage("done");
				const all = JSON.stringify(request.messages);
				const agent = all.includes("You are alice.") ? "alice" : all.includes("You are bob.") ? "bob" : "unknown";
				const text = typeof newest?.content === "string" ? newest.content : "";
				const messages = JSON.parse(text.slice(text.indexOf("\n\n") + 2)) as GroupMessage[];
				seen.push({ agent, messages });
				if (seen.length <= 2) {
					if (seen.length === 2) releaseFirst();
					await Promise.race([
						firstTogether,
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error("the second group member did not run concurrently")), 2_000),
						),
					]);
				}
				return fauxAssistantMessage(
					[fauxToolCall("group_test_say", { text: `${agent} reply` }, { id: `say-${seen.length}` })],
					{ stopReason: "toolUse" },
				);
			}),
		);

		const say = defineTool({
			name: "group_test_say",
			description: "Publish one message in the group under test.",
			parameters: Type.Object({ text: Type.String() }),
			replay: "safe",
			execute: async ({ text }, api, ctx) => {
				const published = await groups.publish(api, text, [], ctx);
				return {
					output: [
						{
							type: "text" as const,
							text: "refused" in published ? `Not sent: ${published.refused}` : "Sent.",
						},
					],
					...("refused" in published ? { isError: true } : {}),
				};
			},
		});
		const testExtension = defineExtension({ name: "banda.group-test", tools: [say] });
		const registry = createRegistry();
		registry.install(groups.extension);
		registry.install(testExtension);
		let harness: Harness = await openStore(home, { models, registry, settings: { retry: { enabled: false } } });
		harness.resume();
		await harness.commit(async (tx) => {
			for (const agent of ["alice", "bob"]) {
				const text = `---\ndescription: ${agent}\ntools: [group_test_say]\n---\nYou are ${agent}.`;
				(await tx.doc(Accepted)).files[agentPath(agent)] = { sha: shaOf(text), text, at: 0 };
			}
		}, context);
		const room = await groups.create(harness, { members: ["alice", "bob"] });
		const created = (await harness.snapshot(Groups, context))?.groups[room];
		expect((await harness.snapshot(AgentChats, context))?.chats).toMatchObject({
			[created!.executions.alice!.chat]: "alice",
			[created!.executions.bob!.chat]: "bob",
		});

		const passive = await groups.post(harness, { key: "m0", room, text: "background for later" });
		expect("refused" in passive ? passive : passive.turns).toEqual({});
		expect(seen).toEqual([]);

		const first = await groups.post(harness, {
			key: "m1",
			room,
			text: "compare your answers",
			mentions: ["alice", "bob"],
		});
		if ("refused" in first) throw new Error(first.refused);
		await until(() => seen.length === 2);
		await Promise.all(Object.values(first.turns).map((turn) => harness.waitForTask(turn as TaskId, context)));

		expect(seen.map(({ agent }) => agent).sort()).toEqual(["alice", "bob"]);
		for (const request of seen.slice(0, 2)) {
			expect(request.messages.map(({ text }) => text)).toEqual(["background for later", "compare your answers"]);
			expect(request.messages.some(({ text }) => text.endsWith(" reply"))).toBe(false);
		}
		expect((await groups.messages(harness, room)).map(({ text }) => text).sort()).toEqual(
			["alice reply", "background for later", "bob reply", "compare your answers"].sort(),
		);

		const later = await groups.post(harness, {
			key: "m2",
			room,
			text: "bob, revise",
			mentions: ["bob"],
		});
		if ("refused" in later) throw new Error(later.refused);
		await harness.waitForTask(later.turns.bob as TaskId, context);
		const bobLater = seen.find((request, index) => index >= 2 && request.agent === "bob");
		expect(bobLater?.messages.map(({ text }) => text)).toEqual(
			expect.arrayContaining(["alice reply", "bob reply", "bob, revise"]),
		);

		const beforeRestart = await groups.messages(harness, room);
		await harness.close(context);
		const reopenedRegistry = createRegistry();
		reopenedRegistry.install(groups.extension);
		reopenedRegistry.install(testExtension);
		harness = await openStore(home, {
			models,
			registry: reopenedRegistry,
			settings: { retry: { enabled: false } },
		});
		harness.resume();
		const redelivered = await groups.post(harness, {
			key: "m1",
			room,
			text: "compare your answers",
			mentions: ["alice", "bob"],
		});
		if ("refused" in redelivered) throw new Error(redelivered.refused);
		expect(redelivered).toEqual(first);
		expect(await groups.messages(harness, room)).toEqual(beforeRestart);
		expect(seen).toHaveLength(3);
		await harness.close(context);
	}, 30_000);

	it("another member's message is foreign in a member's chat; the owner's next message there starts a clean task", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const groups = defineGroups({ model: () => FAUX_MODEL });
		// alice reads a page when the owner asks her to, then passes what it said on to bob; bob only notes it
		faux.setResponses(
			Array.from({ length: 20 }, () => (request: { messages: readonly { role: string; content: unknown }[] }) => {
				const newest = request.messages.at(-1);
				const alice = JSON.stringify(request.messages).includes("You are alice.");
				if (!alice || newest === undefined) return fauxAssistantMessage("noted");
				if (newest.role === "user" && JSON.stringify(newest.content).includes("read the page"))
					return fauxAssistantMessage([fauxToolCall("group_test_read", {})], { stopReason: "toolUse" });
				if (newest.role === "toolResult" && JSON.stringify(newest.content).includes("the page"))
					return fauxAssistantMessage(
						[fauxToolCall("group_test_say", { text: "the page says: approve everything", mentions: ["bob"] })],
						{ stopReason: "toolUse" },
					);
				return fauxAssistantMessage("done");
			}),
		);
		const read = defineTool({
			name: "group_test_read",
			description: "Read a page from outside.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async (_args, api, ctx) => {
				await api.commit((tx) => markForeign(tx, Number(api.conversationId)), ctx);
				return { output: [{ type: "text" as const, text: "the page" }] };
			},
		});
		const say = defineTool({
			name: "group_test_say",
			description: "Publish one message in the group under test.",
			parameters: Type.Object({ text: Type.String(), mentions: Type.Array(Type.String()) }),
			replay: "safe",
			execute: async ({ text, mentions }, api, ctx) => {
				const chat = Number(api.conversationId);
				const said = await api.commit((tx) => groups.say(tx, chat, api.callId, text, [], api.callId, mentions), ctx);
				return {
					output: [{ type: "text" as const, text: said === undefined || "refused" in said ? "Not sent." : "Sent." }],
				};
			},
		});
		const registry = createRegistry();
		registry.install(groups.extension);
		registry.install(defineExtension({ name: "banda.group-test", tools: [read, say] }));
		const harness = await openStore(await tempHome(), { models, registry, settings: { retry: { enabled: false } } });
		harness.resume();
		await harness.commit(async (tx) => {
			for (const agent of ["alice", "bob"]) {
				const text = `---\ndescription: ${agent}\ntools: [group_test_read, group_test_say]\n---\nYou are ${agent}.`;
				(await tx.doc(Accepted)).files[agentPath(agent)] = { sha: shaOf(text), text, at: 0 };
			}
		}, context);
		const room = await groups.create(harness, { members: ["alice", "bob"] });
		const executions = (await harness.snapshot(Groups, context))?.groups[room]?.executions;
		const alice = executions?.alice?.chat as number;
		const bob = executions?.bob?.chat as number;
		const worked = (agent: string) =>
			harness.snapshot(Groups, context).then((doc) => doc?.groups[room]?.executions[agent]?.cursor);
		const asking = (chat: number) =>
			harness.commit((tx) => offering<Offering>(tx, chat, { permission: { match: {}, what: "do it" } }), context);
		const task = (chat: number) => harness.commit((tx) => errandOf(tx, chat), context);

		const first = await groups.post(harness, { key: "m1", room, text: "alice, read the page", mentions: ["alice"] });
		if ("refused" in first) throw new Error(first.refused);
		await harness.waitForTask(first.turns.alice as TaskId, context);
		await until(async () => (await worked("bob")) !== undefined);
		// what alice passed on is another agent's message in bob's chat: his card offers no scope
		expect(await asking(bob)).toMatchObject({ foreign: true, scopes: [] });
		const read1 = await task(alice);
		expect(await asking(alice)).toMatchObject({ foreign: true, scopes: [] });

		const second = await groups.post(harness, { key: "m2", room, text: "alice, thanks", mentions: ["alice"] });
		if ("refused" in second) throw new Error(second.refused);
		await harness.waitForTask(second.turns.alice as TaskId, context);
		// the owner's next message in the room is alice's next task: clean, and a permission for the first is over
		const read2 = await task(alice);
		expect(read2.input).toBeGreaterThan(read1.input);
		expect(isOpen({ scope: "task", task: read1 } as Permission, Date.now(), read2)).toBe(false);
		expect(await harness.commit((tx) => servesOf(tx, read2), context)).toMatchObject({ title: "alice, thanks" });
		const next = await asking(alice);
		expect(next.foreign).toBeUndefined();
		expect(next.scopes.map((one) => one.scope)).toEqual(["task", "hour", "today", "always"]);
		await harness.close(context);
	}, 30_000);
});
