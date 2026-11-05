/**
 * The process the harness fault suite kills: one harness session with the scripted fake harness, which edits, asks the
 * owner to run a command, leaves a long command running in its group (as Claude Code's shells may) and says it is
 * done. The worker answers the ask as the owner would. The fake logs every prompt it received to `<home>/fake.jsonl`,
 * and each wake is counted in the store, so what happened survives a killed process. Prints a summary as its last line.
 *
 * argv: home, mark, fault schedule JSON (Fault[])
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry, defineDoc, defineExtension } from "@earendil-works/pi-durable";
import { answerAsk, defineHarnesses, Harnesses } from "../../src/core/harness.ts";
import { status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { echoModels } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, mark, scheduleJson] = process.argv.slice(2) as [string, string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const FAKE = join(import.meta.dirname, "../fixtures/fake-acp-agent.ts");
const folder = join(home, "work");
mkdirSync(folder, { recursive: true });
process.env.FAKE_ACP_LOG = join(home, "fake.jsonl");
const ASK = `edit src/a.ts +1 -0\nask npm test\nbackground ${mark}\nsay fixed`;

/** Each wake of the agent, by its key: exactly one per session. */
const Woke = defineDoc<{ keys: string[] }>({
	kind: "test.woke",
	version: 1,
	scope: "session",
	initial: () => ({ keys: [] }),
	checkpointWhen: () => false,
});

const made = defineHarnesses({
	definitions: () =>
		new Map([
			["fake", { name: "fake", service: "Fake Code", command: process.execPath, args: [FAKE], mode: "acceptEdits" }],
		]),
	followUp: async (tx, _chat, input) => {
		(await tx.doc(Woke)).keys.push(input.key);
		return 0;
	},
	log: () => {},
	fault: (point) => faults.hit(point as never),
});
const registry = createRegistry();
registry.install(defineExtension({ name: "test.harness", tasks: [made.Session] }));
const { models } = echoModels();
const harness = await openStore(home, { models, registry, wrapStorage: (storage) => faults.storage(storage) });
await made.reconcile(harness, context);
harness.resume();

// the one session, begun once whatever process gets there first
const task = await harness.commit(async (tx) => {
	const doc = await tx.doc(Harnesses);
	const found = Object.keys(doc.sessions)[0];
	if (found !== undefined) return Number(found);
	const chat = Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
	return made.begin(tx, { chat, call: "c1", agent: "sancho", harness: "fake", folder, ask: ASK });
}, context);

// the owner: allows every ask it sees, until the session ends
for (;;) {
	const session = (await harness.snapshot(Harnesses, context))?.sessions[task];
	if (session?.ended !== undefined) break;
	if (session?.asking !== undefined && session.answer?.id !== session.asking.id) {
		const id = session.asking.id;
		await harness.commit((tx) => answerAsk(tx, task, id, true), context);
	}
	await new Promise((resolve) => setTimeout(resolve, 20));
}
const session = (await harness.snapshot(Harnesses, context))?.sessions[task];
const woke = (await harness.snapshot(Woke, context))?.keys ?? [];
const log = existsSync(join(home, "fake.jsonl"))
	? readFileSync(join(home, "fake.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { prompt?: string; pid: number })
	: [];
// what a killed process's harness left running is gone once a later process took the session over (pgrep: 1 is none)
const count = () => {
	try {
		return execFileSync("pgrep", ["-f", `: ${mark};`], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean).length;
	} catch (error) {
		if ((error as { status?: number }).status !== 1) throw error;
		return 0;
	}
};
const orphans = count();
if (orphans > 0) execFileSync("pkill", ["-f", `: ${mark};`]);
const { parked } = await status(harness);
console.log(
	JSON.stringify({
		state: session?.state,
		woke,
		prompts: log.filter((entry) => entry.prompt === ASK).length,
		orphans,
		parked,
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
