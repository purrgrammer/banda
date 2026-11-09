/**
 * The process the Wait fault suite kills: one owner message whose model calls an unsafe effect, which waits on the
 * owner's approval; the worker approves every ask it finds open, as the owner would on each restart, and prints a
 * summary as its last line. The effect appends each run to `<home>/runs.jsonl`, so runs survive a killed process.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, defineExtension, type TaskId } from "@earendil-works/pi-durable";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import { revive, WAIT, type WaitEnded } from "../../src/core/wait.ts";
import { FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";
import { ownerAnswer } from "./owner.ts";

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
const core = defineCore({ blobs, gateway: () => gateway, model: () => FAUX_MODEL, retryDelay: () => 5 });
const deploy = core.effect({
	name: "deploy",
	description: "deploy a target",
	parameters: Type.Object({ target: Type.String() }),
	effect: "unsafe",
	run: async (args) => {
		appendFileSync(join(home, "runs.jsonl"), `${JSON.stringify(args)}\n`);
		faults.hit("effect");
		return { output: [{ type: "text", text: `deployed ${args.target}` }] };
	},
});
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// a tool call first; once its result is in, the answer
const respond = (ctx: { messages: readonly { role: string }[] }) =>
	ctx.messages.at(-1)?.role === "toolResult"
		? fauxAssistantMessage("Deployed.")
		: fauxAssistantMessage([fauxToolCall("deploy", { target: "prod" }, { id: "c1" })], { stopReason: "toolUse" });
faux.setResponses(Array.from({ length: 100 }, () => respond as never));
const registry = createRegistry();
registry.install(core.extension);
registry.install(defineExtension({ name: "test", tools: [deploy] }));
const harness = await openStore(home, { models, registry, wrapStorage: (storage) => faults.storage(storage) });
// as the daemon does on start
await revive(harness);
harness.resume();

const received = await core.receive(harness, { id: "m1", origin: { gateway: "fake", peer: OWNER }, text: "ship it" });
if (!("turn" in received)) throw new Error("the message started no Turn");
const ended = harness.waitForTask(received.turn as TaskId<TurnResult>, context).then(() => true);
// the owner approves whatever is open, each restart
while (!(await Promise.race([ended, new Promise<false>((r) => setTimeout(r, 10, false))]))) {
	for (const wait of await openWaits(harness)) {
		faults.hit("answer");
		await ownerAnswer(harness, wait.key, "approve", { gateway: "web", peer: OWNER }, "bearer");
	}
}
const outcome = (await harness.getTask(received.turn as TaskId<TurnResult>, context))?.state.outcome;
const page = await (await harness.conversation(received.chat as ConversationId, context))!.entries(
	{ order: "ascending" },
	1000,
	undefined,
	context,
);
const results = page.items.filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model?.[0] ?? null));
const waits = page.items.filter((e) => e.kind === WAIT).map((e) => e.data as unknown as WaitEnded);
const runs = readFileSync(join(home, "runs.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean);
const { parked } = await status(harness);
console.log(
	JSON.stringify({
		outcome,
		results,
		waits,
		runs,
		parked,
		open: (await openWaits(harness)).length,
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
