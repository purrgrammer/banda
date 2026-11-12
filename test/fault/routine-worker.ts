/**
 * The process the routine fault suite kills: the owner's own actions on a routine. A routine runs every day at 16:00;
 * the owner moves it to weekdays at 08:00 (the store accepts the new text, then the box gets it, through `when:before`
 * and `when:after`), then runs it now (one click, its key `k1`, sent again after a kill as a client retries). Each
 * process does what is not yet in effect, as the owner would look and click again, and finishes an edit a kill cut
 * short as the daemon does on start. The clock never moves, so nothing is due: every run is the owner's. The echo
 * model's requests pass `model`; the eager routine's message, `send:before` and `send:after`. Then the owner makes a
 * routine of their own from the panel (`brief`, written into the box through the same points). Prints what happened.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ConversationId, createRegistry, type SetTimer, type TaskId } from "@earendil-works/pi-durable";
import { openBox } from "../../src/box/box.ts";
import { boxEnv, boxTools } from "../../src/box/tools.ts";
import { Accepted, shaOf } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { Routines, routinePath, WAKE, type WakeData } from "../../src/core/routines.ts";
import { status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, Routes, type TurnResult } from "../../src/core/turn.ts";
import type { Workspace } from "../../src/server/agents.ts";
import { changeWhen, createRoutine, finishEdits } from "../../src/server/routines.ts";
import { hostBox } from "../fixtures/host-box.ts";
import { echoModels, FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);

/** Monday 2 November 2026, 09:00: the routine's next 16:00 is today, the edited one's 08:00 tomorrow. */
const NOW = new Date(2026, 10, 2, 9, 0).getTime();
const OLD = "---\ndescription: Tea time\ncron: 0 16 * * *\nruns_a_day: 5\n---\nRemind the owner to drink tea.\n";
const EDIT = "cron 0 8 * * 1-5";

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
	async send(_to, out) {
		faults.hit("send:before");
		appendFileSync(join(home, "sent.jsonl"), `${JSON.stringify(out.text ?? "")}\n`);
		faults.hit("send:after");
		return `out-${process.pid}-${++sends}`;
	},
};

const box = openBox(hostBox(home), () => {});
const path = `${box.workspace}/${routinePath("tea")}`;
const briefPath = `${box.workspace}/${routinePath("brief")}`;
const workspace: Workspace = {
	// the owner's edit reaching the box passes `when:before` and `when:after`
	env: () =>
		new Proxy(box.env(), {
			get: (target, property) => {
				const value = Reflect.get(target, property, target) as unknown;
				if (typeof value !== "function") return value;
				if (property !== "writeFile") return value.bind(target);
				return async (to: string, text: string, ...rest: unknown[]) => {
					const edit = (to === path && text.includes("cron: 0 8 * * 1-5")) || to === briefPath;
					if (edit) faults.hit("when:before");
					const written = await (value as (...args: unknown[]) => Promise<unknown>).call(target, to, text, ...rest);
					if (edit) faults.hit("when:after");
					return written;
				};
			},
		}),
	root: box.workspace,
	tools: () => [],
	known: () => true,
};

const core = defineCore({
	blobs: new BlobStore(join(home, "blobs")),
	gateway: () => gateway,
	model: () => FAUX_MODEL,
	retryDelay: () => 5,
	now: () => NOW,
	agentOrigin: (agent) => ({ gateway: "fake", peer: OWNER, thread: `agent:${agent}` }),
});
const { models } = echoModels(faults);
const registry = createRegistry();
registry.install(core.extension);
registry.install(boxTools({ box }));
const harness = await openStore(home, {
	models,
	registry,
	env: boxEnv(box),
	now: () => NOW,
	setTimer,
	wrapStorage: (storage) => faults.storage(storage),
});
harness.resume();

// the routine, allowed once: its file in the box and the store, and it speaks now
if ((await harness.snapshot(Accepted, context))?.files[routinePath("tea")] === undefined) {
	const env = box.env();
	await env.createDir(`${box.workspace}/routines`, { recursive: true }, context);
	await env.writeFile(path, OLD, context);
	await harness.commit(async (tx) => {
		(await tx.doc(Accepted)).files[routinePath("tea")] = { sha: shaOf(OLD), text: OLD, at: NOW };
		(await tx.doc(Routines)).routines.tea = { since: NOW };
	}, context);
}
// as the daemon does on start
await core.reconcile(harness);
await finishEdits(harness, workspace);

// the owner moves it, while the version they see is still the old one
if ((await harness.snapshot(Accepted, context))?.files[routinePath("tea")]?.sha === shaOf(OLD))
	await changeWhen(harness, workspace, core.reconcile, "tea", EDIT, shaOf(OLD), NOW);
// and runs it now: the same click, sent again after a kill
await core.runRoutine(harness, "tea", "k1");
// and makes one of their own from the panel, unless the store holds it already
if ((await harness.snapshot(Accepted, context))?.files[routinePath("brief")] === undefined)
	await createRoutine(
		harness,
		workspace,
		core.reconcile,
		{ agent: "sancho", description: "Brief", when: "cron 0 7 * * *", ask: "Tell the owner what is on today." },
		NOW,
	);

const idle = async () => {
	const graph = await harness.taskGraph(context);
	const busy = Object.values(graph.value.tasks).some((task) => task.kind !== "banda.routine");
	graph.dispose();
	return !busy;
};
while (!(await idle())) await new Promise((r) => setTimeout(r, 5));

const routes: Record<string, { chat: number }> = (await harness.snapshot(Routes, context))?.routes ?? {};
const wakes: WakeData[] = [];
for (const { chat } of Object.values(routes)) {
	const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
		{ order: "ascending" },
		1000,
		undefined,
		context,
	);
	for (const entry of page.items) if (entry.kind === WAKE) wakes.push(entry.data as WakeData);
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
const record = (await harness.snapshot(Routines, context))?.routines.tea ?? {};
const task = record.task === undefined ? undefined : await harness.getTask(record.task as TaskId, context);
console.log(
	JSON.stringify({
		accepted: (await harness.snapshot(Accepted, context))?.files[routinePath("tea")]?.text,
		brief: {
			accepted: (await harness.snapshot(Accepted, context))?.files[routinePath("brief")]?.text,
			box: readFileSync(briefPath, "utf8"),
			record: (await harness.snapshot(Routines, context))?.routines.brief,
			names: Object.keys((await harness.snapshot(Accepted, context))?.files ?? {}).filter((each) =>
				each.startsWith("routines/"),
			),
		},
		box: readFileSync(path, "utf8"),
		record,
		task: task?.state,
		wakes,
		turns,
		sent: readFileSync(join(home, "sent.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean),
		parked: (await status(harness)).parked,
		commits: faults.hits("commit:after"),
		models: faults.hits("model"),
	}),
);
await box.close();
await harness.close(context);
