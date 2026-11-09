/**
 * The process the routine fault suite kills: two routines on a clock that only this worker moves, one minute at a time, kept in
 * `<home>/clock` so every process opens the store on the same time. `tick` and `price` run every minute. What each run
 * says is sent. The clock moves only once both routines fired for the minute and nothing else runs, so no run is ever
 * still going at the next due time. The echo model passes the `model` point; the fake gateway's sends, `send:before`
 * and `send:after`. Prints what happened as its last line.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ConversationId, createRegistry, type SetTimer, type TaskId } from "@earendil-works/pi-durable";
import { Accepted, shaOf } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";

import { Routines, routinePath, WAKE, type WakeData } from "../../src/core/routines.ts";
import { status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, Routes, type TurnResult } from "../../src/core/turn.ts";
import { echoModels, FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);

const MINUTE = 60_000;
const START = new Date(2026, 10, 2, 8, 0).getTime();
const MINUTES = 4;

const clockFile = join(home, "clock");
let now = (() => {
	try {
		return Number(readFileSync(clockFile, "utf8"));
	} catch {
		return START;
	}
})();
const setTimer: SetTimer = (callback, delay, { background }) => {
	const timer = setTimeout(callback, Math.max(0, Math.min(delay, 5)));
	if (background) timer.unref();
	return () => clearTimeout(timer);
};

let sends = 0;
const gateway: Gateway = {
	name: "fake",
	strength: "bearer",
	can: { buttons: false, files: false, threads: true },
	start() {},
	async send(to, out) {
		faults.hit("send:before");
		appendFileSync(join(home, "sent.jsonl"), `${JSON.stringify({ to, out })}\n`);
		faults.hit("send:after");
		return `out-${process.pid}-${++sends}`;
	},
};
const core = defineCore({
	blobs: new BlobStore(join(home, "blobs")),
	gateway: () => gateway,
	model: () => FAUX_MODEL,
	retryDelay: () => 5,
	now: () => now,
	agentOrigin: (agent) => ({ gateway: "fake", peer: OWNER, thread: `agent:${agent}` }),
});
const { models } = echoModels(faults);
const registry = createRegistry();
registry.install(core.extension);
const harness = await openStore(home, {
	models,
	registry,
	now: () => now,
	setTimer,
	wrapStorage: (storage) => faults.storage(storage),
});
harness.resume();

const files = {
	tick: "---\ndescription: Tick\nevery: 1m\n---\nSay tick.\n",
	price: "---\ndescription: Price\nevery: 1m\n---\nSay the price.\n",
};
// as the owner allows them, once
await harness.commit(async (tx) => {
	const accepted = (await tx.doc(Accepted)).files;
	const { routines } = await tx.doc(Routines);
	for (const [name, text] of Object.entries(files)) {
		if (accepted[routinePath(name)] !== undefined) continue;
		accepted[routinePath(name)] = { sha: shaOf(text), text, at: START };
		routines[name] = { ...routines[name], since: START };
	}
}, context);
// as the daemon does on start
await core.reconcile(harness);

const settled = async () => {
	const { routines } = (await harness.snapshot(Routines, context)) ?? { routines: {} };
	if (!Object.keys(files).every((name) => (routines[name]?.fired ?? START) >= now)) return false;
	const graph = await harness.taskGraph(context);
	const busy = Object.values(graph.value.tasks).some((task) => task.kind !== "banda.routine");
	graph.dispose();
	return !busy;
};
for (;;) {
	while (!(await settled())) await new Promise((r) => setTimeout(r, 5));

	if (now >= START + MINUTES * MINUTE) break;
	now += MINUTE;
	writeFileSync(clockFile, String(now));
}

const routes: Record<string, { chat: number }> = (await harness.snapshot(Routes, context))?.routes ?? {};
const wakes: (WakeData & { turn: string })[] = [];
for (const { chat } of Object.values(routes)) {
	const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
		{ order: "ascending" },
		1000,
		undefined,
		context,
	);
	for (const entry of page.items) if (entry.kind === WAKE) wakes.push({ ...(entry.data as WakeData), turn: "" });
}
const turns = await harness.commit(async (tx) => {
	const found = [];
	let cursor: Parameters<typeof tx.scanTasks>[2];
	do {
		const page = await tx.scanTasks({ kind: "banda.turn" }, 100, cursor);
		found.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return found.map((task) => (task.state as { outcome?: { status: string; result?: TurnResult } }).outcome);
}, context);

const routines = (await harness.snapshot(Routines, context))?.routines ?? {};
const live = await Promise.all(
	Object.values(routines).map(async (record) =>
		record.task === undefined ? "none" : (await harness.getTask(record.task as TaskId, context))?.state.status,
	),
);
const sent = readFileSync(join(home, "sent.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean);

console.log(
	JSON.stringify({
		wakes,
		turns,

		sent: sent.map((line) => JSON.parse(line).out.text as string),

		live,
		parked: (await status(harness)).parked,
		commits: faults.hits("commit:after"),
		models: faults.hits("model"),
	}),
);
await harness.close(context);
