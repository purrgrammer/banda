/**
 * The roster (DESIGN.md "Agents"): a direct agent chat's prompt names the band's other active agents by the id
 * `message_agent` and `read_agent_chat` take, with the name the owner calls each and its description, and nothing else of
 * their files. It follows the accepted files: an agent made, renamed or archived changes the words; a group member's
 * chat has its group instead.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, type Harness } from "@earendil-works/pi-durable";
import { afterAll, describe, expect, it } from "vitest";
import { type Box, openBox } from "../src/box/box.ts";
import { BOX_TOOLS, boxEnv, boxTools } from "../src/box/tools.ts";
import { Accepted, AgentChats, agentPath, LEAD, LEAD_TEXT } from "../src/core/agents.ts";
import { stopArchived } from "../src/core/archive.ts";
import { DEFAULT_NAME } from "../src/core/choices.ts";
import { Groups } from "../src/core/groups.ts";
import { ROSTER_DESCRIPTION, rosterSection, rosterText } from "../src/core/roster.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { save, type Workspace } from "../src/server/agents.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

const boxes: Box[] = [];
afterAll(() => {
	for (const box of boxes) box.close();
});

const SECRET = "SECRET INSTRUCTIONS";
const MARA =
	'---\nname: "Mara"\ndescription: Plans trips\nmodel: faux/faux-1\ntools: [bash]\nconnections: [github]\n---\n' +
	`${SECRET}\n`;
const archived = (text: string) => text.replace("---\n", "---\nstate: archived\n");

const LEAD_CHAT = 7;
const MARA_CHAT = 8;

async function open() {
	const home = await tempHome();
	const box = openBox(hostBox(home), () => {});
	boxes.push(box);
	const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
	const registry = createRegistry();
	registry.install(core.extension);
	registry.install(boxTools({ workspace: box.workspace }));
	const harness = await openStore(home, { models: echoModels().models, registry, env: boxEnv(box) });
	harness.resume();
	const workspace: Workspace = {
		env: () => box.env(),
		root: box.workspace,
		tools: () => [...BOX_TOOLS],
		known: () => true,
	};
	await mkdir(join(box.workspace, "agents"), { recursive: true });
	await writeFile(join(box.workspace, "agents", `${LEAD}.md`), LEAD_TEXT);
	/** The owner saves agent `name`'s file as `text`; then what the daemon does after. */
	const write = async (name: string, text: string) => {
		const base = await harness.commit(
			async (tx) => (await tx.doc(Accepted)).files[agentPath(name)]?.sha ?? null,
			context,
		);
		await save(harness, workspace, name, text, base, core.agentChanged);
		await stopArchived(harness);
		await core.reconcile(harness);
	};
	return { harness, write };
}

/** The section in chat `chat`, over the store's committed documents; the two chats are the lead's and Mara's. */
const roster = (harness: Harness, chat: number) => {
	const chats = { [LEAD_CHAT]: LEAD, [MARA_CHAT]: "mara" };
	const read = {
		snapshot: (token: unknown, ctx: typeof context) =>
			token === AgentChats ? { chats } : harness.snapshot(token as typeof Accepted, ctx),
	};
	const input = { conversationId: String(chat), read };
	return rosterSection.render(input as unknown as Parameters<typeof rosterSection.render>[0], context);
};

describe("the roster", () => {
	it("lists the others by id, name and description, sorted, never the agent itself", () => {
		const text = rosterText("writer", [
			{ id: "writer", name: "The Writer", description: "Writes" },
			{ id: "reader", name: "Reader", description: "Reads" },
			{ id: LEAD, name: "Sancho", description: "The lead" },
		]);
		expect(text.split("\n").slice(1)).toEqual(["- reader: Reader. Reads", `- ${LEAD}: Sancho. The lead`]);
		expect(text).toContain("`message_agent` or `read_agent_chat`");
		expect(text).not.toContain("writer");
	});

	it("says so when the agent is alone, so an archived agent's absence reads as such", () => {
		expect(rosterText(LEAD, [{ id: LEAD, name: "Sancho", description: "The lead" }])).toBe(
			"No other agent is active in the band, so there is nobody to message or read.",
		);
	});

	it("cuts a long description, so each agent costs the prompt a bounded line", () => {
		const line = rosterText(LEAD, [{ id: "mara", name: "Mara", description: "é".repeat(1000) }]).split("\n")[1]!;
		expect([...line.slice("- mara: Mara. ".length)]).toHaveLength(ROSTER_DESCRIPTION);
		expect(line.endsWith("…")).toBe(true);
	});

	it("is a section of every chat's core, rendered only in a direct agent chat", async () => {
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		expect(core.extension.sections?.map((section) => section.key)).toContain("roster");
		const render = (byExecution: { [chat: string]: { room: number; agent: string } }, chats = { "7": "mara" }) => {
			const docs = new Map<unknown, unknown>([
				[AgentChats, { chats }],
				[Groups, { groups: {}, byExecution, admissions: {} }],
				[Accepted, { files: { [agentPath(LEAD)]: { sha: "x", text: LEAD_TEXT, at: 0 } } }],
			]);
			const input = { conversationId: "7", read: { snapshot: async (token: unknown) => docs.get(token) } };
			return rosterSection.render(input as unknown as Parameters<typeof rosterSection.render>[0], context);
		};
		expect(await render({})).toContain(`- ${LEAD}: ${DEFAULT_NAME}. The lead.`);
		// a group member's execution chat: its group section names the members; message_agent is not offered there
		expect(await render({ "7": { room: 3, agent: "mara" } })).toBeUndefined();
		// a chat that is no agent's
		expect(await render({}, {} as { "7": string })).toBeUndefined();
	});

	it("follows the accepted files: an agent made, renamed and archived, with nothing private", async () => {
		const { harness, write } = await open();
		expect(await roster(harness, LEAD_CHAT)).toBe(
			"No other agent is active in the band, so there is nobody to message or read.",
		);

		await write("mara", MARA);
		const made = await roster(harness, LEAD_CHAT);
		expect(made).toContain("- mara: Mara. Plans trips");
		// only id, name and description of a file reach the prompt
		for (const hidden of [SECRET, "faux-1", "bash", "github", "sha"]) expect(made).not.toContain(hidden);
		// Mara's own chat sees the lead by the companion's name, and not itself
		const fromMara = await roster(harness, MARA_CHAT);
		expect(fromMara).toContain(`- ${LEAD}: ${DEFAULT_NAME}. The lead.`);
		expect(fromMara).not.toContain("- mara:");

		await write("mara", MARA.replace('"Mara"', '"Mara Trips"').replace("Plans trips", "Plans every trip"));
		expect(await roster(harness, LEAD_CHAT)).toContain("- mara: Mara Trips. Plans every trip");

		await write("mara", archived(MARA));
		expect(await roster(harness, LEAD_CHAT)).toBe(
			"No other agent is active in the band, so there is nobody to message or read.",
		);

		// restored, it is back
		await write("mara", MARA);
		expect(await roster(harness, LEAD_CHAT)).toContain("- mara: Mara. Plans trips");
	});
});
