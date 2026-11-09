import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { GITHUB_OBJECTS } from "../scripts/github-objects.ts";
import { Accepted, AgentChats, shaOf } from "../src/core/agents.ts";
import { Connected, credentialsOf, keepCredentials } from "../src/core/connections.ts";
import { type Shipped, setDefinitions, shippedDefinition } from "../src/core/definitions.ts";
import { OWNER } from "../src/core/gateway.ts";
import { Readings, readingKey } from "../src/core/objects.ts";
import { Permissions } from "../src/core/permissions.ts";
import { openWaits } from "../src/core/status.ts";
import { context } from "../src/core/store.ts";
import { answer } from "../src/core/wait.ts";
import { Watches, watchPath } from "../src/core/watches.ts";
import { openObjects } from "../src/server/objects.ts";
import { openConnected, signInAsOwner } from "./fixtures/connected.ts";
import { githubObjectDefinition, startGithubObjects } from "./fixtures/github-objects.ts";
import { tempHome, until } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(
	respond: FauxResponseFactory = () => fauxAssistantMessage("done"),
	attack?: { accountArg: string; serverAccount: boolean },
) {
	const fake = await startGithubObjects();
	if (attack?.serverAccount)
		fake.tools = fake.tools.map((tool) =>
			tool.name !== "add_issue_comment"
				? tool
				: {
						...tool,
						inputSchema: {
							...tool.inputSchema,
							properties: { ...(tool.inputSchema.properties as object), account: { type: "string" } },
						},
					},
		);
	cleanup.push(() => fake.close());
	const home = await tempHome();
	const shipped = join(home, "shipped");
	await mkdir(shipped, { recursive: true });
	const definition = JSON.parse(githubObjectDefinition(fake.url)) as { objects: typeof GITHUB_OBJECTS };
	if (attack !== undefined) {
		const objects = JSON.parse(JSON.stringify(GITHUB_OBJECTS)) as { issue: { writes: { text?: string }[] } };
		objects.issue.writes[0]!.text = attack.accountArg;
		if (attack.serverAccount) objects.issue.writes.push({ ...objects.issue.writes[0], text: "account" });
		definition.objects = objects as unknown as typeof GITHUB_OBJECTS;
	}
	await writeFile(join(shipped, "github.json"), JSON.stringify(definition));
	const s = await openConnected({ home, respond, shipped });
	cleanup.push(() => s.close());
	const agent = "---\nname: Reader\ndescription: Reads objects\nconnections: [github]\n---\nRead.";
	const chat = await s.harness.commit(async (tx) => {
		const chat = Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
		(await tx.doc(Accepted)).files["agents/reader.md"] = { text: agent, sha: shaOf(agent), at: 1 };
		(await tx.doc(AgentChats)).chats[chat] = "reader";
		return chat;
	}, context);
	await s.capabilities.addShipped("github");
	fake.user = "alice";
	const signed = await signInAsOwner(s.capabilities, "github", { agent: "reader" });
	expect(signed, JSON.stringify(signed)).toMatchObject({ ok: true });
	expect((await s.harness.snapshot(Connected, context))?.on.reader?.github).toContain("alice");
	let clock = Date.now();
	const service = openObjects({ harness: s.harness, capabilities: s.capabilities, now: () => clock });
	return {
		...s,
		chat,
		fake,
		service,
		tick: () => {
			clock += 60_000;
		},
	};
}
it.each([false, true])(
	"object metadata cannot edit or unbind the daemon's account (server collision: %s)",
	async (serverAccount) => {
		const accountArg = serverAccount ? "as_account" : "account";
		let planned: string | undefined = "alice";
		const s = await setup(
			() => {
				if (planned === undefined) return fauxAssistantMessage("done");
				const account = planned;
				planned = undefined;
				return fauxAssistantMessage(
					[
						fauxToolCall("github__add_issue_comment", {
							owner: "acme",
							repo: "banda",
							issue_number: 34,
							body: "body",
							...(serverAccount ? { account: "server field" } : {}),
							[accountArg]: account,
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			{ accountArg, serverAccount },
		);
		s.fake.user = "bob";
		expect(await signInAsOwner(s.capabilities, "github", { agent: "reader" })).toMatchObject({ ok: true });
		const say = async () => {
			const received = await s.core.receive(s.harness, {
				id: crypto.randomUUID(),
				origin: { gateway: "fake", peer: OWNER, thread: "reader" },
				agent: "reader",
				text: "comment",
			});
			if (!("turn" in received)) throw new Error("no turn");
			return received;
		};
		const first = await say();
		const wait = await until(async () => (await openWaits(s.harness)).find((w) => w.ask.type === "approval"));
		expect(wait.ask).toMatchObject({
			type: "approval",
			as: "@alice on GitHub",
			permission: { match: { [accountArg]: "alice" } },
		});
		if (wait.ask.type !== "approval") throw new Error("not approval");
		expect(wait.ask.editable).not.toContain(accountArg);
		if (serverAccount) expect(wait.ask.editable).toContain("account");
		expect(
			await answer(s.harness, wait.key, "approve", { gateway: "web", peer: OWNER }, "bearer", {
				approving: { edits: { [accountArg]: "bob" } },
			}),
		).toEqual({ refused: `${accountArg} cannot be edited` });
		await answer(s.harness, wait.key, "approve", { gateway: "web", peer: OWNER }, "bearer", {
			approving: { permission: { scope: "always" } },
		});
		await s.harness.waitForTask(first.turn as TaskId, context);
		expect(Object.values((await s.harness.snapshot(Permissions, context))?.permissions ?? {})).toEqual(
			expect.arrayContaining([expect.objectContaining({ match: expect.objectContaining({ [accountArg]: "alice" }) })]),
		);
		planned = "bob";
		const second = await say();
		const again = await until(async () => (await openWaits(s.harness)).find((w) => w.ask.type === "approval"));
		expect(again.ask).toMatchObject({ as: "@bob on GitHub" });
		expect(s.fake.calls).toHaveLength(1);
		await answer(s.harness, again.key, "deny", { gateway: "web", peer: OWNER }, "bearer");
		await s.harness.waitForTask(second.turn as TaskId, context);
	},
);
it.each(["proactive", "401"] as const)(
	"an old %s refresh cannot replace a new sign-in of the same account",
	async (mode) => {
		const s = await setup();
		const original = await credentialsOf(s.home, "github", "alice");
		if (original === undefined || !("oauth" in original)) throw new Error("no credential");
		if (mode === "proactive")
			await keepCredentials(s.home, "github", "alice", {
				...original,
				oauth: { ...original.oauth, tokens: { ...original.oauth.tokens, expires: 0 } },
			});
		else s.fake.tokens.delete(original.oauth.tokens.access);
		let release!: () => void;
		let entered!: () => void;
		const reached = new Promise<void>((r) => {
			entered = r;
		});
		const hold = new Promise<void>((r) => {
			release = r;
		});
		s.fake.onRefresh = async () => {
			entered();
			await hold;
		};
		const shown = s.service.show(s.chat, [{ ref: "https://github.com/acme/banda/issues/35" }]);
		await reached;
		try {
			await s.capabilities.signOut("github", "alice");
			expect(await signInAsOwner(s.capabilities, "github", { agent: "reader" })).toMatchObject({ ok: true });
			const replacement = await credentialsOf(s.home, "github", "alice");
			release();
			expect((await shown)[0]?.shown).not.toBe("card");
			expect(await credentialsOf(s.home, "github", "alice")).toEqual(replacement);
		} finally {
			release();
			await shown;
		}
	},
);
it.each(["version", "signout", "disconnect", "remove"] as const)(
	"an in-flight refresh cannot race credential %s",
	async (mode) => {
		const s = await setup();
		const original = await credentialsOf(s.home, "github", "alice");
		if (original === undefined || !("oauth" in original)) throw new Error("no credential");
		await keepCredentials(s.home, "github", "alice", {
			...original,
			oauth: { ...original.oauth, tokens: { ...original.oauth.tokens, expires: 0 } },
		});
		let release!: () => void;
		let entered!: () => void;
		const reached = new Promise<void>((r) => {
			entered = r;
		});
		const hold = new Promise<void>((r) => {
			release = r;
		});
		s.fake.onRefresh = async () => {
			entered();
			await hold;
		};
		const shown = s.service.show(s.chat, [{ ref: "https://github.com/acme/banda/issues/35" }]);
		await reached;
		try {
			if (mode === "version") await keepCredentials(s.home, "github", "alice", original);
			else if (mode === "signout") await s.capabilities.signOut("github", "alice");
			else if (mode === "disconnect") await s.capabilities.disconnect("github");
			else await s.capabilities.remove("connections", "github");
			const replacement = await credentialsOf(s.home, "github", "alice");
			release();
			await shown;
			expect(await credentialsOf(s.home, "github", "alice")).toEqual(replacement);
			if (mode !== "version") expect(replacement).toBeUndefined();
		} finally {
			release();
			await shown;
		}
	},
);
it("calls at the same moment share one refresh: the provider rotates the refresh token, so a second would lose the sign-in", async () => {
	const s = await setup();
	const original = await credentialsOf(s.home, "github", "alice");
	if (original === undefined || !("oauth" in original)) throw new Error("no credential");
	await keepCredentials(s.home, "github", "alice", {
		...original,
		oauth: { ...original.oauth, tokens: { ...original.oauth.tokens, expires: 0 } },
	});
	let release!: () => void;
	const hold = new Promise<void>((r) => {
		release = r;
	});
	let entered = 0;
	s.fake.onRefresh = async () => {
		entered++;
		await hold;
	};
	const shows = [35, 36, 37].map((issue) =>
		s.service.show(s.chat, [{ ref: `https://github.com/acme/banda/issues/${issue}` }]),
	);
	await until(() => entered > 0);
	release();
	const shown = await Promise.all(shows);
	expect(shown.map((each) => each[0]?.shown)).toEqual(["card", "card", "card"]);
	expect(s.fake.refreshed).toHaveLength(1);
	const kept = await credentialsOf(s.home, "github", "alice");
	if (kept === undefined || !("oauth" in kept)) throw new Error("no credential");
	expect(s.fake.tokens.has(kept.oauth.tokens.access)).toBe(true);
});
it("normal tool calls share the refresh CAS, rather than a special card-only repair", async () => {
	let called = false;
	const s = await setup(() => {
		if (called) return fauxAssistantMessage("done");
		called = true;
		return fauxAssistantMessage(
			[fauxToolCall("github__issue_read", { method: "get", owner: "acme", repo: "banda", issue_number: 35 })],
			{ stopReason: "toolUse" },
		);
	});
	const original = await credentialsOf(s.home, "github", "alice");
	if (original === undefined || !("oauth" in original)) throw new Error("no credential");
	await keepCredentials(s.home, "github", "alice", {
		...original,
		oauth: { ...original.oauth, tokens: { ...original.oauth.tokens, expires: 0 } },
	});
	let release!: () => void;
	let entered!: () => void;
	const reached = new Promise<void>((r) => {
		entered = r;
	});
	const hold = new Promise<void>((r) => {
		release = r;
	});
	s.fake.onRefresh = async () => {
		entered();
		await hold;
	};
	const received = await s.core.receive(s.harness, {
		id: crypto.randomUUID(),
		origin: { gateway: "fake", peer: OWNER, thread: "reader" },
		agent: "reader",
		text: "read",
	});
	if (!("turn" in received)) throw new Error("no turn");
	await reached;
	try {
		await s.capabilities.signOut("github", "alice");
		expect(await signInAsOwner(s.capabilities, "github", { agent: "reader" })).toMatchObject({ ok: true });
		const replacement = await credentialsOf(s.home, "github", "alice");
		release();
		await s.harness.waitForTask(received.turn as TaskId, context);
		expect(await credentialsOf(s.home, "github", "alice")).toEqual(replacement);
		expect(s.fake.calls).toHaveLength(0);
	} finally {
		release();
	}
});
it("a real draft shows its bound account/object/verb and sends only the owner's edited bytes once", async () => {
	let called = false;
	const s = await setup(() => {
		if (called) return fauxAssistantMessage("done");
		called = true;
		return fauxAssistantMessage(
			[fauxToolCall("github__add_issue_comment", { owner: "acme", repo: "banda", issue_number: 34, body: "original" })],
			{ stopReason: "toolUse" },
		);
	});
	const received = await s.core.receive(s.harness, {
		id: crypto.randomUUID(),
		origin: { gateway: "fake", peer: OWNER, thread: "reader" },
		agent: "reader",
		text: "Comment",
	});
	if (!("turn" in received)) throw new Error("no turn");
	const wait = await until(async () => (await openWaits(s.harness)).find((w) => w.ask.type === "approval"));
	expect(wait.ask).toMatchObject({
		verb: "Comment",
		as: "@alice on GitHub",
		on: { account: "alice", refs: ["github:pull_request:acme/banda#34", "github:issue:acme/banda#34"] },
		editable: ["body"],
		args: { body: "original" },
	});
	expect(s.fake.calls).toHaveLength(0);
	await answer(s.harness, wait.key, "approve", { gateway: "web", peer: OWNER }, "bearer", {
		approving: { edits: { body: "owner edited" } },
	});
	await s.harness.waitForTask(received.turn as TaskId, context);
	expect(s.fake.calls).toEqual([
		{ tool: "add_issue_comment", args: { owner: "acme", repo: "banda", issue_number: 34, body: "owner edited" } },
	]);
});
it("a draft that makes an object says it in the connection's words, never the tool's name split into a verb", async () => {
	let called = false;
	const s = await setup(() => {
		if (called) return fauxAssistantMessage("done");
		called = true;
		return fauxAssistantMessage(
			[
				fauxToolCall("github__issue_write", {
					method: "create",
					owner: "acme",
					repo: "banda",
					title: "Cards say tool names",
					body: "original",
				}),
			],
			{ stopReason: "toolUse" },
		);
	});
	const received = await s.core.receive(s.harness, {
		id: crypto.randomUUID(),
		origin: { gateway: "fake", peer: OWNER, thread: "reader" },
		agent: "reader",
		text: "File it",
	});
	if (!("turn" in received)) throw new Error("no turn");
	const wait = await until(async () => (await openWaits(s.harness)).find((w) => w.ask.type === "approval"));
	expect(wait.ask).toMatchObject({
		label: "Create an issue on acme/banda",
		verb: "Create",
		as: "@alice on GitHub",
		editable: ["body"],
		permission: { what: "create an issue on acme/banda as @alice" },
	});
	if (wait.ask.type !== "approval") throw new Error("not an approval");
	expect(wait.ask.scopes?.[0]?.words).toBe(
		"Create an issue on acme/banda as @alice without asking until this task is done",
	);
	expect(JSON.stringify(wait.ask)).not.toMatch(/issue write/i);
	await answer(s.harness, wait.key, "deny", { gateway: "web", peer: OWNER }, "bearer");
	await s.harness.waitForTask(received.turn as TaskId, context);
	expect(s.fake.calls).toHaveLength(0);
});
it("keeps useful primary PR data when optional reads fail", async () => {
	const s = await setup();
	const original = s.fake.onCall!;
	s.fake.onCall = async (tool, args, auth) =>
		args.method === "get" ? original(tool, args, auth) : { text: "temporarily unavailable", isError: true };
	const shown = (await s.service.show(s.chat, [{ ref: "acme/banda#34" }]))[0];
	expect(shown).toMatchObject({
		shown: "card",
		card: { title: "Keep objects as data", checks: null, reviews: "Reviews unavailable" },
	});
	expect(s.fake.calls).toHaveLength(3);
});
it("reads all GitHub shapes using upstream schemas, scopes accounts, and never calls writes", async () => {
	const s = await setup();
	const shown = await s.service.show(s.chat, [
		{ ref: "https://github.com/acme/banda/pull/34" },
		{ ref: "https://github.com/acme/banda/issues/35" },
		{ ref: "https://github.com/acme/banda/actions/runs/20/job/50" },
	]);
	expect(shown.map((x) => (x.shown === "card" ? x.card.card : x.shown))).toEqual([
		"pull-request",
		"issue",
		"check-run",
	]);
	const notification = (await s.service.show(s.chat, [{ ref: "notification/7" }]))[0];
	expect(notification).toMatchObject({
		shown: "card",
		account: "@alice",
		card: { card: "notification" },
		subject: { shown: "card", card: { card: "pull-request" } },
	});
	expect(s.fake.calls.map((c) => c.tool)).toEqual([
		"pull_request_read",
		"pull_request_read",
		"pull_request_read",
		"issue_read",
		"actions_get",
		"get_notification_details",
	]);
	expect((await s.harness.snapshot(Readings, context))?.readings).toBeDefined();
	// A caller cannot borrow a globally signed-in account from a fabricated draft.
	s.fake.user = "bob";
	await signInAsOwner(s.capabilities, "github", { agent: null });
	const count = s.fake.calls.length;
	expect((await s.service.show(s.chat, [{ refs: ["acme/banda#34"], account: "bob" }]))[0]?.shown).not.toBe("card");
	expect(s.fake.calls).toHaveLength(count);
	await s.capabilities.toggle("github__pull_request_read", false);
	expect((await s.service.show(s.chat, [{ ref: "acme/banda#34" }]))[0]?.shown).not.toBe("card");
	expect(s.fake.calls).toHaveLength(count);
});
it.each(["signout", "switch", "regrant", "definition"] as const)(
	"discards an in-flight reading after %s and cannot resurrect cached private data",
	async (mode) => {
		const s = await setup();
		let finish!: () => void;
		let entered!: () => void;
		const reached = new Promise<void>((r) => {
			entered = r;
		});
		const hold = new Promise<void>((r) => {
			finish = r;
		});
		s.fake.onCall = async (_tool, _args, auth) => {
			entered();
			await hold;
			return { text: JSON.stringify({ title: auth, state: "open" }) };
		};
		const shown = s.service.show(s.chat, [{ ref: "https://github.com/acme/banda/issues/35" }]);
		await reached;
		if (mode === "signout") await s.capabilities.signOut("github", "alice");
		else if (mode === "switch" || mode === "regrant") {
			await s.capabilities.switchAccount("reader", "github", "alice", false);
			if (mode === "regrant") await s.capabilities.switchAccount("reader", "github", "alice", true);
		} else setDefinitions(new Map([["github", { ...(shippedDefinition("github") as Shipped), sha: "changed" }]]));
		finish();
		expect((await shown)[0]?.shown).not.toBe("card");
		expect(Object.keys((await s.harness.snapshot(Readings, context))?.readings ?? {})).toHaveLength(0);
	},
);
it("a failure is never passively retried, but an immediate deliberate retry really reads", async () => {
	const s = await setup();
	const original = s.fake.onCall!;
	s.fake.onCall = async () => ({ text: "temporary failure", isError: true });
	const ask = { ref: "https://github.com/acme/banda/issues/35" };
	expect((await s.service.show(s.chat, [ask]))[0]?.shown).toBe("failed");
	s.fake.onCall = original;
	await s.service.show(s.chat, [ask]);
	expect(s.fake.calls).toHaveLength(1);
	expect((await s.service.show(s.chat, [ask], true))[0]?.shown).toBe("card");
	expect(s.fake.calls).toHaveLength(2);
	s.tick();
	await s.service.show(s.chat, [ask]);
	expect(s.fake.calls).toHaveLength(2);
	await Promise.all(Array.from({ length: 8 }, () => s.service.show(s.chat, [ask], true)));
	expect(s.fake.calls).toHaveLength(3);
});
it("scrubs the credential used by a response even if its file rotates mid-call", async () => {
	const s = await setup();
	const before = s.fake.onCall;
	s.fake.onCall = async (tool, args, auth) => {
		const answer = await before?.(tool, args, auth);
		// Replace the stored token without changing the account generation, reproducing refresh lifetime.
		const { credentialsOf, keepCredentials } = await import("../src/core/connections.ts");
		const credentials = await credentialsOf(s.home, "github", "alice");
		if (credentials !== undefined && "oauth" in credentials)
			await keepCredentials(s.home, "github", "alice", {
				...credentials,
				oauth: { ...credentials.oauth, tokens: { ...credentials.oauth.tokens, access: "replacement-token" } },
			});
		return { text: JSON.stringify({ ...JSON.parse(answer?.text ?? "{}"), title: auth }) };
	};
	const shown = await s.service.show(s.chat, [{ ref: "https://github.com/acme/banda/issues/35" }]);
	expect(shown[0]).toMatchObject({ shown: "card", card: { title: "Bearer [a credential, hidden]" } });
	for (const secret of s.fake.tokens)
		expect(JSON.stringify(await s.harness.snapshot(Readings, context))).not.toContain(secret);
});
it("a card's follow line names the watches on it whose files stand: one stopped, its record left behind, is not following", async () => {
	const s = await setup();
	const key = readingKey("alice", "github:issue:acme/banda#35");
	const text = "---\nobject: https://github.com/acme/banda/issues/35\naccount: alice\n---\nTell me.\n";
	await s.harness.commit(async (tx) => {
		(await tx.doc(Accepted)).files[watchPath("banda-35")] = { text, sha: shaOf(text), at: 1 };
		const { watches } = await tx.doc(Watches);
		for (const name of ["banda-35", "banda-35-2"])
			watches[name] = { agent: "reader", since: 1, key, ref: "github:issue:acme/banda#35", sha: shaOf(text) };
	}, context);
	const shown = await s.service.show(s.chat, [{ ref: "https://github.com/acme/banda/issues/35" }]);
	expect(shown[0]).toMatchObject({ shown: "card", follow: { by: [{ watch: "banda-35", agent: "reader" }] } });
});
