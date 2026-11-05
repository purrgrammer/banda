/** Cut proposal creation and owner acceptance at commits; reopen and retry the same request to prove one result. */
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Storage, type TaskId } from "@earendil-works/pi-durable";
import { Accepted, agentPath, shaOf } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import type { Gateway } from "../../src/core/gateway.ts";
import { OWNER } from "../../src/core/gateway.ts";
import { Groups } from "../../src/core/groups.ts";
import { PROPOSAL_ENTRY, PROPOSAL_RESULT, type Proposal, Proposals } from "../../src/core/proposals.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import type { Area, Deps } from "../../src/server/routes/area.ts";
import { proposals as proposalArea } from "../../src/server/routes/proposals.ts";
import { FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults, InjectedFault } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2);
if (!home || !scheduleJson) throw new Error("home and fault schedule required");
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const injected = (error: unknown): boolean => {
	for (let current = error; current instanceof Error; current = current.cause)
		if (current instanceof InjectedFault) return true;
	return false;
};
let armed = false;
const wrapStorage = (storage: Storage): Storage => {
	const faulted = faults.storage(storage);
	return new Proxy(storage, {
		get(target, key) {
			if (key === "commit") {
				const commit: Storage["commit"] = (...args) => (armed ? faulted : target).commit(...args);
				return commit;
			}
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};
const gateway: Gateway = {
	name: "fake",
	strength: "bearer",
	can: { buttons: false, files: false, threads: true },
	start() {},
	async send() {
		return "sent";
	},
};
const registry = createRegistry();
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const respond = (request: ModelContext) => {
	const last = request.messages.at(-1);
	const words = last?.role === "user" ? last.content : "";
	const input =
		typeof words === "string" ? words : words.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	if (input.includes("propose a research group"))
		return fauxAssistantMessage([fauxToolCall("propose_group", { name: "Research", members: ["sancho", "reader"] })], {
			stopReason: "toolUse",
		});
	return fauxAssistantMessage("done");
};
faux.setResponses(Array.from({ length: 100 }, () => respond as never));
const core = defineCore({
	blobs: new BlobStore(join(home, "blobs")),
	gateway: () => gateway,
	model: () => FAUX_MODEL,
	registry,
});
registry.install(core.extension);
const inbound = {
	id: "owner-propose-1",
	origin: { gateway: "fake", peer: OWNER, thread: "main" },
	text: "propose a research group",
	agent: "sancho",
} as const;

type Running = {
	harness: Awaited<ReturnType<typeof openStore>>;
	route: NonNullable<Area["route"]>;
};
async function setup(): Promise<Running> {
	const harness = await openStore(home!, { models, registry, wrapStorage });
	await harness.commit(async (tx) => {
		const accepted = await tx.doc(Accepted);
		for (const [id, name] of [
			["sancho", "Sancho"],
			["reader", "Reader"],
		]) {
			const text = `---\nname: ${name}\ndescription: ${name} agent\nstate: active\n---\nYou are ${name}.\n`;
			accepted.files[agentPath(id)] ??= { text, sha: shaOf(text), at: 1 };
		}
		await tx.doc(Proposals);
	}, context);
	harness.resume();
	const deps = { harness, core, workspace: {} as Deps["workspace"], changed() {} } as unknown as Deps;
	const area = proposalArea.start?.(deps);
	if (area?.route === undefined) throw new Error("proposal route is missing");
	await harness.commit(async (tx) => void (await tx.doc(Proposals)), context);
	return { harness, route: area.route };
}

async function perform(current: Running) {
	const started = await core.receive(current.harness, inbound);
	if ("turn" in started) await current.harness.waitForTask(started.turn as TaskId<TurnResult>, context);
	const doc = await current.harness.snapshot(Proposals, context);
	const proposal = Object.values(doc?.proposals ?? {})
		.map((value) => value as unknown as Proposal)
		.find((value) => value.kind === "group");
	if (proposal === undefined) throw new Error("the proposal tool did not create a group proposal");
	await current.route({
		method: "POST",
		path: `/proposals/${encodeURIComponent(proposal.id)}`,
		url: new URL(`http://localhost/api/proposals/${encodeURIComponent(proposal.id)}`),
		json: async () => ({ action: "accept" }),
		signal: AbortSignal.abort(),
	});
}

let current = await setup();
armed = true;
try {
	await perform(current);
} catch (error) {
	if (!injected(error)) throw error;
	await current.harness.close(context).catch(() => {});
	armed = false;
	current = await setup();
	armed = true;
	await perform(current);
}
armed = false;
const state = await current.harness.snapshot(Proposals, context);
const groups = await current.harness.snapshot(Groups, context);
const proposal = Object.values(state?.proposals ?? {})
	.map((value) => value as unknown as Proposal)
	.find((value) => value.kind === "group");
if (proposal === undefined) throw new Error("missing proposal after acceptance");
const entries = await current.harness.commit(
	(tx) => tx.scanEntries({ conversationId: proposal.chat as ConversationId, order: "descending" }, 30),
	context,
);
console.log(
	JSON.stringify({
		state: proposal.state,
		rooms: Object.keys(groups?.groups ?? {}).length,
		room: groups?.proposalRooms?.[proposal.id],
		proposals: entries.items.filter((entry) => entry.kind === PROPOSAL_ENTRY).length,
		results: entries.items.filter((entry) => entry.kind === PROPOSAL_RESULT).length,
		commits: faults.hits("commit:after"),
	}),
);
await current.harness.close(context);
