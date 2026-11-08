/**
 * The process the egress fault suite kills. The owner says "send" twice in one chat. Each run calls `bash`,
 * after which the daemon takes what the proxy held: the first time, one POST (and the chat's first read). The
 * model asks with `propose_send`; the chat read from outside, so the ask offers only its host, and the owner approves it,
 * allowing the host. The second run holds the same route again: it runs within that permission, unasked; had a kill
 * kept the permission from being given, it asks, and the owner approves. A run interrupted by a kill asks to run again, and the
 * owner says yes. Every step is safe to repeat, as the worker
 * does it again from the start in each process; it prints a summary as its last line.
 *
 * The proxy is a fake that keeps its state in files under the home, so a kill loses nothing it held: what it holds
 * (`proxy.json`) and every request it sent (`sends.jsonl`).
 *
 * The first command also finds a write the proxy sent straight through under a host permission: the store logs it
 * once, whatever was killed.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, defineExtension, type TaskId } from "@earendil-works/pi-durable";
import { openBox } from "../../src/box/box.ts";
import { boxEnv, boxTools } from "../../src/box/tools.ts";
import { ActivityLog } from "../../src/core/activity.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import {
	type EgressControl,
	type HeldRequest,
	proposeSendTool,
	type Replayed,
	Sent,
	type SentRequest,
	type Taken,
	Tickets,
} from "../../src/core/egress.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { Permissions } from "../../src/core/permissions.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import { revive, WAIT, type WaitEnded } from "../../src/core/wait.ts";
import { hostBox } from "../fixtures/host-box.ts";
import { answerNudge, FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";
import { ownerAnswer } from "./owner.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const fault = (point: string) => faults.hit(point as FaultPoint);

type ProxyState = { held: { [round: string]: HeldRequest[] }; taken: string[]; reads: string[] };

/** A request of round `round` (1 or 2): the same route, another id. */
const request = (round: number): HeldRequest => ({
	ticket: `t00000000${round}0`,
	chat: 0,
	at: Date.now(),
	method: "POST",
	scheme: "https",
	host: "api.example.com",
	port: 443,
	path: `/v1/issues/${round}/comments`,
	headers: [
		["Host", "api.example.com"],
		["Content-Type", "text/plain"],
	],
	body: Buffer.from(`body ${round}`).toString("base64"),
});

/** A write the proxy sent straight through in round 1, under a host permission. */
const SENT: SentRequest = {
	id: "s0000000001",
	chat: 0,
	at: 1,
	method: "POST",
	scheme: "https",
	host: "git.example.com",
	port: 443,
	path: "/me/repo.git/git-receive-pack",
	hash: "ab".repeat(32),
	bytes: 120,
	status: 200,
};

const statePath = join(home, "proxy.json");
if (!existsSync(statePath))
	writeFileSync(
		statePath,
		JSON.stringify({
			held: { 1: [request(1)], 2: [request(2)] },
			taken: [],
			reads: ["example.com"],
		} satisfies ProxyState),
	);
const read = () => JSON.parse(readFileSync(statePath, "utf8")) as ProxyState;
const write = (state: ProxyState) => writeFileSync(statePath, JSON.stringify(state));
/** The round the next command belongs to: the first whose request the daemon has not taken yet. */
const roundOf = (state: ProxyState) => (state.taken.includes(request(1).ticket) ? 2 : 1);

