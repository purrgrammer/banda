/**
 * The process the Drive write fault suite kills: the owner adds Google Drive as banda ships it, allows its changes
 * by signing in with them; then one owner message whose run makes one change, which the owner approves: `create`
 * a Doc, `update` cells of a Sheet the owner has, `append` rows to one of its tabs, add text to a `doc` the owner
 * has, or `reply` to a comment on it. The fake Google, in a file of
 * the home, keeps what it applied across kills, as the real one would. A run a kill cut short runs again unasked,
 * with the same key, when the change is idempotent: a create finds the file made and makes no second, written cells
 * are written the same; appending is not, so the owner is asked again and skips it. Every step is safe to repeat, as
 * each process does them again from the start. Prints a summary as its last line.
 *
 * argv: home, mode (create, update or append), fault schedule JSON (Fault[])
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

const [home, mode, scheduleJson] = process.argv.slice(2) as [
	string,
	"create" | "update" | "append" | "doc" | "reply",
	string,
];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const shipped = join(home, "shipped");
if (!existsSync(join(shipped, "drive.json"))) {
	mkdirSync(shipped, { recursive: true });
	writeFileSync(
		join(shipped, "drive.json"),
		readFileSync(new URL("../../shipped/connections/drive.json", import.meta.url), "utf8"),
	);
}
/** The Sheet the owner has, before anything: two tabs, a budget in the first. */
const SEED = {
	s1: {
		id: "s1",
		name: "Economía",
		mimeType: "application/vnd.google-apps.spreadsheet",
		trashed: false,
		modifiedTime: "2026-11-01T09:47:37.699Z",
		tabs: ["🏠", "2027"],
		cells: {
			"🏠": [
				["ingresos", "", "gastos"],
				["6385", "", "30"],
			],
			"2027": [],
		},
	},
	d1: {
		id: "d1",
		name: "Q1 plan",
		mimeType: "application/vnd.google-apps.document",
		trashed: false,
		modifiedTime: "2026-11-05T16:42:10.000Z",
		text: "# Q1 plan\nPlatform moves first",
		comments: [{ id: "c1", content: "Dates?", resolved: false, author: { displayName: "Ana" }, replies: [] }],
	},
};
const google = fakeDrive({ file: join(home, "google-drive.json"), ...(mode === "create" ? {} : { seed: SEED }) });

// the model: after the owner's message, create the file; then done
const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
	faults.hit("model");
	const heed = answerNudge(ctx.messages);
	if (heed !== undefined) return heed;
	const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
	if (ctx.messages.slice(after).some((m) => m.role === "toolResult")) return fauxAssistantMessage("Done.");
	const call = {
		create: ["create_doc", { title: "Q1 plan", markdown: "# Plan\n\n- one" }],
		update: ["update_range", { file_id: "drive/s1", range: "🏠!C2", rows: "95" }],
		append: ["append_rows", { file_id: "drive/s1", sheet: "2027", rows: "a,b" }],
		doc: ["append_doc_text", { file_id: "drive/d1", markdown: "## Decisions\n- Payments next" }],
		reply: ["reply_comment", { file_id: "drive/d1", comment_id: "c1", text: "Added them.", resolve: true }],
	}[mode] as [string, Record<string, string | boolean>];
	return fauxAssistantMessage([fauxToolCall(`drive__${call[0]}`, call[1], { id: "c1" })], { stopReason: "toolUse" });
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
		scopes: [
			"https://www.googleapis.com/auth/drive.readonly",
			mode === "create" || mode === "reply"
				? "https://www.googleapis.com/auth/drive.file"
				: mode === "doc"
					? "https://www.googleapis.com/auth/documents"
					: "https://www.googleapis.com/auth/spreadsheets",
		],
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
		// an idempotent change is never asked again; appending rows is, and the owner skips it
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
		sheet: files.find((file) => file.id === "s1")?.cells,
		doc: files.find((file) => file.id === "d1")?.text,
		comment: (files.find((file) => file.id === "d1")?.comments as unknown[] | undefined)?.[0],
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
