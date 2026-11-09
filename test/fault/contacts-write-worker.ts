/**
 * The process the Contacts write fault suite kills: the owner adds Google Contacts as banda ships it, allows its changes
 * and signs in; then one owner message whose run changes the contact the fake Google starts with (`update`, `delete`) or
 * adds one (`create`), which the owner approves. The fake Google, in a file of the home, keeps what it applied across
 * kills, as the real one would. An update or a deletion a kill cut short runs again unasked and changes nothing twice;
 * an addition is not idempotent, so the owner is asked again and skips it. Every step is safe to repeat, as each
 * process does them again from the start. Prints a summary as its last line.
 *
 * argv: home, mode (update, delete or create), fault schedule JSON (Fault[])
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject, TaskId } from "@earendil-works/pi-durable";
import { LEAD } from "../../src/core/agents.ts";
import { OWNER } from "../../src/core/gateway.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context } from "../../src/core/store.ts";
import type { TurnResult } from "../../src/core/turn.ts";
import { openConnected } from "../fixtures/connected.ts";
import { fakeContacts } from "../fixtures/google-contacts.ts";
import { answerNudge } from "../fixtures/models.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";
import { ownerAnswer } from "./owner.ts";

const [home, mode, scheduleJson] = process.argv.slice(2) as [string, "update" | "delete" | "create", string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const shipped = join(home, "shipped");
if (!existsSync(join(shipped, "contacts.json"))) {
	mkdirSync(shipped, { recursive: true });
	writeFileSync(
		join(shipped, "contacts.json"),
		readFileSync(new URL("../../shipped/connections/contacts.json", import.meta.url), "utf8"),
	);
}
const google = fakeContacts({
	file: join(home, "google-contacts.json"),
	seed: {
		"people/c111": { resourceName: "people/c111", etag: "e0", names: [{ givenName: "Ana", familyName: "García" }] },
	},
});

// the model: after the owner's message, make the change; then done
const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
	faults.hit("model");
	const heed = answerNudge(ctx.messages);
	if (heed !== undefined) return heed;
	const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
	if (ctx.messages.slice(after).some((m) => m.role === "toolResult")) return fauxAssistantMessage("Done.");
	const call = {
		update: ["update_contact", { contact_id: "pc111", title: "Head of Design" }],
		delete: ["delete_contact", { contact_id: "pc111" }],
		create: ["create_contact", { name: "Bo Díaz", emails: ["bo@example.test"] }],
	}[mode] as [string, JsonObject];
	return fauxAssistantMessage([fauxToolCall(`contacts__${call[0]}`, call[1], { id: "c1" })], { stopReason: "toolUse" });
};

const s = await openConnected({
	home,
	shipped,
	fetch: google.fetch,
	respond: respond as never,
	wrapStorage: (storage) => faults.storage(storage),
	fault: (point) => faults.hit(point as FaultPoint),
});

const shown = async () => (await s.capabilities.view()).connections.find((c) => c.name === "contacts");
if ((await shown())?.accepted === undefined) await s.capabilities.addShipped("contacts");
if ((await shown())?.state === "sign-in") {
	const started = await s.capabilities.signIn("contacts", context, LEAD, {
		scopes: [
			"https://www.googleapis.com/auth/contacts.readonly",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/contacts",
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
	text: "keep my contacts tidy",
});
if (!("turn" in received)) throw new Error(`the message started no Turn: ${JSON.stringify(received)}`);
const ended = s.harness.waitForTask(received.turn as TaskId<TurnResult>, context).then(() => true);
const web = { gateway: "web", peer: OWNER };
while (!(await Promise.race([ended, new Promise<false>((r) => setTimeout(r, 10, false))]))) {
	for (const wait of await openWaits(s.harness)) {
		if (wait.ask.type !== "approval") continue;
		faults.hit("answer");
		// an idempotent change is never asked again; an addition is, and the owner skips it
		const again = wait.ask.interrupted === true;
		appendFileSync(join(home, "answers.txt"), `${again ? "asked-again" : "approve"}\n`);
		await ownerAnswer(s.harness, wait.key, again ? "deny" : "approve", web, "bearer", { type: "approval" });
	}
}

const outcome = (await s.harness.getTask(received.turn as TaskId<TurnResult>, context))?.state.outcome;
const { parked } = await status(s.harness);
const answers = readFileSync(join(home, "answers.txt"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean);
const people = Object.values(google.people());
console.log(
	JSON.stringify({
		outcome,
		parked,
		answers,
		open: (await openWaits(s.harness)).length,
		people,
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
