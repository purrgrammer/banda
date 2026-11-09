/**
 * The process the groups fault suite kills: a group of alice and bob; the owner's message asks both; alice's answer
 * asks bob in turn (a chained mention), and bob answers each turn: the owner's only once nudged, having first ended
 * with notes alone. The worker waits until the room is quiet (every
 * member's newest turn ended, no run at work) and prints the room's log as its last line. Restarted, it finds the
 * group it made and posts the owner's message again under the same key, as a client retrying would.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { Accepted, agentPath, shaOf } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import type { Gateway } from "../../src/core/gateway.ts";
import { GROUP_NUDGE, Groups } from "../../src/core/groups.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore } from "../../src/core/turn.ts";
import { FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);

const gateway: Gateway = {
	name: "fake",
	strength: "bearer",
	can: { buttons: false, files: false, threads: true },
	start() {},
	async send() {
		return `out-${process.pid}-${Math.random()}`;
	},
};
const blobs = new BlobStore(join(home, "blobs"));
const registry = createRegistry();
const core = defineCore({ blobs, gateway: () => gateway, model: () => FAUX_MODEL, retryDelay: () => 5, registry });

type Said = { role: string; content: unknown };
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// alice asks bob when she answers; bob answers alone, the owner's message only when nudged; a tool's result ends a run
const respond = (ctx: { messages: readonly Said[] }) => {
	faults.hit("model");
	const last = ctx.messages.at(-1);
	if (last?.role === "toolResult") return fauxAssistantMessage("done");
	const alice = JSON.stringify(ctx.messages).includes("You are alice.");
	if (!alice && last?.role === "user" && JSON.stringify(last.content).includes("both of you"))
		return fauxAssistantMessage("notes: I'll answer later");
	return fauxAssistantMessage(
		[fauxToolCall("message_group", alice ? { text: "alice reply", ask: ["bob"] } : { text: "bob reply" })],
		{ stopReason: "toolUse" },
	);
};
faux.setResponses(Array.from({ length: 500 }, () => respond as never));

registry.install(core.extension);
registry.install(core.groupExtension);
const harness = await openStore(home, { models, registry, wrapStorage: (storage) => faults.storage(storage) });
await harness.commit(async (tx) => {
	for (const agent of ["alice", "bob"]) {
		const text = `---\ndescription: ${agent}\ntools: [read]\n---\nYou are ${agent}.`;
		(await tx.doc(Accepted)).files[agentPath(agent)] = { sha: shaOf(text), text, at: 0 };
	}
}, context);
// each member offered whom it may ask, before anything resumes
await core.reconcileTools(harness);
harness.resume();

// the group this home has, or a new one: a restart never makes a second
const existing = Object.keys((await harness.snapshot(Groups, context))?.groups ?? {}).map(Number)[0];
const room = existing ?? (await core.groups.create(harness, { members: ["alice", "bob"], name: "pair" }));
const posted = await core.groups.post(harness, {
	key: "owner-1",
	room,
	text: "both of you",
	mentions: ["alice", "bob"],
});
if ("refused" in posted) throw new Error(posted.refused);

// quiet: each member's newest turn ended and its chat runs nothing, and alice's mention of bob was answered
for (;;) {
	const doc = await harness.snapshot(Groups, context);
	const group = doc?.groups[room];
	let settled = group !== undefined;
	for (const execution of Object.values(group?.executions ?? {})) {
		const turn =
			execution.lastTurn === undefined ? undefined : await harness.getTask(execution.lastTurn as TaskId, context);
		const live = await harness.snapshot(LiveDoc, execution.chat as ConversationId, context);
		if ((turn !== undefined && turn.state.status !== "terminal") || live?.run !== undefined) settled = false;
	}
	const log = await core.groups.messages(harness, room);
	if (settled && log.filter((message) => message.text === "bob reply").length >= 2) break;
	await new Promise((resolve) => setTimeout(resolve, 20));
}
const log = await core.groups.messages(harness, room);
const lines = await core.groups.log(harness, room);
const bob = (await harness.snapshot(Groups, context))?.groups[room]?.executions.bob?.chat;
let nudges = 0;
await harness.commit(async (tx) => {
	const page = await tx.scanEntries({ conversationId: bob as ConversationId }, 500);
	nudges = page.items.filter((entry) => entry.kind === GROUP_NUDGE).length;
}, context);
const turns = Object.values((await harness.snapshot(Groups, context))?.admissions ?? {}).map((admission) =>
	Object.keys(admission.turns).sort(),
);
console.log(
	JSON.stringify({
		rooms: Object.keys((await harness.snapshot(Groups, context))?.groups ?? {}).length,
		log: log.map((message) => ({ author: message.author, text: message.text, mentions: message.mentions })),
		turns,
		notices: lines.flatMap((line) => ("notice" in line ? [line.notice] : [])),
		nudges,
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
