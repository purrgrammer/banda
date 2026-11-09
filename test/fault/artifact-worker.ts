/**
 * The process the artifact fault suite kills: the companion publishes `plan.md` from a box on this machine, then the
 * owner edits it and restores v1, each step done only when the store says it is not yet (as an owner reloading the
 * page would). Blobs pass `artifact:blob`, the write-back passes `artifact:write`, `artifact:aside` and
 * `artifact:written`, commits and the model their own points. It waits for every write-back to end and prints what the store, the blobs, the box and
 * the chat hold as its last line.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { openBox } from "../../src/box/box.ts";
import { boxEnv } from "../../src/box/tools.ts";
import { ARTIFACT_EDIT, Artifacts, artifactId, defineArtifacts } from "../../src/core/artifacts.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import { revive } from "../../src/core/wait.ts";
import { hostBox } from "../fixtures/host-box.ts";
import { FAUX_MODEL } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);

export const FIRST = "# Friday\n\n09:10 Porto → Lisbon\n";
export const EDITED = "# Friday\n\n09:10 Porto → Lisbon\n19:30 back, the owner's\n";

/** Blobs whose writes pass `artifact:blob` before their bytes go. */
class FaultyBlobs extends BlobStore {
	override put(bytes: Uint8Array): Promise<string> {
		faults.hit("artifact:blob");
		return super.put(bytes);
	}
}

const gateway: Gateway = {
	name: "fake",
	strength: "bearer",
	can: { buttons: false, files: false, threads: true },
	start() {},
	async send() {
		return `out-${process.pid}-${Math.random()}`;
	},
};
const box = openBox(hostBox(home), () => {});
const blobs = new FaultyBlobs(join(home, "blobs"));
const core = defineCore({ blobs, gateway: () => gateway, model: () => FAUX_MODEL });
let harness: Harness | undefined;
const library = defineArtifacts({ blobs, harness: () => harness, hit: (point) => faults.hit(point) });

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(
	Array.from({ length: 1000 }, () => (ctx: { messages: readonly { role: string }[] }) => {
		faults.hit("model");
		if (ctx.messages.at(-1)?.role !== "user") return fauxAssistantMessage("done");
		return fauxAssistantMessage(
			[
				fauxToolCall("message_user", { text: "Here is the plan." }, { id: "said" }),
				fauxToolCall("publish", { path: "plan.md", title: "Plan" }, { id: "published" }),
			],
			{ stopReason: "toolUse" },
		);
	}) as never,
);

const registry = createRegistry();
registry.install(core.extension);
registry.install(library.extension);
const open = await openStore(home, {
	models,
	registry,
	env: boxEnv(box),
	wrapStorage: (storage) => faults.storage(storage),
});
harness = open;
await revive(open);
open.resume();

const path = join(box.workspace, "plan.md");
await mkdir(box.workspace, { recursive: true });
const id = artifactId(path);
const versions = async () => (await open.snapshot(Artifacts, context))?.artifacts[id]?.versions ?? [];
// the companion made it, once: a kill while a write-back has it moved aside leaves no file there, and that is not new
if (!existsSync(path) && (await versions()).length === 0) await writeFile(path, FIRST);

// the companion publishes; a redelivery after a restart finds its Turn
const got = await core.receive(open, { id: "m0", origin: { gateway: "fake", peer: OWNER }, text: "publish the plan" });
if (!("turn" in got)) throw new Error(`no Turn: ${JSON.stringify(got)}`);
await open.waitForTask(got.turn as TaskId<TurnResult>, context);
const chat = got.chat;
// the owner edits v1, then restores it: each once the store says it has not happened
if ((await versions()).length === 1) await library.edit(open, id, EDITED, 1);
if ((await versions()).length === 2) await library.restore(open, id, 1, 2);
// every write-back ends
for (;;) {
	const { tasks } = await open.inspect(context);
	if (!tasks.some((task) => task.record.kind === "banda.artifact-write-back")) break;
	await new Promise((resolve) => setTimeout(resolve, 20));
}
const told: number[] = [];
const conversation = await open.conversation(chat as ConversationId, context);
let cursor: string | undefined;
for (;;) {
	const page = await conversation?.entries({ order: "ascending" }, 100, cursor as never, context);
	for (const entry of page?.items ?? []) if (entry.kind === ARTIFACT_EDIT) told.push((entry.data as { n: number }).n);
	cursor = (page as { next?: string } | undefined)?.next;
	if (cursor === undefined) break;
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const stored = await versions();
const { parked } = await status(open);
console.log(
	JSON.stringify({
		versions: stored.map(({ n, by, sha, box, restored }) => ({ n, by, sha, box, restored })),
		blobs: stored.map((version) => {
			try {
				return sha(readFileSync(blobs.path(version.sha)));
			} catch {
				return "missing";
			}
		}),
		box: sha(readFileSync(path)),
		// what else the box holds beside the file: a write-back's leftovers
		beside: readdirSync(box.workspace).filter((name) => name !== "plan.md"),
		told,
		parked,
		commits: faults.hits("commit:after"),
		models: faults.hits("model"),
		puts: faults.hits("artifact:blob"),
		writes: faults.hits("artifact:write"),
		asides: faults.hits("artifact:aside"),
	}),
);
box.close();
await open.close(context);
