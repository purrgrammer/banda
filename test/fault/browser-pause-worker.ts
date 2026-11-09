/**
 * The process the browser's pause suite kills: the owner holds the browser when a message's run opens the shop's
 * settings, so the call waits for them; they give the browser back once its ask shows, and the run reads the page and
 * ends. A kill takes the browser down with the process (its page, and the owner's hold, as Chromium's would); the owner
 * still holding it, they take it again as the process comes back, until they gave it back. Prints a summary as its last
 * line.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, type TaskId } from "@earendil-works/pi-durable";
import { browserTools, giveBrowserBack } from "../../src/box/browser-tools.ts";
import { OWNER } from "../../src/core/gateway.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context } from "../../src/core/store.ts";
import type { TurnResult } from "../../src/core/turn.ts";
import { openConnected } from "../fixtures/connected.ts";
import { fakeBrowser, SHOP } from "../fixtures/fake-browser.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const fault = (point: string) => faults.hit(point as FaultPoint);
const log = (event: object) =>
	appendFileSync(join(home, "page-log.jsonl"), `${JSON.stringify({ pid: process.pid, ...event })}\n`);

const text = (m: { content: unknown }) =>
	typeof m.content === "string"
		? m.content
		: (m.content as { type: string; text?: string }[]).map((p) => p.text ?? "").join("");
// the model: open the settings, then read the page; then done. Each result it reads is kept by its step.
const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
	faults.hit("model");
	const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
	const results = ctx.messages.slice(after).filter((m) => m.role === "toolResult");
	if (results.length > 0) log({ step: results.length - 1, result: text(results.at(-1)!) });
	const plan: [string, Record<string, unknown>][] = [
		["browser_navigate", { url: `${SHOP}/settings` }],
		["browser_snapshot", {}],
	];
	const step = plan[results.length];
	if (step === undefined)
		return results.length === plan.length
			? fauxAssistantMessage([fauxToolCall("message_user", { text: "Done." })], { stopReason: "toolUse" })
			: fauxAssistantMessage("Done.");
	return fauxAssistantMessage([fauxToolCall(step[0], step[1] as never, { id: `c${results.length}` })], {
		stopReason: "toolUse",
	});
};

const browser = fakeBrowser(home, fault);
const gaveBack = join(home, "gave-back");
// the owner holds the browser until they gave it back, also once a kill took it down with the process
if (!existsSync(gaveBack)) await browser.hold(true);
const s = await openConnected({
	home,
	respond: respond as never,
	wrapStorage: (storage) => faults.storage(storage),
	fault,
	install: (core, registry) =>
		registry.install(
			defineExtension({
				name: "banda.browser",
				tools: browserTools({
					browser: async () => browser,
					effect: core.effect,
					ask: core.ask,
					keep: async () => {
						throw new Error("no keys here");
					},
					giveBack: () => giveBrowserBack(s.harness, browser, fault),
					fault,
				}),
			}),
		),
});

const received = await s.core.receive(s.harness, {
	id: "m1",
	origin: { gateway: "fake", peer: OWNER },
	text: "open the shop's settings",
});
if (!("turn" in received)) throw new Error(`the message started no Turn: ${JSON.stringify(received)}`);
const turn = received.turn;
const ended = s.harness.waitForTask(turn as TaskId<TurnResult>, context).then(() => true);
while (!(await Promise.race([ended, new Promise<false>((r) => setTimeout(r, 10, false))]))) {
	for (const wait of await openWaits(s.harness)) {
		if (wait.ask.type !== "question" || wait.ask.handOver?.taken !== true) continue;
		// the call waits: the owner gives the browser back
		faults.hit("answer");
		appendFileSync(gaveBack, "1");
		log({ gaveBack: true });
		await giveBrowserBack(s.harness, browser, fault);
	}
}

const outcome = (await s.harness.getTask(turn as TaskId<TurnResult>, context))?.state.outcome;
const { parked } = await status(s.harness);
console.log(
	JSON.stringify({
		outcome,
		parked,
		log: readFileSync(join(home, "page-log.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
		open: (await openWaits(s.harness)).length,
		commits: faults.hits("commit:after"),
	}),
);
browser.close();
await s.close();
