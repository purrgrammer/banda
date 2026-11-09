/**
 * The process the accounts fault suite kills: a calendar that reads whom a sign-in is for, and agent Mara, whose file
 * names no connection. The owner signs in as ana for Mara (her file rewritten to name it), signs in as bea for no
 * agent and switches bea on for Mara, then signs ana out. Each step is safe to repeat, as each process does them again
 * from the start (a step done is known from the store, never from what the process remembers); the fake server, in the
 * test's own process, keeps its sign-ins across kills. Prints a summary as its last line.
 *
 * argv: home, the fake server's URL, fault schedule JSON (Fault[])
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Accepted, parseAgent, shaOf } from "../../src/core/agents.ts";
import { Connected } from "../../src/core/connections.ts";
import { context } from "../../src/core/store.ts";
import { openConnected, signInAsOwner } from "../fixtures/connected.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";

const [home, url, scheduleJson] = process.argv.slice(2) as [string, string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const origin = new URL(url).origin;
const as = (user: string) => fetch(`${origin}/user`, { method: "POST", body: user });

const s = await openConnected({
	home,
	respond: () => fauxAssistantMessage("Done."),
	wrapStorage: (storage) => faults.storage(storage),
	fault: (point) => faults.hit(point as FaultPoint),
});
const calendar = [
	"---",
	"service: Calendar",
	`url: ${url}`,
	"auth: oauth",
	"account: get_me.login",
	"reads: [list_events]",
	"---",
	"Your day.",
	"",
].join("\n");
const mara = "---\nname: Mara\nstate: active\ndescription: Keeps the calendar.\n---\nYou keep the calendar.\n";

// the agent proposes the calendar; the owner allows it, as shown
const file = join(s.box.workspace, "connections", "cal.md");
if (!existsSync(file)) {
	mkdirSync(join(s.box.workspace, "connections"), { recursive: true });
	writeFileSync(file, calendar);
}
const shown = (await s.capabilities.view()).connections.find((c) => c.name === "cal");
if (shown?.change !== undefined && "sha" in shown.change && shown.change.sha !== undefined)
	await s.capabilities.acceptConnection("cal", shown.change.sha);
// Mara, as the owner made her
if ((await s.harness.snapshot(Accepted, context))?.files["agents/mara.md"] === undefined) {
	mkdirSync(join(s.box.workspace, "agents"), { recursive: true });
	writeFileSync(join(s.box.workspace, "agents", "mara.md"), mara);
	await s.harness.commit(async (tx) => {
		(await tx.doc(Accepted)).files["agents/mara.md"] = { sha: shaOf(mara), text: mara, at: 1 };
	}, context);
}

const accounts = async () => (await s.harness.snapshot(Connected, context))?.accounts?.cal ?? {};
const done = join(home, "signed-out");
// ana, for Mara; a kill after she was added but before she was switched on leaves her to switch on
if (!existsSync(done)) {
	if ((await accounts()).ana === undefined) {
		await as("ana");
		const signed = await signInAsOwner(s.capabilities, "cal", { agent: "mara" });
		if (!signed.ok && (await accounts()).ana === undefined) throw new Error(signed.words);
	}
	await s.capabilities.switchAccount("mara", "cal", "ana", true);
}
// bea, for no agent, then on for Mara
if ((await accounts()).bea === undefined) {
	await as("bea");
	const signed = await signInAsOwner(s.capabilities, "cal", { agent: null });
	if (!signed.ok && (await accounts()).bea === undefined) throw new Error(signed.words);
}
await s.capabilities.switchAccount("mara", "cal", "bea", true);
// ana signed out; remembered once it finished, so a later process does not sign her in again
if ((await accounts()).ana !== undefined) await s.capabilities.signOut("cal", "ana");
writeFileSync(done, "");

// a server that does not say whom a sign-in is for: signed in once, then given the owner's name
const notes = join(s.box.workspace, "connections", "notes.md");
if (!existsSync(notes))
	writeFileSync(notes, calendar.replace("service: Calendar", "service: Notes").replace("account: get_me.login\n", ""));
const notesShown = (await s.capabilities.view()).connections.find((c) => c.name === "notes");
if (notesShown?.change !== undefined && "sha" in notesShown.change && notesShown.change.sha !== undefined)
	await s.capabilities.acceptConnection("notes", notesShown.change.sha);
const noteAccounts = async () => (await s.harness.snapshot(Connected, context))?.accounts?.notes ?? {};
if ((await noteAccounts())["account-1"] === undefined) {
	const signed = await signInAsOwner(s.capabilities, "notes", { agent: null });
	if (!signed.ok && (await noteAccounts())["account-1"] === undefined) throw new Error(signed.words);
}
await s.capabilities.labelAccount("notes", "account-1", "Work");

// as a start finds it: credentials no account is named for are forgotten
await s.capabilities.reconcile();
const doc = await s.harness.snapshot(Connected, context);
const accepted = (await s.harness.snapshot(Accepted, context))?.files["agents/mara.md"]?.text ?? "";
const parsed = parseAgent("mara", accepted);
const credentials = readdirSync(join(home, "auth", "connections", "cal"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();
console.log(
	JSON.stringify({
		accounts: Object.keys(doc?.accounts?.cal ?? {}).sort(),
		named: Object.values(doc?.accounts?.notes ?? {}).map((account) => account.label),
		on: doc?.on?.mara?.cal ?? [],
		connections: "agent" in parsed ? (parsed.agent.connections ?? []) : [],
		box: readFileSync(join(s.box.workspace, "agents", "mara.md"), "utf8") === accepted,
		credentials,
		commits: faults.hits("commit:after"),
	}),
);
await s.close();
