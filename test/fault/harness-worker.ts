/**
 * The process the harness fault suite kills: one harness session with the scripted fake harness, which edits, asks the
 * owner to run a command, leaves a long command running in its group (as Claude Code's shells may) and says it is
 * done. The worker answers the ask as the owner would. The fake logs every prompt it received to `<home>/fake.jsonl`,
 * and each wake is counted in the store, so what happened survives a killed process. Prints a summary as its last line.
 *
 * With `continue`, the session goes on from an ended one instead: the fake reopens that one's own session, so the
 * follow-up is sent alone. With `v2`, the fake speaks ACP v2 and its turn ends while a background command it reports
 * runs on; with `v2stop`, the owner stops the session once its turn is over and that command still runs.
 *
 * argv: home, mark, optionally `continue`, then the fault schedule JSON (Fault[])
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry, defineDoc, defineExtension } from "@earendil-works/pi-durable";
import { answerAsk, defineHarnesses, Harnesses, steer, stopSession } from "../../src/core/harness.ts";
import { status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { echoModels } from "../fixtures/models.ts";
import { type Fault, Faults } from "./faults.ts";

// the schedule comes last (runWorker appends it): `continue`, when given, before it
const [home, mark, ...rest] = process.argv.slice(2) as [string, string, ...string[]];
const scheduleJson = rest.at(-1) ?? "[]";
const mode = rest.length > 1 ? rest[0] : undefined;
const continuing = mode === "continue";
const noting = mode === "note";
const v2 = mode === "v2" || mode === "v2stop";
if (v2) process.env.FAKE_ACP_V2 = "1";
const NOTE = "say followed up";
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const FAKE = join(import.meta.dirname, "../fixtures/fake-acp-agent.ts");
const folder = join(home, "work");
mkdirSync(folder, { recursive: true });
process.env.FAKE_ACP_LOG = join(home, "fake.jsonl");
const ASK = continuing
	? `ask npm test\nbackground ${mark}\nsay again`
	: v2
		? `edit src/a.ts +1 -0\nask npm test\nbackground ${mark}\nbg ${mode === "v2stop" ? 600_000 : 300}\nsay fixed`
		: `edit src/a.ts +1 -0\nask npm test\nbackground ${mark}\nsay fixed`;
/** The ended session a follow-up goes on from: its harness's session is what the fake reopens. */
const EARLIER = 9999;

/** Each wake of the agent, by its key: exactly one per session. */
const Woke = defineDoc<{ keys: string[] }>({
	kind: "test.woke",
	version: 1,
	scope: "session",
	initial: () => ({ keys: [] }),
	checkpointWhen: () => false,
});

const made = defineHarnesses({
	home,
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
	const found = Object.keys(doc.sessions).find((one) => Number(one) !== EARLIER);
	if (found !== undefined) return Number(found);
	const chat = Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
	if (continuing)
		doc.sessions[EARLIER] = {
			chat,
			agent: "sancho",
			harness: "fake",
			folder,
			prompt: "say first",
			state: "done",
			at: 1,
			ended: 2,
			steps: [{ kind: "asked", text: "say first" }],
			dropped: 0,
			notes: [],
			sessionId: "earlier-session",
		};
	return made.begin(tx, {
		chat,
		call: "c1",
		agent: "sancho",
		harness: "fake",
		folder,
		ask: ASK,
		...(continuing ? { continues: EARLIER } : {}),
	});
}, context);

// the owner: allows every ask it sees, until the session ends
for (;;) {
	const session = (await harness.snapshot(Harnesses, context))?.sessions[task];
	if (session?.ended !== undefined) break;
	if (noting && (session?.asks?.length ?? 0) > 0)
		await harness.commit((tx) => steer(tx, task, NOTE, Date.now(), { call: "note-1" }), context);
	for (const ask of session?.asks ?? [])
		if (session?.answers?.[ask.id] === undefined)
			await harness.commit((tx) => answerAsk(tx, task, ask.id, true), context);
	// its turn over, its background command running on: the owner stops it
	if (
		mode === "v2stop" &&
		session?.stop !== true &&
		session?.background?.foreground === "idle" &&
		session.background.items.length > 0
	)
		await harness.commit((tx) => stopSession(tx, task), context);
	await new Promise((resolve) => setTimeout(resolve, 20));
}
const session = (await harness.snapshot(Harnesses, context))?.sessions[task];
const woke = (await harness.snapshot(Woke, context))?.keys ?? [];
const log = existsSync(join(home, "fake.jsonl"))
	? readFileSync(join(home, "fake.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { prompt?: string; loaded?: string; pid: number })
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
		// a follow-up to a reopened session is sent alone, never with a recap
		prompts: log.filter((entry) => entry.prompt === ASK).length,
		notes: log.filter((entry) => entry.prompt === NOTE).length,
		loaded: log.filter((entry) => entry.loaded === "earlier-session").length,
		orphans,
		parked,
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
