/**
 * Cut `create_agent` and `create_group` at their commits and at the box publication's boundaries; reopen and let the
 * same owner message finish, to prove one agent, one group, one receipt each, and a box file equal to what is in effect.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	type Storage,
	type TaskId,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { type Box, openBox } from "../../src/box/box.ts";
import { Accepted, agentPath } from "../../src/core/agents.ts";
import { BandCalls } from "../../src/core/band-tools.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import type { Gateway } from "../../src/core/gateway.ts";
import { OWNER } from "../../src/core/gateway.ts";
import { Groups } from "../../src/core/groups.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import {
	AGENT_PUBLICATION_POINTS,
	agentWorkingBase,
	finishAgentPublication,
	queueAgentPublication,
	recoverAgentPublications,
} from "../../src/server/agent-publication.ts";
import type { Workspace } from "../../src/server/agents.ts";
import { hostBox } from "../fixtures/host-box.ts";
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
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const respond = (request: ModelContext) => {
	const last = request.messages.at(-1);
	const words = last?.role === "user" ? last.content : "";
	const input =
		typeof words === "string" ? words : words.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	if (input === "hire a writer and team up")
		return fauxAssistantMessage(
			[
				fauxToolCall("create_agent", {
					id: "writer",
					name: "Writer",
					description: "Writes drafts",
					instructions: "Write.",
				}),
				fauxToolCall("create_group", { name: "Writing room", members: ["sancho", "writer"] }),
			],
			{ stopReason: "toolUse" },
		);
	return fauxAssistantMessage("done");
};
faux.setResponses(Array.from({ length: 100 }, () => respond as never));
const inbound = {
	id: "owner-band-1",
	origin: { gateway: "fake", peer: OWNER, thread: "main" },
	text: "hire a writer and team up",
	agent: "sancho",
} as const;

type Running = { box: Box; harness: Awaited<ReturnType<typeof openStore>> };
/** What a failed setup opened, to close before the next: a box left open keeps the process alive. */
let opened: { box?: Box; harness?: Awaited<ReturnType<typeof openStore>> } = {};
async function setup(): Promise<Running> {
	const box = openBox(hostBox(home!), () => {});
	opened = { box };
	await mkdir(join(box.workspace, "agents"), { recursive: true });
	const workspace: Workspace = {
		env: () => box.env(),
		root: box.workspace,
		tools: () => [],
		known: () => true,
		publicationPoint: (point) => {
			if (armed) faults.hit(point);
		},
	};
	const registry = createRegistry();
	let harness: Awaited<ReturnType<typeof openStore>> | undefined;
	const core = defineCore({
		blobs: new BlobStore(join(home!, "blobs")),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		registry,
		band: {
			workingBase: (name, ctx) => agentWorkingBase(workspace, name, ctx),
			queue: queueAgentPublication,
			finish: async (name, ctx) => {
				if (harness !== undefined) await finishAgentPublication(harness, workspace, name, ctx);
			},
			groupMade: async () => {},
		},
	});
	registry.install(core.extension);
	harness = await openStore(home!, { models, registry, wrapStorage });
	opened.harness = harness;
	await recoverAgentPublications(harness, workspace);
	harness.resume();
	const started = await core.receive(harness, inbound);
	if ("turn" in started) await harness.waitForTask(started.turn as TaskId<TurnResult>, context);
	else if ("refused" in started) throw new Error(started.refused);
	// as the daemon does at start, when the box comes up and when the owner opens the band: a write the box refused
	// while the call ran is finished now
	await recoverAgentPublications(harness, workspace);
	return { box, harness };
}

let current: Running;
armed = true;
try {
	current = await setup();
} catch (error) {
	if (!injected(error)) throw error;
	await opened.harness?.close(context).catch(() => {});
	await opened.box?.close().catch(() => {});
	armed = false;
	current = await setup();
}
armed = false;
const accepted = (await current.harness.snapshot(Accepted, context))?.files[agentPath("writer")];
const groups = await current.harness.snapshot(Groups, context);
const calls = Object.values((await current.harness.snapshot(BandCalls, context))?.calls ?? {});
const boxText = await readFile(join(current.box.workspace, "agents", "writer.md"), "utf8").catch(() => "");
const chats = await current.harness.commit((tx) => tx.scanConversations({}, 10), context);
const results: { tool: string; error: boolean; receipt: boolean; text?: string }[] = [];
for (const chat of chats.items) {
	const page = await current.harness.commit(
		(tx) => tx.scanEntries({ conversationId: chat.id as ConversationId, order: "ascending" }, 200),
		context,
	);
	for (const entry of page.items.filter(ToolResultEntry.is)) {
		const result = entry.model?.[0] as ToolResultMessage | undefined;
		if (result === undefined) continue;
		const receipt = (result.details as { receipt?: unknown } | undefined)?.receipt;
		results.push({
			tool: result.toolName,
			error: result.isError,
			receipt: receipt !== undefined,
			// an error's words, so a failing sweep says why
			...(result.isError
				? { text: result.content.map((part) => (part.type === "text" ? part.text : "")).join("") }
				: {}),
		});
	}
}
console.log(
	JSON.stringify({
		accepted: accepted?.text ?? "",
		box: boxText,
		rooms: Object.keys(groups?.groups ?? {}).length,
		receipts: calls.map((call) => (call as { kind: string }).kind).sort(),
		results,
		commits: faults.hits("commit:after"),
		points: Object.fromEntries(AGENT_PUBLICATION_POINTS.map((point) => [point, faults.hits(point)])),
	}),
);
await current.harness.close(context);
await current.box.close();
