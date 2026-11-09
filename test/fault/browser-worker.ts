/**
 * The process the browser fault suite kills: one owner message whose run opens the shop's settings in the browser (the
 * owner signed in to the shop, so opening it asks: approved once), clicks "Create key" (the page's form held: it goes
 * with their session), asks the owner to send it (approved, on the floor), and keeps the key the page then shows
 * (approved). Anonymous (`anonymous`):
 * the owner never signed in, so the form goes at once as the click's own, through the proxy by its hash, unasked. A run interrupted while it sent or kept asks to run it again, and the owner says no. The browser is
 * a fake whose site, in files, outlives a kill, while its page does not, as Chromium dies with the daemon. Prints a
 * summary as its last line.
 *
 * argv: home, `signed-in` or `anonymous`, fault schedule JSON (Fault[])
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, type TaskId } from "@earendil-works/pi-durable";
import { browserTools, keepSignedIn } from "../../src/box/browser-tools.ts";
import { ActivityLog } from "../../src/core/activity.ts";
import { LEAD } from "../../src/core/agents.ts";
import { OWNER } from "../../src/core/gateway.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context } from "../../src/core/store.ts";
import type { TurnResult } from "../../src/core/turn.ts";
import { keepEgressCredential } from "../../src/home.ts";
import { openConnected } from "../fixtures/connected.ts";
import { fakeBrowser, SHOP } from "../fixtures/fake-browser.ts";
import { answerNudge } from "../fixtures/models.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";
import { ownerAnswer } from "./owner.ts";

const [home, mode, scheduleJson] = process.argv.slice(2) as [string, "signed-in" | "anonymous", string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const fault = (point: string) => faults.hit(point as FaultPoint);

const text = (m: { content: unknown }) =>
	typeof m.content === "string"
		? m.content
		: (m.content as { type: string; text?: string }[]).map((p) => p.text ?? "").join("");
// the model: open the settings, click its button, ask to send what the page held, keep the key it shows; then done
const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
	faults.hit("model");
	const heed = answerNudge(ctx.messages);
	if (heed !== undefined) return heed;
	const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
	const results = ctx.messages.slice(after).filter((m) => m.role === "toolResult");
	const last = results.length === 0 ? "" : text(results.at(-1)!);
	const plan: [string, Record<string, unknown>][] = [
		["browser_navigate", { url: `${SHOP}/settings` }],
		["browser_click", { ref: /\[ref=(s\d+e\d+)\]/.exec(last)?.[1] ?? "s1e1" }],
		...(mode === "anonymous"
			? []
			: ([["browser_send", { write: /\(write (w\d+)\)/.exec(last)?.[1] ?? "w1" }]] as [
					string,
					Record<string, unknown>,
				][])),
		["propose_key", { key: "k1", host: "api.shop.example", prefix: "Bearer " }],
	];
	const step = plan[results.length];
	if (step === undefined) return fauxAssistantMessage("Done.");
	return fauxAssistantMessage([fauxToolCall(step[0], step[1] as never, { id: `c${results.length}` })], {
		stopReason: "toolUse",
	});
};

const browser = fakeBrowser(home, fault);
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
					egress: {
						take: async () => ({ held: [], reads: [], readBytes: 0 }),
						ack: async () => {},
						replay: async () => ({ refused: "not here" }),
						pass: async () => {},
					},
					effect: core.effect,
					ask: core.ask,
					keep: async (key, place) => {
						if ("connection" in place) throw new Error("no connections here");
						await keepEgressCredential(home, {
							host: place.host,
							header: place.header,
							value: `${place.prefix ?? ""}${key}`,
						});
					},
					giveBack: async () => {},
					fault,
				}),
			}),
		),
});

// the owner signed in to the shop in the lead's browser before: its session goes with what the page writes there
if (mode === "signed-in") await s.harness.commit((tx) => keepSignedIn(tx, LEAD, "shop.example", 0, 1), context);

const received = await s.core.receive(s.harness, {
	id: "m1",
	origin: { gateway: "fake", peer: OWNER },
	text: "make me a key at the shop",
});
if (!("turn" in received)) throw new Error(`the message started no Turn: ${JSON.stringify(received)}`);
const ended = s.harness.waitForTask(received.turn as TaskId<TurnResult>, context).then(() => true);
const web = { gateway: "web", peer: OWNER };
while (!(await Promise.race([ended, new Promise<false>((r) => setTimeout(r, 10, false))]))) {
	for (const wait of await openWaits(s.harness)) {
		if (wait.ask.type !== "approval") continue;
		faults.hit("answer");
		const again = wait.ask.interrupted === true;
		appendFileSync(join(home, "answers.txt"), `${again ? "no-again" : `approve ${wait.ask.tool}`}\n`);
		await ownerAnswer(s.harness, wait.key, again ? "deny" : "approve", web, "bearer");
	}
}

const outcome = (await s.harness.getTask(received.turn as TaskId<TurnResult>, context))?.state.outcome;
const { parked } = await status(s.harness);
const read = (name: string) =>
	readFileSync(join(home, name), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean);
console.log(
	JSON.stringify({
		outcome,
		parked,
		answers: read("answers.txt"),
		sent: read("page-sent.jsonl").length,
		open: (await openWaits(s.harness)).length,
		commits: faults.hits("commit:after"),
		activity: ((await s.harness.snapshot(ActivityLog, context))?.events ?? []).map((event) => event.what),
	}),
);
browser.close();
await s.close();
