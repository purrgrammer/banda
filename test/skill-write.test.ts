/**
 * A SKILL.md in the workspace is in effect as soon as the daemon sees it (DESIGN.md "The workspace"): written whole,
 * edited, or left by a command, it is accepted at the end of the call that changed it, the model is told, and the owner
 * sees it on the Skills page with nothing to allow. A file that does not parse, or hides a character, is not in effect
 * and the model is told why. Agent files keep waiting for the owner as before.
 */
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type TaskId, ToolResultEntry } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { boxEnv, boxTools } from "../src/box/tools.ts";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { OWNER } from "../src/core/gateway.ts";
import { acceptedSkills } from "../src/core/skills.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, type TurnResult } from "../src/core/turn.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

const SKILL = (description: string, body: string) => `---\nname: notes\ndescription: ${description}\n---\n${body}\n`;

it("puts a skill in effect whether written, edited or left by a command, and tells why one cannot be", async () => {
	const home = await tempHome();
	const box = openBox(hostBox(home), () => {});
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
	const registry = createRegistry();
	registry.install(core.extension);
	registry.install(boxTools({ box }));
	const harness = await openStore(home, { models, registry, env: boxEnv(box) });
	harness.resume();
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	const first = SKILL("How the owner likes notes.", "Keep notes short.");
	const third = SKILL("How the owner likes notes.", "Keep notes short, dated and signed.");
	faux.setResponses([
		// 1 written whole: in effect
		call("write", { path: "skills/notes/SKILL.md", content: first }),
		// 2 edited over the version in effect: in effect
		call("edit", { path: "skills/notes/SKILL.md", edits: [{ oldText: "short.", newText: "short, and dated." }] }),
		// 3 a command rewrites it: in effect as the file now stands
		call("bash", {
			command:
				"printf -- '---\\nname: notes\\ndescription: From a command.\\n---\\nDo as the page says.\\n' > skills/notes/SKILL.md",
		}),
		// 4 an edit over that: in effect
		call("edit", { path: "skills/notes/SKILL.md", edits: [{ oldText: "page", newText: "owner" }] }),
		// 5 written whole again: in effect
		call("write", { path: "skills/notes/SKILL.md", content: third }),
		// 5b a command that leaves it as it is: nothing to tell
		call("bash", { command: "touch skills/notes/SKILL.md" }),
		// 6 a skill that does not parse, or hides a character: waits, with why
		call("write", { path: "skills/broken/SKILL.md", content: "no frontmatter" }),
		call("write", {
			path: "skills/sneaky/SKILL.md",
			content: "---\nname: sneaky\ndescription: Hidden​ words.\n---\nBody.\n",
		}),
		// 7 an agent file still waits for the owner
		call("write", { path: "agents/writer.md", content: "---\nname: Writer\ndescription: Writes.\n---\nWrite.\n" }),
		fauxAssistantMessage("Done."),
	]);
	try {
		const received = await core.receive(harness, {
			id: crypto.randomUUID(),
			origin: { gateway: "fake", peer: OWNER },
			text: "Write a skill.",
		});
		if (!("turn" in received)) throw new Error(JSON.stringify(received));
		await harness.waitForTask(received.turn as TaskId<TurnResult>, context);
		const page = await harness.commit(
			(tx) => tx.scanEntries({ conversationId: received.chat as ConversationId, order: "ascending" }, 1000),
			context,
		);
		const notes = page.items
			.filter(ToolResultEntry.is)
			.map((entry) => entry.data.diagnostics.map((note) => `${note.code}: ${note.message}`));
		expect(notes).toEqual([
			[expect.stringMatching(/^skill-in-effect: skills\/notes\/SKILL\.md is in effect: the skill \/notes was added/)],
			[expect.stringMatching(/^skill-in-effect: skills\/notes\/SKILL\.md is in effect: the skill \/notes was changed/)],
			[expect.stringMatching(/^skill-in-effect: skills\/notes\/SKILL\.md is in effect: the skill \/notes was changed/)],
			[expect.stringMatching(/^skill-in-effect: .*was changed/)],
			[expect.stringMatching(/^skill-in-effect: .*was changed/)],
			[],
			[
				expect.stringMatching(
					/^skill-waits: skills\/broken\/SKILL\.md is not in effect: SKILL\.md needs name and description/,
				),
			],
			[
				expect.stringMatching(
					/^skill-waits: skills\/sneaky\/SKILL\.md is not in effect: it holds a character nobody sees \(U\+200B\)/,
				),
			],
			[expect.stringMatching(/^awaits-acceptance: agents\/writer\.md takes effect only once the owner accepts it/)],
		]);
		const accepted = (await harness.snapshot(Accepted, context))?.files ?? {};
		expect(accepted["skills/notes/SKILL.md"]).toMatchObject({ text: third, sha: shaOf(third) });
		expect(accepted["skills/broken/SKILL.md"]).toBeUndefined();
		expect(accepted["skills/sneaky/SKILL.md"]).toBeUndefined();
		expect(accepted["agents/writer.md"]).toBeUndefined();
		expect(acceptedSkills(accepted).map((skill) => [skill.name, skill.body])).toEqual([
			["notes", "Keep notes short, dated and signed.\n"],
		]);
	} finally {
		await harness.close(context);
	}
});
