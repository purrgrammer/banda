import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { skillsExtension } from "../src/core/skills.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { groupView } from "../src/server/routes/groups.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

it("loads an owner's group invocation from accepted bytes for each member, and shows it only after a recorded load", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const seen: { role: string; content?: unknown }[][] = [];
	faux.setResponses(
		Array.from(
			{ length: 8 },
			() =>
				((request: { messages: { role: string; content?: unknown }[] }) => {
					// the load precedes each member's first request, the room's messages; a nudge to answer comes after
					const last = request.messages.at(-1);
					if (last?.role === "user" && JSON.stringify(last.content).includes("Messages added to this group"))
						seen.push(request.messages);
					return fauxAssistantMessage("finished");
				}) as never,
		),
	);
	const registry = createRegistry();
	const gateway = new FakeGateway();
	let harness: Harness;
	const core = defineCore({
		blobs: blobStore(),
		gateway: (name) => (name === gateway.name ? gateway : undefined),
		model: () => FAUX_MODEL,
		registry,
		tools: () =>
			registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool.name),
		writeSkill: async (chat, requestId, entry, ctx) => {
			await (await harness.conversation(chat as ConversationId, ctx))!.submit({ type: "write", requestId, entry }, ctx);
		},
	});
	registry.install(core.extension);
	registry.install(skillsExtension);
	harness = await openStore(await tempHome(), { models, registry });
	try {
		await harness.commit(async (tx) => {
			const accepted = (await tx.doc(Accepted)).files;
			const skill = "---\nname: research\ndescription: Gather sources\n---\n\nCite your sources.";
			accepted["skills/research/SKILL.md"] = { sha: shaOf(skill), text: skill, at: 1 };
			for (const name of ["alice", "bob"]) {
				const text = `---\ndescription: ${name}\n---\nYou are ${name}.`;
				accepted[agentPath(name)] = { sha: shaOf(text), text, at: 1 };
			}
		}, context);
		harness.resume();
		const room = await core.groups.create(harness, { members: ["alice", "bob"] });
		const post = await core.groups.post(harness, {
			room,
			key: "first",
			text: "Use /research together",
			mentions: ["alice", "bob"],
		});
		if ("refused" in post) throw new Error(post.refused);
		await Promise.all(Object.values(post.turns).map((id) => harness.waitForTask(id as TaskId, context)));
		expect(seen).toHaveLength(2);
		for (const messages of seen) {
			expect(messages.map(({ role }) => role)).toEqual(["system", "assistant", "toolResult", "user"]);
			expect(JSON.stringify(messages[2])).toContain("Cite your sources.");
		}
		const view = await groupView(core.groups, harness, room);
		expect(view.messages[0]?.loaded).toEqual(["research"]);
	} finally {
		await harness.close(context);
	}
});
