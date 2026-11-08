/**
 * The process the archive fault suite kills: Mara's chat is at work when the owner archives her (her model request
 * accepts the archived file, as the owner's save does), and the stop that follows is not awaited. A restart stops what
 * an archived agent still runs, as the daemon does at its start. Whatever was killed, she ends archived, idle, her
 * routine paused, her permission revoked, and her chat takes nothing new.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Harness, LiveDoc } from "@earendil-works/pi-durable";
import { Accepted, agentPath, isArchived, shaOf } from "../../src/core/agents.ts";
import { stopArchived } from "../../src/core/archive.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { Permissions } from "../../src/core/permissions.ts";
import { Routines } from "../../src/core/routines.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore } from "../../src/core/turn.ts";
import { FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const ACTIVE = "---\nname: Mara\ndescription: Plans trips\n---\nWarm.\n";
const ARCHIVED = "---\nname: Mara\nstate: archived\ndescription: Plans trips\n---\nWarm.\n";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
let harness: Harness;
const gateway: Gateway = {
	name: "fake",
	strength: "bearer",
	can: { buttons: false, files: false, threads: true },
	start() {},
	async send() {
		return `out-${process.pid}`;
	},
};
const core = defineCore({ blobs: new BlobStore(`${home}/blobs`), gateway: () => gateway, model: () => FAUX_MODEL });
const respond = async (request: { messages: readonly { role: string }[] }) => {
	// the owner archives Mara while her run is at work: the file and what it ends in one commit, then the stop
	await harness.commit(async (tx) => {
		if (await isArchived(tx, "mara")) return;
		(await tx.doc(Accepted)).files[agentPath("mara")] = { sha: shaOf(ARCHIVED), text: ARCHIVED, at: 2 };
		await core.agentChanged(tx, "mara");
	}, context);
	void stopArchived(harness).catch(() => undefined);
	if (request.messages.at(-1)?.role === "user")
		return fauxAssistantMessage([fauxToolCall("react", { reaction: "👍" })], { stopReason: "toolUse" });
	return fauxAssistantMessage("done");
};
faux.setResponses(Array.from({ length: 500 }, () => respond as never));

const registry = createRegistry();
registry.install(core.extension);
harness = await openStore(home, { models, registry, wrapStorage: (storage) => faults.storage(storage) });
await harness.commit(async (tx) => {
	(await tx.doc(Accepted)).files[agentPath("mara")] ??= { sha: shaOf(ACTIVE), text: ACTIVE, at: 1 };
}, context);
harness.resume();
// as the daemon's start: an archived agent runs nothing, whatever a kill left between its archive and the stop
await stopArchived(harness);

// her routine and a permission given in her chat, before her run can archive her
await harness.commit(async (tx) => {
	if (await isArchived(tx, "mara")) return;
	(await tx.doc(Routines)).routines.trip ??= { agent: "mara" };
	(await tx.doc(Permissions)).permissions["1"] ??= {
		tool: "send",
		match: {},
		what: "send as Mara",
		scope: "always",
		agent: "mara",
		at: 1,
		wait: 1,
	};
}, context);

const origin = { gateway: "fake", peer: OWNER, thread: "mara" };
const got = await core.receive(harness, { id: "m1", origin, text: "plan Lisbon", agent: "mara" });
if (!("chat" in got)) throw new Error(JSON.stringify(got));
const chat = got.chat;
for (let attempt = 0; ; attempt++) {
	const settled = await harness.commit(async (tx) => {
		const turns = (await tx.scanTasks({ kind: "banda.turn" }, 100)).items;
		const live = (await tx.doc(LiveDoc, chat as ConversationId)).run;
		return (
			(await isArchived(tx, "mara")) &&
			live === undefined &&
			turns.length > 0 &&
			turns.every((task) => task.state.status === "terminal")
		);
	}, context);
	if (settled) break;
	if (attempt === 500) throw new Error("the archive did not settle");
	await new Promise((resolve) => setTimeout(resolve, 10));
}

const again = await core.receive(harness, { id: "m2", origin, text: "and Porto?", agent: "mara" });
console.log(
	JSON.stringify({
		again,
		trip: (await harness.snapshot(Routines, context))?.routines.trip ?? null,
		permissions: (await harness.snapshot(Permissions, context))?.permissions ?? {},
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
