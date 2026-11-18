/**
 * The process the backoff fault suite kills once, in a model request. pi-durable 1.5 does not send again a request the
 * host died during: the next process counts it a failed attempt and retries it after `retry.baseDelayMs` on the
 * Harness clock. This worker moves that clock itself. It reports when the retry is due, holds the clock a millisecond
 * short of it (the model must not be asked), closes and opens the store again while the retry sleeps (still not
 * asked), then moves the clock to it (asked, and the run answers). Prints what it saw, as its last line.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { join } from "node:path";
import { createRegistry, LiveDoc, type SetTimer, type TaskId } from "@earendil-works/pi-durable";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import { echoModels, FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const BACKOFF = 2000;
const START = new Date(2026, 10, 2, 9, 0).getTime();
let clock = START;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// timers wake often; what is due is the clock's to say
const setTimer: SetTimer = (callback, delay, { background }) => {
	const timer = setTimeout(callback, Math.max(0, Math.min(delay, 5)));
	if (background) timer.unref();
	return () => clearTimeout(timer);
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
const core = defineCore({
	blobs: new BlobStore(join(home, "blobs")),
	gateway: () => gateway,
	model: () => FAUX_MODEL,
	retryDelay: () => 5,
});
const { models } = echoModels(faults);
const registry = createRegistry();
registry.install(core.extension);
const open = async () => {
	const harness = await openStore(home, {
		models,
		registry,
		now: () => clock,
		setTimer,
		settings: { retry: { baseDelayMs: BACKOFF } },
		wrapStorage: (storage) => faults.storage(storage),
	});
	harness.resume();
	return harness;
};
let harness = await open();
const received = await core.receive(harness, { id: "m1", origin: { gateway: "fake", peer: OWNER }, text: "hello" });
if (!("turn" in received)) throw new Error("the message started no Turn");
const chat = received.chat;
const turn = received.turn as TaskId<TurnResult>;

/** The retry the run waits on, once the generation has seen it was cut off: when it is due, and its task. */
async function retrying(): Promise<{ readonly at: number; readonly task: TaskId } | undefined> {
	for (let waited = 0; waited < 10_000; waited += 20) {
		const live = await harness.snapshot(LiveDoc, chat as never, context);
		const at = live?.generation?.retry?.at;
		if (at !== undefined && live?.run !== undefined) return { at, task: live.run.taskId };
		// a run that was never cut off answers without one
		if ((await harness.getTask(turn, context))?.state.status === "terminal") return undefined;
		await pause(20);
	}
	return undefined;
}
/** How often the model was asked in this process, and what the run's generation task is doing. */
const now = async (task: TaskId) => ({
	asked: faults.hits("model"),
	status: (await harness.getTask(task, context))?.state.status ?? "gone",
});

const retry = await retrying();
let before: Awaited<ReturnType<typeof now>> | undefined;
let restarted: Awaited<ReturnType<typeof now>> | undefined;
if (retry !== undefined) {
	// a millisecond short of the backoff's end, for longer than the timers take to look: not asked
	clock = retry.at - 1;
	await pause(300);
	before = await now(retry.task);
	// a clean restart while the retry sleeps: the sleep is durable, and still not due
	await harness.close(context);
	harness = await open();
	await pause(300);
	restarted = await now(retry.task);
	clock = retry.at;
}
const ended = await harness.waitForTask(turn, context);
const entries = (await (await harness.conversation(chat as never, context))!.entries({}, 100, undefined, context))
	.items;
console.log(
	JSON.stringify({
		delay: retry === undefined ? null : retry.at - START,
		before,
		restarted,
		after: { asked: faults.hits("model") },
		outcome: ended.state.outcome.status,
		// answers, not the cut-off attempt's aborted partial
		answers: entries.filter((entry) => {
			const message = entry.model?.[0];
			return message?.role === "assistant" && message.stopReason === "stop";
		}).length,
	}),
);
await harness.close(context);