const proxy: EgressControl = {
	async take(chat): Promise<Taken> {
		const state = read();
		const round = roundOf(state);
		const held = (state.held[round] ?? []).filter((h) => !state.taken.includes(h.ticket)).map((h) => ({ ...h, chat }));
		const reads = round === 1 ? state.reads : [];
		const sent = round === 1 && !state.taken.includes(SENT.id) ? [{ ...SENT, chat }] : [];
		return { held, sent, reads, readBytes: reads.length };
	},
	async ack(_chat, _readBytes, tickets) {
		const state = read();
		write({
			...state,
			taken: [...new Set([...state.taken, ...tickets])],
			reads: roundOf(state) === 1 ? [] : state.reads,
		});
	},
	async replay(held): Promise<Replayed> {
		appendFileSync(join(home, "sends.jsonl"), `${JSON.stringify(held)}\n`);
		return { status: 200, reason: "OK", headers: [], body: Buffer.from("ok").toString("base64") };
	},
};

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
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
let n = 0;
const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
	const heed = answerNudge(ctx.messages);
	if (heed !== undefined) return heed;
	const last = ctx.messages.at(-1);
	const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
	n += 1;
	if (last?.role === "user")
		return fauxAssistantMessage([fauxToolCall("bash", { command: "true" }, { id: `b${n}` })], {
			stopReason: "toolUse",
		});
	const ticket = /\(ticket (t[0-9a-f]{10})\)/.exec(text)?.[1];
	if (last?.role === "toolResult" && ticket !== undefined)
		return fauxAssistantMessage([fauxToolCall("propose_send", { ticket }, { id: `r${n}` })], {
			stopReason: "toolUse",
		});
	return fauxAssistantMessage("Done.");
};
faux.setResponses(Array.from({ length: 200 }, () => respond as never));
const box = openBox(hostBox(home), () => {});
const registry = createRegistry();
registry.install(core.extension);
registry.install(boxTools({ egress: proxy, fault }));
registry.install(defineExtension({ name: "effects", tools: [core.effect(proposeSendTool(proxy, fault))] }));
const harness = await openStore(home, {
	models,
	registry,
	env: boxEnv(box),
	wrapStorage: (storage) => faults.storage(storage),
});
await revive(harness);
harness.resume();

const web = { gateway: "web", peer: OWNER };
/** Say "send", and answer its asks as the owner would until its Turn ends. */
async function say(id: string) {
	const received = await core.receive(harness, { id, origin: { gateway: "fake", peer: OWNER }, text: "send" });
	if (!("turn" in received)) throw new Error(`the message started no Turn: ${JSON.stringify(received)}`);
	const ended = harness.waitForTask(received.turn as TaskId<TurnResult>, context).then(() => true);
	while (!(await Promise.race([ended, new Promise<false>((r) => setTimeout(r, 10, false))]))) {
		for (const wait of await openWaits(harness)) {
			if (wait.ask.type !== "approval") continue;
			faults.hit("answer");
			// the owner allows the first request's host where the ask offers it (a run again offers nothing), and
			// approves anything else once
			const first =
				wait.ask.interrupted !== true &&
				wait.ask.args._ticket === request(1).ticket &&
				(wait.ask.scopes ?? []).some((offered) => offered.scope === "host");
			await ownerAnswer(
				harness,
				wait.key,
				"approve",
				web,
				"bearer",
				first ? { approving: { permission: { scope: "host" } } } : {},
			);
		}
	}
	return received.chat;
}

const chat = await say("m1");
await say("m2");

const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
	{ order: "ascending" },
	1000,
	undefined,
	context,
);
const waits = page.items.filter((e) => e.kind === WAIT).map((e) => e.data as unknown as WaitEnded);
const sends = readFileSync(join(home, "sends.jsonl"), { encoding: "utf8", flag: "a+" })
	.split("\n")
	.filter(Boolean)
	.map((line) => (JSON.parse(line) as HeldRequest).ticket);
const { parked } = await status(harness);
console.log(
	JSON.stringify({
		waits,
		sends,
		results: page.items.filter((e) => e.kind === "pi.tool-result").length,
		tickets: Object.keys((await harness.snapshot(Tickets, context))?.tickets ?? {}).sort(),
		sent: Object.keys((await harness.snapshot(Sent, context))?.sent ?? {}),
		chat,
		permissions: Object.keys((await harness.snapshot(Permissions, context))?.permissions ?? {}).length,
		activity: (await harness.snapshot(ActivityLog, context))?.events.map((e) => e.what) ?? [],
		parked,
		open: (await openWaits(harness)).length,
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
box.close();
