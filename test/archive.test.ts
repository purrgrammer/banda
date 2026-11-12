/**
 * Archiving an agent (DESIGN.md "Agents"): the owner's own write of `state: archived` to its file stops its runs, pauses
 * its routines, revokes its permissions and takes it out of mentions; its chat and file stay. Restoring keeps the
 * routines paused and the permissions gone. The last active agent cannot be archived.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ConversationId, createRegistry, type Harness, LiveDoc } from "@earendil-works/pi-durable";
import { afterAll, describe, expect, it } from "vitest";
import { type Box, openBox } from "../src/box/box.ts";
import { BOX_TOOLS, boxEnv, boxTools } from "../src/box/tools.ts";
import { Accepted, agentPath, LEAD, LEAD_TEXT, shaOf } from "../src/core/agents.ts";
import { stopArchived } from "../src/core/archive.ts";
import { pauseRoutine } from "../src/core/control.ts";
import { type Origin, type Outbound, OWNER } from "../src/core/gateway.ts";
import { Permissions } from "../src/core/permissions.ts";
import { RoutineRefused, Routines } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, Routes } from "../src/core/turn.ts";
import { save, type Workspace } from "../src/server/agents.ts";
import { BadRequest } from "../src/server/http.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

const boxes: Box[] = [];
afterAll(async () => {
	for (const box of boxes) await box.close();
});

/** A gateway that holds its first send until released (or a stop aborts it), so a run is at work. */
class Held extends FakeGateway {
	#holding!: () => void;
	readonly held = new Promise<void>((resolve) => (this.#holding = resolve));
	holds = 1;
	override async send(to: Origin, out: Outbound, signal?: AbortSignal) {
		if (this.holds > 0) {
			this.holds -= 1;
			this.#holding();
			await new Promise<void>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}
		return super.send(to, out);
	}
}

const MARA = '---\nname: "Mara"\ndescription: Plans trips\n---\nWarm and brief.\n';
const archived = (text: string) => text.replace("---\n", "---\nstate: archived\n");

async function open() {
	const home = await tempHome();
	const box = openBox(hostBox(home), () => {});
	boxes.push(box);
	const gateway = new Held();
	const { models } = echoModels();
	const core = defineCore({
		blobs: blobStore(),
		gateway: (name) => (name === gateway.name ? gateway : undefined),
		model: () => FAUX_MODEL,
	});
	const registry = createRegistry();
	registry.install(core.extension);
	registry.install(boxTools({ workspace: box.workspace }));
	const harness = await openStore(home, { models, registry, env: boxEnv(box) });
	harness.resume();
	const workspace: Workspace = {
		env: () => box.env(),
		root: box.workspace,
		tools: () => [...BOX_TOOLS],
		known: () => true,
	};
	// the box holds the first agent's file, as the daemon's seed writes it
	await mkdir(join(box.workspace, "agents"), { recursive: true });
	await writeFile(join(box.workspace, "agents", `${LEAD}.md`), LEAD_TEXT);
	/** The owner saves agent `name`'s file as `text`, over what is accepted now; then what the daemon does after. */
	const write = async (name: string, text: string) => {
		const base = (await accepted(harness, name))?.sha ?? null;
		await save(harness, workspace, name, text, base, core.agentChanged);
		await stopArchived(harness);
		await core.reconcile(harness);
	};
	return { harness, core, gateway, workspace, write };
}

const idle = async (harness: Harness, chat: number) =>
	(await harness.commit(async (tx) => (await tx.doc(LiveDoc, chat as ConversationId)).run, context)) === undefined;

const accepted = (harness: Harness, name: string) =>
	harness.commit(async (tx) => {
		const file = (await tx.doc(Accepted)).files[agentPath(name)];
		return file === undefined ? undefined : { ...file };
	}, context);
const lead = async (harness: Harness) => (await accepted(harness, LEAD))?.text ?? "";

describe("archiving an agent", () => {
	it("stops its run, pauses its routines, revokes its permissions, and takes it out of chats and mentions", async () => {
		const { harness, core, gateway, write } = await open();
		await write("mara", MARA);
		const thread = { gateway: "fake", peer: OWNER, thread: "mara" };
		const room = await core.groups.create(harness, { members: [LEAD, "mara"] });
		const got = await core.receive(harness, { id: "m1", origin: thread, text: "plan Lisbon", agent: "mara" });
		if (!("chat" in got)) throw new Error(JSON.stringify(got));
		await gateway.held;
		expect(await idle(harness, got.chat)).toBe(false);
		// a routine of Mara's chat and one of the lead's; a permission given in each agent's chat
		await harness.commit(async (tx) => {
			const { routines } = await tx.doc(Routines);
			routines.trip = { agent: "mara" };
			routines.tea = {};
			const doc = await tx.doc(Permissions);
			const given = { tool: "send", match: {}, scope: "always" as const, at: 1, wait: 1 };
			doc.permissions["1"] = { ...given, what: "send as Mara", agent: "mara" };
			doc.permissions["2"] = { ...given, what: "send as the lead", agent: LEAD };
		}, context);

		await write("mara", archived(MARA));

		await until(() => idle(harness, got.chat));
		const routines = (await harness.snapshot(Routines, context))?.routines;
		expect(routines?.trip?.paused).toBe("owner");
		expect(routines?.tea?.paused).toBeUndefined();
		expect(Object.values((await harness.snapshot(Permissions, context))?.permissions ?? {}).map((p) => p.what)).toEqual(
			["send as the lead"],
		);
		// its chat takes nothing new, nor does a new one; its file and chat stay
		expect(await core.receive(harness, { id: "m2", origin: thread, text: "and Porto?", agent: "mara" })).toEqual({
			refused: "Mara is archived: restore it from Settings to write to it",
		});
		expect(
			await core.receive(harness, {
				id: "m3",
				origin: { ...thread, thread: "other" },
				text: "hi",
				agent: "mara",
			}),
		).toEqual({ refused: "Mara is archived: restore it from Settings to write to it" });
		// a group keeps it in its history; asking it is refused, the others still answer
		expect(await core.groups.post(harness, { room, key: "k1", text: "@Mara?", mentions: ["mara"] })).toEqual({
			refused: "Mara is archived: restore it from Settings to ask it",
		});
		const asked = await core.groups.post(harness, { room, key: "k2", text: "anyone?", mentions: [LEAD] });
		expect(asked).toMatchObject({ turns: { [LEAD]: expect.any(Number) } });
		expect((await core.groups.rooms(harness)).find((each) => each.room === room)?.members).toEqual([LEAD, "mara"]);
		// its routine cannot be resumed or run while it is archived
		await expect(pauseRoutine(harness, core.reconcile, "trip", false, Date.now())).rejects.toThrow(RoutineRefused);
	});

	it("restoring keeps its routines paused and its permissions gone", async () => {
		const { harness, core, write } = await open();
		await write("mara", MARA);
		const thread = { gateway: "fake", peer: OWNER, thread: "mara" };
		const got = await core.receive(harness, { id: "m1", origin: thread, text: "hello", agent: "mara" });
		if (!("chat" in got)) throw new Error(JSON.stringify(got));
		await harness.commit(async (tx) => {
			(await tx.doc(Routines)).routines.trip = { agent: "mara" };
			(await tx.doc(Permissions)).permissions["1"] = {
				tool: "send",
				match: {},
				what: "send as Mara",
				scope: "always",
				agent: "mara",
				at: 1,
				wait: 1,
			};
		}, context);
		await write("mara", archived(MARA));
		await write("mara", MARA);
		expect((await harness.snapshot(Routines, context))?.routines.trip?.paused).toBe("owner");
		expect((await harness.snapshot(Permissions, context))?.permissions).toEqual({});
		// its chat takes messages again, and the owner may resume its routine
		expect(await core.receive(harness, { id: "m2", origin: thread, text: "back?", agent: "mara" })).toMatchObject({
			chat: got.chat,
		});
		expect(await pauseRoutine(harness, core.reconcile, "trip", false, Date.now())).toBe(true);
	});

	it("refuses to archive the last active agent, the first one included; a new chat then runs another", async () => {
		const { harness, core, write } = await open();
		const refused = async (name: string, text: string) => {
			const error = await write(name, text).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(BadRequest);
			expect([(error as BadRequest).status, (error as Error).message]).toEqual([
				409,
				expect.stringMatching(/last active agent/),
			]);
		};
		// the first agent alone
		await refused(LEAD, archived(await lead(harness)));
		await write("mara", MARA);
		// the first agent is ordinary: archived, a gateway's new chat runs another
		await write(LEAD, archived(await lead(harness)));
		const got = await core.receive(harness, { id: "g1", origin: { gateway: "fake", peer: OWNER }, text: "hi" });
		if (!("chat" in got)) throw new Error(JSON.stringify(got));
		expect((await harness.snapshot(Routes, context))?.chats[got.chat]?.agent).toBe("mara");
		// now Mara is the last active one
		await refused("mara", archived(MARA));
		expect((await accepted(harness, "mara"))?.sha).toBe(shaOf(MARA));
	});
});
