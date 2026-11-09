/**
 * The process the connection fault suite kills: a calendar banda ships that signs in with OAuth; the owner adds it and
 * signs in; then one owner message whose run reads the calendar and creates an event, which the owner
 * approves. A run interrupted while it created the event asks to run it again, and the owner says no, so a write that
 * may have reached the server is never sent twice. Every step is safe to repeat, as each process does them again from
 * the start; the fake server, in the test's own process, keeps counting across kills. Prints a summary as its last line.
 *
 * With "code", the definition names its client and the owner signs in by code, typed on the fake server's page; a sign-in by
 * code dies with the process that waited for it, so a restart starts it again.
 *
 * With "shipped", the calendar is a definition banda ships, the owner adds it as a switch. With "remove", the owner adds
 * it, signs in, and removes it: the process ends with no fact, no account and no credential of it, whatever was killed.
 *
 * argv: home, the fake server's URL, "callback" or "code" or another mode, fault schedule JSON (Fault[])
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { Connected } from "../../src/core/connections.ts";
import { OWNER } from "../../src/core/gateway.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context } from "../../src/core/store.ts";
import type { TurnResult } from "../../src/core/turn.ts";
import { connectionDefinition, openConnected, signInAsOwner, typingAt } from "../fixtures/connected.ts";
import { answerNudge } from "../fixtures/models.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";
import { ownerAnswer } from "./owner.ts";

const [home, url, mode, scheduleJson] = process.argv.slice(2) as [
	string,
	string,
	"callback" | "code" | "shipped" | "remove" | "remove-server" | "rule" | "address" | "mcp",
	string,
];
const byCode = mode === "code" || mode === "shipped" || mode === "remove";
const calendar = connectionDefinition({
	url,
	auth: "oauth",
	// "rule": the read is list_events only for day=mon, the call the model makes; any other day would ask
	reads: [mode === "rule" ? "list_events(day=mon)" : "list_events"],
	// the write the run makes, named: a tool the server lists and the definition does not name waits off
	needs: { create_event: ["calendar"] },
	...(byCode ? { client: "banda-app", scopes: ["calendar"] } : {}),
});
// what banda ships, in a folder of its own: every mode but the servers the owner adds
const shipped = join(home, "shipped");
const shipping = mode !== "address" && mode !== "mcp" && mode !== "remove-server";
if (shipping && !existsSync(shipped)) {
	mkdirSync(shipped, { recursive: true });
	writeFileSync(
		join(shipped, "cal.json"),
		mode === "shipped" || mode === "remove"
			? JSON.stringify({
					service: "Calendar",
					about: "Your days",
					url,
					auth: "oauth",
					client: "banda-app",
					scopes: ["calendar"],
					reads: ["list_events"],
					needs: { create_event: ["calendar"] },
				})
			: calendar,
	);
}
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);

// the model: after the owner's message, read Monday; after that, create the event; then done
const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
	faults.hit("model");
	const heed = answerNudge(ctx.messages);
	if (heed !== undefined) return heed;
	const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
	const results = ctx.messages.slice(after).filter((m) => m.role === "toolResult").length;
	if (results === 0)
		return fauxAssistantMessage([fauxToolCall("cal__list_events", { day: "mon" }, { id: "c1" })], {
			stopReason: "toolUse",
		});
	if (results === 1)
		return fauxAssistantMessage([fauxToolCall("cal__create_event", { title: "Tea", day: "mon" }, { id: "c2" })], {
			stopReason: "toolUse",
		});
	return fauxAssistantMessage("Done.");
};

const s = await openConnected({
	home,
	respond: respond as never,
	wrapStorage: (storage) => faults.storage(storage),
	fault: (point) => faults.hit(point as FaultPoint),
	...(shipping ? { shipped } : {}),
});

const hasRecord = async () => (await s.harness.snapshot(Connected, context))?.servers.cal !== undefined;

// "remove-server": a server the owner added, then removed; a kill anywhere ends with it gone
if (mode === "remove-server") {
	const removing = join(home, "removing");
	if (!existsSync(removing)) {
		await s.capabilities.addMcp({ url, service: "Cal" });
		writeFileSync(removing, "");
	}
	if (await hasRecord()) await s.capabilities.remove("cal");
	const connected = await s.harness.snapshot(Connected, context);
	console.log(
		JSON.stringify({
			record: await hasRecord(),
			listed: connected?.connections.cal !== undefined,
			reads: connected?.reads.cal !== undefined,
		}),
	);
	await s.close();
	process.exit(0);
}

// "remove": added and signed in to once, then removed; a kill after it was removed leaves it for the next start to
// finish, and adding it again is what must not happen
if (mode === "remove") {
	const removing = join(home, "removing");
	if (!existsSync(removing)) {
		if ((await s.harness.snapshot(Connected, context))?.added.cal === undefined) await s.capabilities.addShipped("cal");
		const before = (await s.capabilities.view()).connections.find((c) => c.name === "cal");
		if (before?.state === "sign-in") {
			const signed = await signInAsOwner(s.capabilities, "cal", { fake: typingAt(new URL(url).origin) });
			if (!signed.ok) throw new Error(signed.words);
		}
		writeFileSync(removing, "");
	}
	if ((await s.harness.snapshot(Connected, context))?.added.cal !== undefined) await s.capabilities.remove("cal");
	const connected = await s.harness.snapshot(Connected, context);
	console.log(
		JSON.stringify({
			added: connected?.added.cal !== undefined,
			accounts: Object.keys(connected?.accounts.cal ?? {}),
			listed: connected?.connections.cal !== undefined,
			credentials: existsSync(join(home, "auth", "connections", "cal"))
				? readdirSync(join(home, "auth", "connections", "cal")).length
				: 0,
			commits: faults.hits("commit:after"),
		}),
	);
	await s.close();
	process.exit(0);
}

// the agent proposes it, or the owner adds the one banda ships
// "mcp": the owner sets it up from Connections, and after a kill sets it up again: the same connection, never a second
if (mode === "mcp") {
	const named = await s.capabilities.addMcp({ url, service: "Cal" });
	if (named !== "cal") throw new Error(`setting it up again made ${named}, not cal`);
} else if (mode === "address") {
	if (!(await hasRecord())) await s.capabilities.addByAddress(url, context, "cal");
} else if ((await s.harness.snapshot(Connected, context))?.added.cal === undefined)
	await s.capabilities.addShipped("cal");
// and signs in, unless the credentials are in already (the start listed its tools then)
const state = (await s.capabilities.view()).connections.find((c) => c.name === "cal")?.state;
if (state === "sign-in") {
	const signed = await signInAsOwner(s.capabilities, "cal", byCode ? { fake: typingAt(new URL(url).origin) } : {});
	if (!signed.ok) throw new Error(signed.words);
}
// "address": its reads are none at first; the owner lets what the server says only reads run without asking
if (mode === "address" || mode === "mcp") {
	const hinted = ((await s.capabilities.view()).connections.find((c) => c.name === "cal")?.tools ?? [])
		.filter((t) => t.classed?.kind === "read" && t.classed.from === "server")
		.map((t) => t.title);
	const seen = (await s.capabilities.view()).connections.find((c) => c.name === "cal")?.accepted?.version;
	if (hinted.includes("list_events") && seen !== undefined)
		await s.capabilities.setTools("cal", { list_events: "allow" }, seen);
	// and sets one of them to ask: the same after a kill, whichever side of the commit it died on
	const current = (await s.capabilities.view()).connections.find((c) => c.name === "cal");
	if (current?.accepted?.version !== undefined)
		await s.capabilities.setTools("cal", { whoami: "ask" }, current.accepted.version);
}

const received = await s.core.receive(s.harness, {
	id: "m1",
	origin: { gateway: "fake", peer: OWNER },
	text: "tea on monday",
});
if (!("turn" in received)) throw new Error(`the message started no Turn: ${JSON.stringify(received)}`);
const ended = s.harness.waitForTask(received.turn as TaskId<TurnResult>, context).then(() => true);
const web = { gateway: "web", peer: OWNER };
while (!(await Promise.race([ended, new Promise<false>((r) => setTimeout(r, 10, false))]))) {
	for (const wait of await openWaits(s.harness)) {
		if (wait.ask.type !== "approval") continue;
		faults.hit("answer");
		const again = wait.ask.interrupted === true;
		appendFileSync(join(home, "answers.txt"), `${again ? "no-again" : "approve"}\n`);
		await ownerAnswer(s.harness, wait.key, again ? "deny" : "approve", web, "bearer");
	}
}

const outcome = (await s.harness.getTask(received.turn as TaskId<TurnResult>, context))?.state.outcome;
const { parked } = await status(s.harness);
const accepted = (await s.harness.snapshot(Connected, context))?.added.cal !== undefined || (await hasRecord());
const connected = (await s.harness.snapshot(Connected, context))?.connections.cal !== undefined;
const answers = readFileSync(join(home, "answers.txt"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean);
console.log(
	JSON.stringify({
		outcome,
		parked,
		accepted,
		connected,
		answers,
		open: (await openWaits(s.harness)).length,
		commits: faults.hits("commit:after"),
	}),
);
await s.close();
