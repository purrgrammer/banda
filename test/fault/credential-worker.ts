import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { Accepted, AgentChats, shaOf } from "../../src/core/agents.ts";
import { Connected, credentialsOf, keepCredentials } from "../../src/core/connections.ts";
import { Readings } from "../../src/core/objects.ts";
import { context } from "../../src/core/store.ts";
import { openObjects } from "../../src/server/objects.ts";
import { openConnected, signInAsOwner } from "../fixtures/connected.ts";
import { githubObjectFile } from "../fixtures/github-objects.ts";
import type { CredentialScenario, CredentialSummary } from "./credential-invariants.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";

const [home, url, input, schedule] = process.argv.slice(2) as [string, string, string, string];
const scenario = JSON.parse(input) as CredentialScenario;
const faults = new Faults(JSON.parse(schedule) as Fault[]);
let active = false;
const wrapStorage = (storage: Storage): Storage => {
	const wrapped = faults.storage(storage);
	return new Proxy(storage, {
		get(target, key) {
			if (key === "commit")
				return (...args: Parameters<Storage["commit"]>) => (active ? wrapped : storage).commit(...args);
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};
async function run(): Promise<CredentialSummary> {
	active = false;
	const s = await openConnected({
		home,
		respond: () => fauxAssistantMessage("done"),
		wrapStorage,
		fault: (p) => {
			if (active) faults.hit(p as FaultPoint);
		},
	});
	try {
		const chat = await s.harness.commit(async (tx) => {
			const chats = await tx.doc(AgentChats);
			const existing = Object.entries(chats.chats).find(([, id]) => id === "reader");
			if (existing !== undefined) return Number(existing[0]);
			const text = "---\nname: Reader\ndescription: Reads objects\nconnections: [github]\n---\nRead.";
			(await tx.doc(Accepted)).files["agents/reader.md"] = { text, sha: shaOf(text), at: 1 };
			const chat = Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
			chats.chats[chat] = "reader";
			return chat;
		}, context);
		if ((await s.harness.snapshot(Accepted, context))?.files["connections/github.md"] === undefined) {
			await mkdir(join(s.box.workspace, "connections"), { recursive: true });
			await writeFile(join(s.box.workspace, "connections/github.md"), githubObjectFile(url));
			const change = (await s.capabilities.view()).connections.find((c) => c.name === "github")?.change;
			if (change === undefined || !("sha" in change) || change.sha === undefined) throw new Error("no definition");
			await s.capabilities.acceptConnection("github", change.sha);
		}
		const signin = async () => {
			const result = await signInAsOwner(s.capabilities, "github", { agent: "reader" });
			if (!result.ok) throw new Error("owner sign-in failed");
		};
		if ((await s.harness.snapshot(Connected, context))?.accounts.github?.alice === undefined) await signin();
		const before = await credentialsOf(home, "github", "alice");
		if (before === undefined || !("oauth" in before)) throw new Error("no OAuth credential");
		await keepCredentials(home, "github", "alice", {
			...before,
			oauth: {
				...before.oauth,
				tokens: {
					...before.oauth.tokens,
					...(scenario.mode === "proactive" ? { expires: 0 } : { access: "deliberately-expired-token" }),
				},
			},
		});
		active = true;
		const service = openObjects({ harness: s.harness, capabilities: s.capabilities });
		const ask = { ref: "https://github.com/acme/banda/issues/35" };
		let shown = (await service.show(chat, [ask], true))[0];
		if (shown?.shown !== "card") {
			// A provider may rotate a one-use refresh token before a crash. Only the owner signs in again.
			await signin();
			shown = (await service.show(chat, [ask], true))[0];
		}
		if (scenario.revoke) await s.capabilities.signOut("github", "alice");
		const account = (await s.harness.snapshot(Connected, context))?.accounts.github?.alice;
		const credential = await credentialsOf(home, "github", "alice");
		const readings = (await s.harness.snapshot(Readings, context))?.readings ?? {};
		const privateBytes = [
			before.oauth.tokens.access,
			before.oauth.tokens.refresh,
			...(credential !== undefined && "oauth" in credential
				? [credential.oauth.tokens.access, credential.oauth.tokens.refresh]
				: []),
		].filter((v): v is string => typeof v === "string");
		return {
			card: shown?.shown === "card",
			accountPresent: account !== undefined,
			credentialPresent: credential !== undefined,
			versioned: typeof account?.generation === "string" && typeof credential?.revision === "string",
			private: privateBytes.every((secret) => !JSON.stringify(readings).includes(secret)),
			readingAccounts: Object.values(readings).map((r) => r.account),
			commits: faults.hits("commit:after"),
			points: Object.fromEntries(
				["credential:refresh", "credential:refreshed", "credential:replace", "credential:replaced"].map((p) => [
					p,
					faults.hits(p as FaultPoint),
				]),
			),
		};
	} finally {
		await s.close().catch(() => {});
	}
}
let summary: CredentialSummary | undefined;
for (let attempt = 0; attempt < 4; attempt++) {
	try {
		summary = await run();
		break;
	} catch (error) {
		if (attempt === 3) throw error;
	}
}
console.log(JSON.stringify(summary));
