/** A question dismissed under a kill: the answer slot and its transcript outcome survive together. */

import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import { dismissQuestion, revive, WAIT, type WaitEnded } from "../../src/core/wait.ts";
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
const core = defineCore({
	blobs: new BlobStore(join(home, "blobs")),
	gateway: () => gateway,
	model: () => FAUX_MODEL,
	retryDelay: () => 5,
});
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
	faults.hit("model");
	const last = ctx.messages.at(-1);
	if (last?.role === "user")
		return fauxAssistantMessage(
			[fauxToolCall("ask_user", { question: "Which day?", options: ["Monday", "Tuesday"] })],
			{ stopReason: "toolUse" },
		);
	if (last?.role === "toolResult" && JSON.stringify(last.content).includes("dismissed this question"))
		return fauxAssistantMessage([fauxToolCall("message_user", { text: "Okay, no need to choose a day." })], {
			stopReason: "toolUse",
		});
	return fauxAssistantMessage("Done.");
};
faux.setResponses(Array.from({ length: 100 }, () => respond as never));
const registry = createRegistry();
registry.install(core.extension);
const harness = await openStore(home, { models, registry, wrapStorage: (storage) => faults.storage(storage) });
await revive(harness);
harness.resume();
const got = await core.receive(harness, {
	id: "question-under-fault",
	origin: { gateway: "fake", peer: OWNER },
	text: "Pick a day",
});
if (!("turn" in got)) throw new Error(`no Turn: ${JSON.stringify(got)}`);
let wait: Awaited<ReturnType<typeof openWaits>>[number] | "done" | undefined;
while (wait === undefined) {
	wait = (await openWaits(harness, got.chat))[0];
	if (wait !== undefined) break;
	const turn = await harness.getTask(got.turn as TaskId<TurnResult>, context);
	if (turn?.state.status === "terminal") wait = "done";
	else await new Promise((resolve) => setTimeout(resolve, 10));
}
if (wait !== "done") {
	faults.hit("answer");
	const filled = await dismissQuestion(harness, wait.key, { gateway: "fake", peer: OWNER }, "bearer");
	if ("refused" in filled && !/closed|no open ask/.test(filled.refused)) throw new Error(filled.refused);
}
await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
const page = await (await harness.conversation(got.chat as ConversationId, context))!.entries(
	{ order: "ascending" },
	1000,
	undefined,
	context,
);
const waits = page.items.filter((entry) => entry.kind === WAIT).map((entry) => entry.data as unknown as WaitEnded);
const outcome = (await harness.getTask(got.turn as TaskId<TurnResult>, context))?.state.outcome;
const { parked } = await status(harness);
console.log(
	JSON.stringify({
		outcome,
		waits,
		open: (await openWaits(harness)).length,
		parked,
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
