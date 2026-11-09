/**
 * The process the web_fetch fault suite kills. The owner says "read" once; the model calls `web_fetch` for a page
 * that redirects once, then is done. Each GET is appended to `gets.jsonl` as it goes; the fake proxy keeps what it saw
 * (the hosts read) in `proxy.json` until the daemon takes it, so a kill loses nothing it held. Every step is safe to
 * repeat, as the worker does it again from the start in each process; it prints a summary as its last line.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, defineExtension, type TaskId } from "@earendil-works/pi-durable";
import { type Fetched, webFetchTool } from "../../src/box/web-fetch.ts";
import { ActivityLog } from "../../src/core/activity.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import type { EgressControl, Taken } from "../../src/core/egress.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import { revive, WAIT, type WaitEnded } from "../../src/core/wait.ts";
import { answerNudge, FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";
import { ownerAnswer } from "./owner.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const fault = (point: string) => faults.hit(point as FaultPoint);

const statePath = join(home, "proxy.json");
if (!existsSync(statePath)) writeFileSync(statePath, JSON.stringify({ reads: [] }));
const read = () => JSON.parse(readFileSync(statePath, "utf8")) as { reads: string[] };

const PAGES: { [url: string]: Fetched } = {
	"https://example.com/old": { status: 301, headers: [["location", "/new"]], body: new Uint8Array(), truncated: false },
	"https://example.com/new": {
		status: 200,
		headers: [["content-type", "text/html"]],
		body: new TextEncoder().encode("<title>New</title><p>The page.</p>"),
		truncated: false,
	},
};

const proxy: EgressControl = {
	async take(): Promise<Taken> {
		const { reads } = read();
		return { held: [], reads, readBytes: reads.length };
	},
	async ack(_chat, readBytes) {
		const { reads } = read();
		writeFileSync(statePath, JSON.stringify({ reads: reads.slice(readBytes) }));
	},
	async replay() {
		throw new Error("a read never replays");
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
	n += 1;
	if (ctx.messages.at(-1)?.role === "user")
		return fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://example.com/old" }, { id: `w${n}` })], {
			stopReason: "toolUse",
		});
	return fauxAssistantMessage("Done.");
};
faux.setResponses(Array.from({ length: 200 }, () => respond as never));
const registry = createRegistry();
registry.install(core.extension);
registry.install(
	defineExtension({
		name: "web",
		tools: [
			webFetchTool({
				egress: proxy,
				fault,
				fetchOne: async (url) => {
					appendFileSync(join(home, "gets.jsonl"), `${JSON.stringify({ method: "GET", url })}\n`);
					// the proxy notes the host read as the request passes it
					const state = read();
					writeFileSync(statePath, JSON.stringify({ reads: [...state.reads, new URL(url).host] }));
					return PAGES[url] ?? { failed: "no such page" };
				},
			}),
		],
	}),
);
const harness = await openStore(home, { models, registry, wrapStorage: (storage) => faults.storage(storage) });
await revive(harness);
harness.resume();

const web = { gateway: "web", peer: OWNER };
const received = await core.receive(harness, { id: "m1", origin: { gateway: "fake", peer: OWNER }, text: "read" });
if (!("turn" in received)) throw new Error(`the message started no Turn: ${JSON.stringify(received)}`);
const ended = harness.waitForTask(received.turn as TaskId<TurnResult>, context).then(() => true);
while (!(await Promise.race([ended, new Promise<false>((r) => setTimeout(r, 10, false))]))) {
	// a run a kill interrupted may ask to run again; the owner says yes
	for (const wait of await openWaits(harness))
		if (wait.ask.type === "approval") await ownerAnswer(harness, wait.key, "approve", web, "bearer");
}

const page = await (await harness.conversation(received.chat as ConversationId, context))!.entries(
	{ order: "ascending" },
	1000,
	undefined,
	context,
);
const { parked } = await status(harness);
console.log(
	JSON.stringify({
		waits: page.items.filter((e) => e.kind === WAIT).map((e) => e.data as unknown as WaitEnded),
		results: page.items
			.filter((e) => e.kind === "pi.tool-result")
			.map((e) =>
				((e.model?.[0] as { content?: { text?: string }[] } | undefined)?.content ?? []).map((p) => p.text).join(""),
			),
		gets: readFileSync(join(home, "gets.jsonl"), { encoding: "utf8", flag: "a+" })
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { method: string; url: string }),
		activity: (await harness.snapshot(ActivityLog, context))?.events.map((e) => e.what) ?? [],
		parked,
		open: (await openWaits(harness)).length,
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
