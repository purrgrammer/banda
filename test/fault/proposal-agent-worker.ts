/** Cut an existing-agent proposal between its box write and store acceptance; retry must finish atomically. */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Storage } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type Box, openBox } from "../../src/box/box.ts";
import { Accepted, agentPath, shaOf } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import type { Gateway } from "../../src/core/gateway.ts";
import { PROPOSAL_RESULT, type Proposal, Proposals } from "../../src/core/proposals.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore } from "../../src/core/turn.ts";
import type { Workspace } from "../../src/server/agents.ts";
import type { Area, Deps } from "../../src/server/routes/area.ts";
import { proposals as proposalArea } from "../../src/server/routes/proposals.ts";
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
const registry = createRegistry();
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const core = defineCore({
	blobs: new BlobStore(join(home, "blobs")),
	gateway: () => gateway,
	model: () => FAUX_MODEL,
	registry,
});
registry.install(core.extension);
const before = "---\nname: Reader\ndescription: Reads things\n---\nRead carefully.\n";
const resultText = "---\nname: Reader\ndescription: Reads things\n---\nRead carefully and verify claims.\n";

type Running = {
	box: Box;
	harness: Awaited<ReturnType<typeof openStore>>;
	route: NonNullable<Area["route"]>;
	request: Parameters<NonNullable<Area["route"]>>[0];
};
async function setup(): Promise<Running> {
	const box = openBox(hostBox(home!), () => {});
	await mkdir(join(box.workspace, "agents"), { recursive: true });
	const path = join(box.workspace, "agents", "reader.md");
	if (!existsSync(path)) await writeFile(path, before);
	const env = box.env();
	const writing = new Proxy(env, {
		get(target, key) {
			if (key === "writeFile") {
				const write: ExecutionEnv["writeFile"] = async (...args) => {
					if (armed) {
						faults.hit("proposal:apply");
						faults.hit("agent:write:before");
					}
					const written = await target.writeFile(...args);
					if (armed) faults.hit("agent:write:after");
					return written;
				};
				return write;
			}
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const workspace: Workspace = {
		env: () => writing,
		root: box.workspace,
		tools: () => [],
		known: () => true,
	};
	const harness = await openStore(home!, { models, registry, wrapStorage });
	await harness.commit(async (tx) => {
		const accepted = await tx.doc(Accepted);
		accepted.files[agentPath("reader")] ??= { text: before, sha: shaOf(before), at: 1 };
		const proposals = await tx.doc(Proposals);
		if (proposals.proposals.change === undefined) {
			const chat = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const proposal: Proposal = {
				id: "change",
				chat: Number(chat.id),
				from: "sancho",
				kind: "agentChange",
				agent: "reader",
				displayName: "Reader",
				base: shaOf(before),
				before,
				result: resultText,
				at: 1,
				state: "pending",
			};
			proposals.proposals.change = proposal as unknown as import("@earendil-works/pi-durable").JsonObject;
		}
	}, context);
	harness.resume();
	const area = proposalArea.start?.({
		harness,
		core,
		workspace,
		changed() {},
	} as unknown as Deps);
	if (area?.route === undefined) throw new Error("proposal route is missing");
	await harness.commit(async (tx) => void (await tx.doc(Proposals)), context);
	return {
		box,
		harness,
		route: area.route,
		request: {
			method: "POST",
			path: "/proposals/change",
			url: new URL("http://localhost/api/proposals/change"),
			json: async () => ({ action: "accept" }),
			signal: AbortSignal.abort(),
		},
	};
}

async function attempt(run: Running) {
	await run.route(run.request);
}
let current = await setup();
armed = true;
try {
	await attempt(current);
} catch (error) {
	if (!injected(error)) throw error;
	await current.harness.close(context).catch(() => {});
	current.box.close();
	armed = false;
	current = await setup();
	armed = true;
	await attempt(current);
}
armed = false;
const accepted = (await current.harness.snapshot(Accepted, context))?.files[agentPath("reader")];
const proposals = await current.harness.snapshot(Proposals, context);
const proposal = proposals?.proposals.change as unknown as Proposal;
const boxText = await readFile(join(current.box.workspace, "agents", "reader.md"), "utf8");
const entries = await current.harness.commit(
	(tx) => tx.scanEntries({ conversationId: proposal.chat as ConversationId, order: "descending" }, 20),
	context,
);
console.log(
	JSON.stringify({
		state: proposal.state,
		accepted: accepted?.text,
		box: boxText,
		results: entries.items.filter((entry) => entry.kind === PROPOSAL_RESULT).length,
		commits: faults.hits("commit:after"),
		proposalApply: faults.hits("proposal:apply"),
		writeBefore: faults.hits("agent:write:before"),
		writeAfter: faults.hits("agent:write:after"),
	}),
);
await current.harness.close(context);
current.box.close();
