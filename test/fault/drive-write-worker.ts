/**
 * The process the Drive write fault suite kills: the owner adds Google Drive as banda ships it, allows its changes
 * by signing in with them; then one owner message whose run creates a Doc, which the owner approves. The
 * fake Google, in a file of the home, keeps what it applied across kills, as the real one would. A run a kill cut
 * short runs again unasked, with the same key: its create finds the file made and makes no second. Every step is safe
 * to repeat, as each process does them again from the start. Prints a summary as its last line.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { LEAD } from "../../src/core/agents.ts";
import { OWNER } from "../../src/core/gateway.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context } from "../../src/core/store.ts";
import type { TurnResult } from "../../src/core/turn.ts";
import { openConnected } from "../fixtures/connected.ts";
import { fakeDrive } from "../fixtures/google-drive.ts";
import { answerNudge } from "../fixtures/models.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";
import { ownerAnswer } from "./owner.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const shipped = join(home, "shipped");
if (!existsSync(join(shipped, "drive.md"))) {
	mkdirSync(shipped, { recursive: true });
	writeFileSync(
		join(shipped, "drive.md"),
		readFileSync(new URL("../../shipped/connections/drive.md", import.meta.url), "utf8"),
	);
}
const google = fakeDrive({ file: join(home, "google-drive.json") });

// the model: after the owner's message, create the file; then done
const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
	faults.hit("model");
	const heed = answerNudge(ctx.messages);
	if (heed !== undefined) return heed;
	const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
	if (ctx.messages.slice(after).some((m) => m.role === "toolResult")) return fauxAssistantMessage("Done.");
	return fauxAssistantMessage(
		[fauxToolCall("drive__create_doc", { title: "Q1 plan", markdown: "# Plan\n\n- one" }, { id: "c1" })],
		{ stopReason: "toolUse" },
	);
};

const s = await openConnected({
	home,
	shipped,
	fetch: google.fetch,
	respond: respond as never,
	wrapStorage: (storage) => faults.storage(storage),
	fault: (point) => faults.hit(point as FaultPoint),
});

const shown = async () => (await s.capabilities.view()).connections.find((c) => c.name === "drive");
// what the file says now, allowed, whatever a kill left between writing it and allowing it
const allow = async () => {
	const change = (await shown())?.change;
	if (change !== undefined && "sha" in change && change.sha !== undefined)
		await s.capabilities.acceptConnection("drive", change.sha);
};
if ((await shown())?.accepted === undefined) {
	await allow();
	if ((await shown())?.accepted === undefined) await s.capabilities.addShipped("drive");
}
await allow();
if ((await shown())?.state === "sign-in") {
	const started = await s.capabilities.signIn("drive", context, LEAD, {
		scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"],
	});
	if (!("url" in started)) throw new Error("a Google sign-in opens a page");
	const signed = await s.capabilities.callback({
		state: new URL(started.url).searchParams.get("state") ?? "",
		code: "fake-code",
	});
	if (!signed.ok) throw new Error(signed.words);
}

const received = await s.core.receive(s.harness, {
	id: "m1",
	origin: { gateway: "fake", peer: OWNER },
	text: "write the Q1 plan",
});
if (!("turn" in received)) throw new Error(`the message started no Turn: ${JSON.stringify(received)}`);
const ended = s.harness.waitForTask(received.turn as TaskId<TurnResult>, context).then(() => true);
const web = { gateway: "web", peer: OWNER };
while (!(await Promise.race([ended, new Promise<false>((r) => setTimeout(r, 10, false))]))) {
	for (const wait of await openWaits(s.harness)) {
		if (wait.ask.type !== "approval") continue;
		faults.hit("answer");
		// an idempotent change is never asked again: an interrupted ask here is the failure the suite looks for
		const again = wait.ask.interrupted === true;
		appendFileSync(join(home, "answers.txt"), `${again ? "asked-again" : "approve"}\n`);
		await ownerAnswer(s.harness, wait.key, again ? "deny" : "approve", web, "bearer", { type: "approval" });
	}
}

const outcome = (await s.harness.getTask(received.turn as TaskId<TurnResult>, context))?.state.outcome;
const { parked } = await status(s.harness);
const answers = readFileSync(join(home, "answers.txt"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean);
const files = Object.values(google.files());
console.log(
	JSON.stringify({
		outcome,
		parked,
		answers,
		open: (await openWaits(s.harness)).length,
		files: files.map((file) => ({ id: file.id, name: file.name, text: file.text, trashed: file.trashed })),
		commits: faults.hits("commit:after"),
		points: Object.fromEntries(
			(["connection:call", "connection:answered", "answer", "model"] as const).map((point) => [
				point,
				faults.hits(point),
			]),
		),
	}),
);
await s.close();
