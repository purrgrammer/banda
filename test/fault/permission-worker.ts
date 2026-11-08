/**
 * The process the permission fault suite kills: three owner messages, each a run that calls an unsafe effect, `send` to Ana.
 * The first asks, and the owner approves it with a permission for always; the second runs within the permission, unasked; then
 * the owner revokes it, so the third asks again, and the owner denies it. A run interrupted by a kill asks to run again,
 * and the owner says yes. Every step is safe to repeat, as the worker does it again from the start in each process; it
 * prints a summary as its last line. The effect appends each run to `<home>/runs.jsonl`, so runs survive a kill.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, defineExtension, type TaskId } from "@earendil-works/pi-durable";
import { ActivityLog } from "../../src/core/activity.ts";
import { EFFECT } from "../../src/core/ask.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { openPermissions, Permissions, revoke } from "../../src/core/permissions.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { isMessageTool } from "../../src/core/toolsets.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import { revive, WAIT, type WaitEnded } from "../../src/core/wait.ts";
import { answerNudge, FAUX_MODEL } from "../fixtures/models.ts";
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
const send = core.effect({
	name: "send",
	description: "send a message",
	parameters: Type.Object({ to: Type.String(), body: Type.String() }),
	effect: "unsafe",
	describe: (args) => `send a message to ${args.to}`,
	editable: ["body"],
	permission: { args: ["to"], what: (args) => `send messages to ${args.to}` },
	run: async (args) => {
		appendFileSync(join(home, "runs.jsonl"), `${JSON.stringify(args)}\n`);
		faults.hit("effect");
		return { output: [{ type: "text", text: `sent ${args.body}` }] };
	},
});
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// the message `send <n>` calls send with body n; once its result is in, the run ends
const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
	const heed = answerNudge(ctx.messages);
	if (heed !== undefined) return heed;
	const last = ctx.messages.at(-1);
	if (last?.role !== "user") return fauxAssistantMessage("Done.");
	const body = String(last.content).replace(/^send /, "");
	return fauxAssistantMessage([fauxToolCall("send", { to: "ana", body }, { id: `c${body}` })], {
		stopReason: "toolUse",
	});
};
faux.setResponses(Array.from({ length: 100 }, () => respond as never));
const registry = createRegistry();
registry.install(core.extension);
registry.install(defineExtension({ name: "test", tools: [send] }));
const harness = await openStore(home, { models, registry, wrapStorage: (storage) => faults.storage(storage) });
// as the daemon does on start
await revive(harness);
harness.resume();

const web = { gateway: "web", peer: OWNER };
/**
 * Say `send <n>` for each of `ns` at once, each in a thread of its own, and answer their asks as the owner would until
 * their Turns end. The asks of 4 and 5 are allowed together, as the app's "allow all" does: one answer each, the same
 * scope, one by one; an ask the first answer's permission already answered is refused, and that is fine.
 */
async function say(...ns: number[]) {
	const chats = [];
	const turns = [];
	for (const n of ns) {
		const received = await core.receive(harness, {
			id: `m${n}`,
			origin: { gateway: "fake", peer: OWNER, ...(ns.length > 1 ? { thread: `t${n}` } : {}) },
			text: `send ${n}`,
		});
		if (!("turn" in received)) throw new Error(`the message started no Turn: ${JSON.stringify(received)}`);
		chats.push(received.chat);
		turns.push(harness.waitForTask(received.turn as TaskId<TurnResult>, context));
	}
	const ended = Promise.all(turns).then(() => true);
	while (!(await Promise.race([ended, new Promise<false>((r) => setTimeout(r, 10, false))]))) {
		for (const wait of await openWaits(harness)) {
			if (wait.ask.type !== "approval") continue;
			faults.hit("answer");
			const first = wait.ask.interrupted !== true;
			const { body } = wait.ask.args;
			if (first && body === "3") await ownerAnswer(harness, wait.key, "deny", web, "bearer");
			else if (first && (body === "1" || body === "4" || body === "5"))
				await ownerAnswer(harness, wait.key, "approve", web, "bearer", {
					approving: { permission: { scope: "always" } },
				});
			else await ownerAnswer(harness, wait.key, "approve", web, "bearer");
		}
	}
	return chats;
}

const revokeAll = async () => {
	for (const { id } of await openPermissions(harness, Date.now())) {
		faults.hit("revoke");
		await revoke(harness, id, Date.now());
	}
};
const [chat] = await say(1);
await say(2);
await revokeAll();
await say(3);
const others = await say(4, 5);
await revokeAll();

const items = [];
for (const id of [chat, ...others])
	items.push(
		...(
			await (await harness.conversation(id as ConversationId, context))!.entries(
				{ order: "ascending" },
				1000,
				undefined,
				context,
			)
		).items,
	);
const page = { items };
const waits = page.items.filter((e) => e.kind === WAIT).map((e) => e.data as unknown as WaitEnded);
const effects = page.items.filter((e) => e.kind === EFFECT).length;
const runs = readFileSync(join(home, "runs.jsonl"), { encoding: "utf8", flag: "a+" })
	.split("\n")
	.filter(Boolean)
	.map((line) => (JSON.parse(line) as { body: string }).body);
// the send's results: a speaking tool's (a reaction the nudge asked for, a message) is not one
const results = page.items.filter(
	(e) =>
		e.kind === "pi.tool-result" && !isMessageTool((e.model?.[0] as { toolName?: string } | undefined)?.toolName ?? ""),
).length;
const { parked } = await status(harness);
const activity = (await harness.snapshot(ActivityLog, context))?.events.map((event) => event.what) ?? [];
const permissions = Object.keys((await harness.snapshot(Permissions, context))?.permissions ?? {});
console.log(
	JSON.stringify({
		waits,
		effects,
		runs,
		results,
		parked,
		activity,
		permissions,
		open: (await openWaits(harness)).length,
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
