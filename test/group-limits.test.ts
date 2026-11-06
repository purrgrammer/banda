/**
 * Groups as the owner shapes them (DESIGN.md "Groups"): one may start with nobody in it and lose its last member; the
 * owner's limits in Settings bound how many agents one holds and how far agents ask each other; an archived group takes
 * no message, runs nothing and changes not, until restored.
 */
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { defineGroups, GROUP_LIMITS, Groups, UNNAMED_GROUP } from "../src/core/groups.ts";
import { context, openStore } from "../src/core/store.ts";
import { FAUX_MODEL, tempHome } from "./helpers.ts";

const AGENTS = ["alice", "bob", "cy"];

async function open(options: { resume?: boolean } = {}) {
	const home = await tempHome();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const groups = defineGroups({ model: () => FAUX_MODEL });
	const registry = createRegistry();
	registry.install(groups.extension);
	const harness: Harness = await openStore(home, { models, registry, settings: { retry: { enabled: false } } });
	if (options.resume) harness.resume();
	await harness.commit(async (tx) => {
		for (const agent of AGENTS) {
			const text = `---\ndescription: ${agent}\n---\nYou are ${agent}.`;
			(await tx.doc(Accepted)).files[agentPath(agent)] = { sha: shaOf(text), text, at: 0 };
		}
	}, context);
	return { harness, groups, faux };
}

const executionOf = async (harness: Harness, room: number, agent: string) => {
	const chat = (await harness.snapshot(Groups, context))?.groups[room]?.executions[agent]?.chat;
	if (chat === undefined) throw new Error(`${agent} has no chat in ${room}`);
	return chat;
};

describe("group membership and limits", () => {
	it("starts a group with nobody in it, posts there asking nobody, and lets its last member go", async () => {
		const { harness, groups } = await open();
		const empty = await groups.create(harness, { members: [] });
		const [row] = await groups.rooms(harness);
		expect(row).toMatchObject({ room: empty, name: UNNAMED_GROUP, members: [] });
		const posted = await groups.post(harness, { room: empty, key: "k1", text: "notes for later" });
		expect("refused" in posted ? posted : posted.turns).toEqual({});

		await groups.change(harness, empty, { add: ["alice"] });
		await groups.change(harness, empty, { remove: ["alice"] });
		expect((await groups.rooms(harness))[0]?.members).toEqual([]);
		await harness.close(context);
	});

	it("bounds a group's members by the owner's limit, keeping a group already past a lowered one", async () => {
		const { harness, groups } = await open();
		expect(await groups.limits(harness)).toEqual(GROUP_LIMITS);
		await expect(groups.setLimits(harness, { members: 0 })).rejects.toThrow(/members is a whole number from 1/);
		await expect(groups.setLimits(harness, { depth: 2.5 })).rejects.toThrow(/depth/);
		expect(await groups.setLimits(harness, { members: 2 })).toEqual({ ...GROUP_LIMITS, members: 2 });

		await expect(groups.create(harness, { members: AGENTS })).rejects.toThrow("a group holds 2 agents at most");
		const room = await groups.create(harness, { members: ["alice", "bob"] });
		await expect(groups.change(harness, room, { add: ["cy"] })).rejects.toThrow("a group holds 2 agents at most");

		// lowered below what a group holds: it keeps them, may lose one, and takes no more
		await groups.setLimits(harness, { members: 1 });
		await groups.change(harness, room, { name: "Pair" });
		expect((await groups.rooms(harness))[0]?.members).toEqual(["alice", "bob"]);
		await groups.change(harness, room, { remove: ["bob"] });
		await expect(groups.change(harness, room, { add: ["bob"] })).rejects.toThrow("a group holds 1 agents at most");
		await harness.close(context);
	});

	it("bounds how deep and how many turns agents ask each other by the owner's limits", async () => {
		const { harness, groups } = await open();
		const room = await groups.create(harness, { members: AGENTS });
		// the owner asks alice; her turn is queued (the store is not resumed), so what she says answers it at depth 1
		const asked = await groups.post(harness, { room, key: "o1", text: "alice?", mentions: ["alice"] });
		if ("refused" in asked) throw new Error(asked.refused);
		const alice = await executionOf(harness, room, "alice");
		const say = (key: string, ask: string[]) =>
			harness.commit((tx) => groups.say(tx, alice, key, "over to you", [], undefined, ask), context);

		await groups.setLimits(harness, { depth: 1 });
		expect(await say("a1", ["bob"])).toMatchObject({
			note: expect.stringMatching(/^nobody was asked: agents have asked each other 1 deep/),
		});
		await groups.setLimits(harness, { depth: 2, chain: 1 });
		expect(await say("a2", ["bob", "cy"])).toMatchObject({
			note: expect.stringMatching(/^nobody was asked: agents' mentions started 1 turns/),
		});
		const one = await say("a3", ["bob"]);
		expect(one).not.toHaveProperty("note");
		await harness.close(context);
	});
});

describe("archiving a group", () => {
	it("refuses posts and changes while archived, ends its queued turns unrun, and goes on once restored", async () => {
		const { harness, groups, faux } = await open();
		let calls = 0;
		faux.setResponses(
			Array.from({ length: 4 }, () => () => {
				calls++;
				return fauxAssistantMessage("noted");
			}),
		);
		const room = await groups.create(harness, { members: ["alice", "bob"] });
		const queued = await groups.post(harness, { room, key: "k1", text: "alice?", mentions: ["alice"] });
		if ("refused" in queued) throw new Error(queued.refused);

		expect(await groups.archive(harness, room, true)).toBe(true);
		expect(await groups.archive(harness, 999_999, true)).toBe(false);
		harness.resume();
		await harness.waitForTask(queued.turns.alice as TaskId, context);
		expect(calls).toBe(0);

		expect((await groups.rooms(harness))[0]?.archived).toEqual(expect.any(Number));
		expect(await groups.post(harness, { room, key: "k2", text: "still there?" })).toEqual({
			refused: "this group is archived: restore it from Settings to post",
		});
		await expect(groups.change(harness, room, { add: ["cy"] })).rejects.toThrow(/archived/);
		const bob = await executionOf(harness, room, "bob");
		expect(await harness.commit((tx) => groups.say(tx, bob, "b1", "from inside", [], undefined, []), context)).toEqual({
			refused: "this group is archived: restore it from Settings to post",
		});
		// a start after a crash stops it again, and finds nothing left
		await groups.stopArchived(harness);

		expect(await groups.archive(harness, room, false)).toBe(true);
		expect((await groups.rooms(harness))[0]).not.toHaveProperty("archived");
		const back = await groups.post(harness, { room, key: "k3", text: "back" });
		expect(back).not.toHaveProperty("refused");
		const notices = (await groups.log(harness, room)).flatMap((line) => ("notice" in line ? [line.notice] : []));
		expect(notices).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ archived: true }),
				expect.objectContaining({ restored: true }),
			]),
		);
		await harness.close(context);
	});
});
