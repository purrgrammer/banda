/**
 * The process the memory fault suite kills: three owner messages, each asking the model to remember a fact under the
 * global or agent scope, then one asking it to recall them. Memory files are written into a box on this machine through the
 * `memory:before` and `memory:after` points; search catches up through `index`; the model's requests pass `model`.
 * Prints what is in the files and the index as its last line.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { openBox } from "../../src/box/box.ts";
import { boxEnv, boxTools } from "../../src/box/tools.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import {
	agentMemoryPath,
	factId,
	GLOBAL_MEMORY,
	type MemoryFiles,
	MemoryLock,
	memoryExtension,
} from "../../src/core/memory.ts";
import { Search } from "../../src/core/search.ts";
import { searchService } from "../../src/core/search-service.ts";
import { searchExtension } from "../../src/core/search-tools.ts";
import { status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import { revive } from "../../src/core/wait.ts";
import type { Item } from "../../src/server/api.ts";
import { boxMemory, memory } from "../../src/server/memory.ts";
import { chats, items } from "../../src/server/transcript.ts";
import { hostBox } from "../fixtures/host-box.ts";
import { answerNudge, FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);

const FACTS = ["Prefers window seats", "Never flies before 9am", "Likes small hotels"];

const gateway: Gateway = {
	name: "fake",
	strength: "bearer",
	can: { buttons: false, files: false, threads: true },
	start() {},
	async send() {
		return `out-${process.pid}-${Math.random()}`;
	},
};
const box = openBox(hostBox(home), () => {});
const boxed = boxMemory({ env: () => box.env(), root: box.workspace });
const files: MemoryFiles = {
	...boxed,
	write: async (path, text, ctx) => {
		faults.hit("memory:before");
		await boxed.write(path, text, ctx);
		faults.hit("memory:after");
	},
};
const search = new Search(join(home, "search.db"), { hit: () => faults.hit("index") });
const blobs = new BlobStore(join(home, "blobs"));
const core = defineCore({ blobs, gateway: () => gateway, model: () => FAUX_MODEL });

const textOf = (message: Message | undefined): string =>
	message === undefined
		? ""
		: typeof message.content === "string"
			? message.content
			: (message.content as readonly { text?: string }[]).map((part) => part.text ?? "").join("");
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const respond = (ctx: { messages: readonly Message[] }) => {
	faults.hit("model");
	const heed = answerNudge(ctx.messages);
	if (heed !== undefined) return heed;
	const last = ctx.messages.filter((message) => message.role !== "system").at(-1);
	if (last?.role === "toolResult") {
		if (last.toolName === "search" && !last.isError) {
			const source = JSON.parse(textOf(last)).results[0]?.source;
			if (source)
				return fauxAssistantMessage([fauxToolCall("read_search_result", { source })], { stopReason: "toolUse" });
		}
		if (last.isError && last.toolName === "remember") {
			const previous = ctx.messages
				.flatMap((message) =>
					message.role === "assistant"
						? message.content.filter((part) => part.type === "toolCall" && part.name === "remember")
						: [],
				)
				.at(-1);
			if (previous?.type === "toolCall")
				return fauxAssistantMessage([fauxToolCall("remember", previous.arguments)], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("noted");
	}
	const said = textOf(last);
	const call = said.startsWith("search")
		? fauxToolCall("search", { query: "window hotels flies" })
		: said.startsWith("correct")
			? fauxToolCall("remember", {
					fact: "Prefers aisle seats",
					scope: "global",
					replaces: factId(GLOBAL_MEMORY, FACTS[0]!),
				})
			: said.startsWith("recall")
				? fauxToolCall("recall", { query: "seats hotels flies" })
				: fauxToolCall("remember", {
						fact: said.replace(/^remember /, ""),
						scope: said.includes("window") ? "global" : "agent",
					});
	return fauxAssistantMessage([call], { stopReason: "toolUse" });
};
faux.setResponses(Array.from({ length: 1000 }, () => respond as never));

const registry = createRegistry();
registry.install(core.extension);
registry.install(boxTools({ box }));
registry.install(memoryExtension({ files, search, lock: new MemoryLock() }));
const retrieval = searchService({ index: search, blobs, groups: core.groups, harness: () => harness });
registry.install(searchExtension(retrieval));
const harness = await openStore(home, {
	models,
	registry,
	env: boxEnv(box),
	wrapStorage: (storage) => faults.storage(storage),
});
await revive(harness);
harness.resume();

const said = [...FACTS.map((fact) => `remember ${fact}`), "correct", "recall", "search"];
const outcomes = [];
for (const [i, text] of said.entries()) {
	const got = await core.receive(harness, { id: `m${i}`, origin: { gateway: "fake", peer: OWNER }, text });
	if (!("turn" in got)) throw new Error(`message ${i} started no Turn: ${JSON.stringify(got)}`);
	await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
	outcomes.push((await harness.getTask(got.turn as TaskId<TurnResult>, context))?.state.outcome);
}
const lines = [GLOBAL_MEMORY, agentMemoryPath("sancho")].flatMap((path) =>
	readFileSync(join(box.workspace, path), { encoding: "utf8", flag: "a+" })
		.split("\n")
		.filter((line) => line.startsWith("- ")),
);
await search.memory(boxed, context);
await search.messages(harness, context);
const rows = search.rows();
const fresh = new Search(join(home, `rebuilt-${process.pid}.db`));
await fresh.memory(boxed, context);
await fresh.messages(harness, context);
const { parked } = await status(harness);
// what the app would show: every chat's items, whole, and memory as the daemon reports it
const transcripts: Item[][] = [];
for (const row of await chats(harness)) {
	const all: Item[] = [];
	let before: number | undefined;
	do {
		const page = await items(harness, row.chat, before === undefined ? {} : { before });
		all.unshift(...(page?.items ?? []));
		before = page?.next;
	} while (before !== undefined);
	transcripts.push(all);
}
const known = await memory({ harness, files: boxed, search, lock: new MemoryLock() }, Date.now());
console.log(
	JSON.stringify({
		outcomes,
		transcripts,
		memory: known,
		lines,
		rows,
		rebuilt: fresh.rows(),
		parked,
		commits: faults.hits("commit:after"),
		models: faults.hits("model"),
		writes: faults.hits("memory:after"),
		indexes: faults.hits("index"),
	}),
);
fresh.close();
search.close();
await box.close();
await harness.close(context);
