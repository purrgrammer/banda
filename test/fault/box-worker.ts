/**
 * The process the box fault suite kills: one owner message whose model runs one command in a box (pi-env's daemon on
 * this machine, the tests' box). The command appends `start`, then waits for `<home>/release` and appends `done`, to
 * `<home>/runs.txt`, so runs survive a killed process. The worker releases it once the command printed, so a command
 * whose process was killed first waits on, never finishing by itself: one that outlived its process is found by its
 * mark, unique to the home, once every killed process's pi-env is gone. Prints a summary as its last line.
 *
 * argv: home, mark, fault schedule JSON (Fault[])
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type TaskId } from "@earendil-works/pi-durable";
import type { ShellExecOptions } from "@earendil-works/pi-durable/env";
import { type Box, openBox } from "../../src/box/box.ts";
import { boxEnv, boxTools } from "../../src/box/tools.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import { revive } from "../../src/core/wait.ts";
import { BOX_PIDS, hostBox } from "../fixtures/host-box.ts";
import { FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, mark, scheduleJson] = process.argv.slice(2) as [string, string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const release = join(home, "release");
const command =
	`: ${mark}; echo start >> ${home}/runs.txt; echo started; ` +
	`while [ ! -e ${release} ]; do sleep 0.02; done; echo done >> ${home}/runs.txt`;

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
const opened = openBox(hostBox(home), () => {});
// the box with its commands passing the fault points
const box: Box = {
	...opened,
	env: (cwd) => {
		const env = opened.env(cwd);
		return new Proxy(env, {
			get: (target, property) => {
				if (property !== "exec") {
					// bound: the env's methods reach its private fields through `this`, which a proxy is not
					const value = Reflect.get(target, property, target) as unknown;
					return typeof value === "function" ? value.bind(target) : value;
				}
				return (cmd: string, options: ShellExecOptions | undefined, ctx: Context) => {
					faults.hit("exec:before");
					let first = true;
					const onOutput: NonNullable<ShellExecOptions["onOutput"]> = (...args) => {
						if (first) {
							first = false;
							faults.hit("exec:output");
							// not killed while it ran: let it finish
							writeFileSync(release, "");
						}
						options?.onOutput?.(...args);
					};
					return target.exec(cmd, { ...options, onOutput }, ctx);
				};
			},
		});
	},
};
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const respond = (ctx: { messages: readonly { role: string }[] }) => {
	faults.hit("model");
	return ctx.messages.at(-1)?.role === "toolResult"
		? fauxAssistantMessage("Ran it.")
		: fauxAssistantMessage([fauxToolCall("bash", { command }, { id: "c1" })], { stopReason: "toolUse" });
};
faux.setResponses(Array.from({ length: 100 }, () => respond as never));
const registry = createRegistry();
registry.install(core.extension);
registry.install(boxTools());
const harness = await openStore(home, {
	models,
	registry,
	env: boxEnv(box),
	wrapStorage: (storage) => faults.storage(storage),
});
await revive(harness);
harness.resume();

const received = await core.receive(harness, { id: "m1", origin: { gateway: "fake", peer: OWNER }, text: "run it" });
if (!("turn" in received)) throw new Error("the message started no Turn");
await harness.waitForTask(received.turn as TaskId<TurnResult>, context);
const outcome = (await harness.getTask(received.turn as TaskId<TurnResult>, context))?.state.outcome;
const page = await (await harness.conversation(received.chat as ConversationId, context))!.entries(
	{ order: "ascending" },
	1000,
	undefined,
	context,
);
const results = page.items
	.filter((e) => e.kind === "pi.tool-result")
	.map((e) => e.model?.[0] as { isError: boolean; content: { text?: string }[] });
const runs = readFileSync(join(home, "runs.txt"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean);
// a command of a killed process that is still running: first wait for the pi-env of every killed process to be gone,
// which kills what it started when its stdin ends; then look for its mark (pgrep exits 1 when it finds none)
const gone = (pid: number) => {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
};
const pids = existsSync(join(home, BOX_PIDS)) ? readFileSync(join(home, BOX_PIDS), "utf8") : "";
const killed = pids
	.split("\n")
	.filter(Boolean)
	.map((line) => line.split(" ").map(Number) as [number, number])
	.filter(([parent]) => parent !== process.pid)
	.map(([, pid]) => pid);
while (!killed.every(gone)) await new Promise((r) => setTimeout(r, 10));
let orphans = 0;
try {
	// as the command spells it, which this process's own arguments do not
	orphans = execFileSync("pgrep", ["-f", `: ${mark};`], { encoding: "utf8" })
		.split("\n")
		.filter(Boolean).length;
} catch (error) {
	if ((error as { status?: number }).status !== 1) throw error;
}
// an orphan found is the failure, not left to run on
if (orphans > 0) execFileSync("pkill", ["-f", `: ${mark};`]);
const { parked } = await status(harness);
console.log(
	JSON.stringify({
		outcome,
		results: results.map((r) => ({ error: r.isError, text: r.content.map((c) => c.text ?? "").join("") })),
		runs,
		orphans,
		parked,
		commits: faults.hits("commit:after"),
	}),
);
opened.close();
await harness.close(context);
