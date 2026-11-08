import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { ActivityLog } from "../src/core/activity.ts";
import { Accepted, AgentChats, shaOf } from "../src/core/agents.ts";
import { OWNER } from "../src/core/gateway.ts";
import { allowGrain, type GrainAsked } from "../src/core/grains.ts";
import { covering, Permissions, revoke } from "../src/core/permissions.ts";
import { openWaits } from "../src/core/status.ts";
import { context } from "../src/core/store.ts";
import { type Approving, answer } from "../src/core/wait.ts";
import { handler, type Routes } from "../src/server/http.ts";
import { control } from "../src/server/routines.ts";
import { openConnected, signInAsOwner } from "./fixtures/connected.ts";
import { githubObjectFile, startGithubObjects } from "./fixtures/github-objects.ts";
import { tempHome, until } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

type Merge = {
	readonly owner: string;
	readonly repo: string;
	readonly pullNumber?: number;
	readonly account?: string;
	/** Another write than a merge: `github__add_issue_comment`, with its `issue_number` and `body`. */
	readonly tool?: string;
	readonly issue_number?: number;
	readonly body?: string;
	/** The agent the owner writes to: Reader, unless said. */
	readonly agent?: string;
};

/**
 * GitHub connected for agent Reader, as @alice and @bob (alice switched on for Reader, bob for nobody), with
 * update_pull_request on the floor; the model merges what `merges` holds next, one per owner message.
 */
async function setup() {
	let pending: Merge | undefined;
	const fake = await startGithubObjects();
	cleanup.push(() => fake.close());
	const s = await openConnected({
		home: await tempHome(),
		respond: (asked) => {
			// only the owner's newest message is answered with the call: another chat's run may still be ending
			const last = asked.messages.at(-1);
			const theirs = last?.role === "user" && typeof last.content === "string" && last.content.startsWith("merge ");
			if (pending === undefined || !theirs) return fauxAssistantMessage("done");
			const { tool = "github__merge_pull_request", agent: _agent, ...merge } = pending;
			pending = undefined;
			return fauxAssistantMessage([fauxToolCall(tool, { ...merge })], {
				stopReason: "toolUse",
			});
		},
	});
	cleanup.push(() => s.close());
	const agent = "---\nname: Reader\ndescription: Merges\nconnections: [github]\n---\nMerge.";
	await s.harness.commit(async (tx) => {
		(await tx.doc(Accepted)).files["agents/reader.md"] = { text: agent, sha: shaOf(agent), at: 1 };
	}, context);
	await mkdir(join(s.box.workspace, "connections"), { recursive: true });
	const file = githubObjectFile(fake.url).replace("reads: [", "money: [update_pull_request]\nreads: [");
	await writeFile(join(s.box.workspace, "connections/github.md"), file);
	const change = (await s.capabilities.view()).connections.find((c) => c.name === "github")?.change;
	if (change === undefined || !("sha" in change) || change.sha === undefined) throw new Error("no change");
	await s.capabilities.acceptConnection("github", change.sha);
	fake.user = "bob";
	expect(await signInAsOwner(s.capabilities, "github", { agent: "reader" })).toMatchObject({ ok: true });
	await s.capabilities.switchAccount("reader", "github", "bob", false);
	fake.user = "alice";
	expect(await signInAsOwner(s.capabilities, "github", { agent: "reader" })).toMatchObject({ ok: true });
	/** Have the model merge `call`: what asks, if it asks, once it has asked or run. */
	const start = async (call: Merge) => {
		pending = call;
		const received = await s.core.receive(s.harness, {
			id: crypto.randomUUID(),
			origin: { gateway: "fake", peer: OWNER, thread: call.agent ?? "reader" },
			agent: call.agent ?? "reader",
			text: `merge ${call.owner}/${call.repo}#${call.pullNumber ?? call.issue_number}`,
		});
		if (!("turn" in received)) throw new Error("no turn");
		const asked = await until(async () => {
			const wait = (await openWaits(s.harness)).find((w) => w.ask.type === "approval");
			if (wait !== undefined) return { wait };
			const task = await s.harness.getTask(received.turn as TaskId, context);
			return task?.state.status === "terminal" ? { wait: undefined } : undefined;
		});
		return { turn: received.turn, wait: asked.wait };
	};
	/** Merge `call`: whether it asked, the owner declining it if so. */
	const merge = async (call: Merge) => {
		const { turn, wait } = await start(call);
		if (wait !== undefined) await answer(s.harness, wait.key, "deny", { gateway: "web", peer: OWNER }, "bearer");
		await s.harness.waitForTask(turn as TaskId, context);
		return { asked: wait !== undefined };
	};
	const merged = () => fake.calls.filter((call) => call.tool === "merge_pull_request").map((call) => call.args);
	const ran = async (id: string) => (await s.harness.snapshot(Permissions, context))?.permissions[id]?.ran;
	/**
	 * Have the model make `call` and the owner answer its ask `verdict`, with `approving`: the scopes it offered, or
	 * undefined when it did not ask; and why the answer was refused, if it was (then it is declined).
	 */
	const answered = async (call: Merge, verdict: "approve" | "deny" = "approve", approving?: Approving) => {
		const { turn, wait } = await start(call);
		if (wait === undefined) {
			await s.harness.waitForTask(turn as TaskId, context);
			return { scopes: undefined };
		}
		const scopes = wait.ask.type === "approval" ? wait.ask.scopes : undefined;
		const owner = { gateway: "web", peer: OWNER };
		const filled = await answer(s.harness, wait.key, verdict, owner, "bearer", {
			...(approving === undefined ? {} : { approving }),
		});
		const refused = "refused" in filled ? filled.refused : undefined;
		if (refused !== undefined) await answer(s.harness, wait.key, "deny", owner, "bearer");
		await s.harness.waitForTask(turn as TaskId, context);
		return { scopes, ...(refused === undefined ? {} : { refused }) };
	};
	return { ...s, fake, start, merge, merged, ran, answered };
}

const place = (more: Partial<GrainAsked> = {}): GrainAsked => ({
	agent: "reader",
	connection: "github",
	tool: "github__merge_pull_request",
	account: "alice",
	grain: "place",
	place: { owner: "acme", repo: "banda" },
	scope: { scope: "always" },
	...more,
});

it("a place's permission covers merging any pull request there as its account, and counts what it let run", async () => {
	const s = await setup();
	const now = Date.now();
	const given = await allowGrain(s.harness, place(), now);
	expect(given).toEqual({ id: "1", what: "merge pull requests in acme/banda as @alice" });
	if (!("id" in given)) throw new Error(given.refused);
	expect(await allowGrain(s.harness, place(), now + 1)).toEqual(given);
	const events = (await s.harness.snapshot(ActivityLog, context))?.events.map((event) => event.what);
	expect(events).toContain("You allowed Reader to merge pull requests in acme/banda as @alice, always");
	expect(await s.ran(given.id)).toBeUndefined();
	expect(await s.merge({ owner: "acme", repo: "banda", pullNumber: 35 })).toMatchObject({ asked: false });
	expect(await s.merge({ owner: "acme", repo: "banda", pullNumber: 36 })).toMatchObject({ asked: false });
	expect(s.merged()).toEqual([
		{ owner: "acme", repo: "banda", pullNumber: 35 },
		{ owner: "acme", repo: "banda", pullNumber: 36 },
	]);
	expect(await s.ran(given.id)).toEqual({ count: 2, last: expect.any(Number) });
	// another repository asks, and what asks is not counted
	expect(await s.merge({ owner: "acme", repo: "other", pullNumber: 1 })).toMatchObject({ asked: true });
	expect(await s.ran(given.id)).toMatchObject({ count: 2 });
	expect(s.merged()).toHaveLength(2);
	const view = (await control(s.harness, s.box.workspace as never, Date.now())).permissions;
	expect(view).toEqual([
		expect.objectContaining({
			id: "1",
			what: "merge pull requests in acme/banda as @alice",
			connection: "github",
			grain: "place",
			ran: { count: 2, last: expect.any(Number) },
			agent: "reader",
		}),
	]);
});

it("a place's permission covers no other account, agent or floor draft; an action's covers every place", async () => {
	const s = await setup();
	const now = Date.now();
	const given = await allowGrain(s.harness, place(), now);
	if (!("id" in given)) throw new Error(given.refused);
	const draft = {
		tool: "github__merge_pull_request",
		args: { owner: "acme", repo: "banda", pullNumber: 9, account: "alice", merge_method: "squash" },
	};
	const other = await s.harness.commit(async (tx) => {
		const chat = Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
		const mine = Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
		(await tx.doc(AgentChats)).chats[chat] = "lead";
		(await tx.doc(AgentChats)).chats[mine] = "reader";
		return { chat, mine };
	}, context);
	const covers = (d: typeof draft & { floor?: "account" }, chat = other.mine) =>
		s.harness.commit(async (tx) => (await covering(tx, d, chat, now))?.id, context);
	expect(await covers(draft)).toBe("1");
	expect(await covers({ ...draft, args: { ...draft.args, account: "bob" } })).toBeUndefined();
	expect(await covers({ ...draft, args: { ...draft.args, repo: "other" } })).toBeUndefined();
	expect(await covers(draft, other.chat)).toBeUndefined();
	expect(await covers({ ...draft, floor: "account" })).toBeUndefined();
	const anywhere = await allowGrain(s.harness, place({ grain: "action", place: undefined }), now);
	expect(anywhere).toEqual({ id: "2", what: "merge pull requests anywhere as @alice" });
	expect(await covers({ ...draft, args: { ...draft.args, owner: "elsewhere", repo: "other" } })).toBe("2");
	expect(await covers({ ...draft, args: { ...draft.args, owner: "elsewhere", account: "bob" } })).toBeUndefined();
	expect(await s.merge({ owner: "someone", repo: "else", pullNumber: 2 })).toMatchObject({ asked: false });
	expect(await s.ran("2")).toMatchObject({ count: 1 });
	expect(await s.ran("1")).toBeUndefined();
});

it("a permission given from Access answers the agent's open asks it covers, and counts them", async () => {
	const s = await setup();
	const started = await s.start({ owner: "acme", repo: "banda", pullNumber: 40 });
	expect(started.wait).toBeDefined();
	const given = await allowGrain(s.harness, place(), Date.now());
	if (!("id" in given)) throw new Error(given.refused);
	await s.harness.waitForTask(started.turn as TaskId, context);
	expect(s.merged()).toEqual([{ owner: "acme", repo: "banda", pullNumber: 40 }]);
	expect(await openWaits(s.harness)).toEqual([]);
	expect(await s.ran(given.id)).toMatchObject({ count: 1 });
});

it("is refused unless the agent, its account, a write off the floor and the grain all hold", async () => {
	const s = await setup();
	const now = Date.now();
	const refused = async (asked: GrainAsked) => {
		const given = await allowGrain(s.harness, asked, now);
		return "refused" in given ? given.refused : undefined;
	};
	expect(await refused(place({ agent: "nobody" }))).toBe("no such agent");
	expect(await refused(place({ account: "bob" }))).toBe("that account is not switched on for Reader");
	expect(await refused(place({ account: "carol" }))).toBe("that account is not switched on for Reader");
	expect(await refused(place({ tool: "github__pull_request_read" }))).toBe(
		"only a write asks first, so only one is allowed",
	);
	expect(await refused(place({ tool: "github__nothing" }))).toBe("that tool is not in effect");
	expect(await refused(place({ connection: "gitlab" }))).toBe("that tool is not in effect");
	expect(await refused(place({ tool: "github__update_pull_request" }))).toBe(
		"this is never allowed ahead: it asks every time, as it moves money",
	);
	expect(await refused(place({ tool: "github__pull_request_review_write", grain: "action" }))).toBe(
		"this cannot be allowed that widely",
	);
	expect(await refused(place({ place: { owner: "acme" } }))).toMatch(/say the place's repo/);
	expect(await refused(place({ place: { owner: "acme", repo: "../x" } }))).toMatch(/say the place's repo/);
	expect(await refused(place({ place: { owner: "acme", repo: "banda", number: "1" } }))).toBe(
		"a place names only its own parts",
	);
	expect(await refused(place({ scope: { scope: "until", until: now + 8 * 24 * 3_600_000 } }))).toMatch(/within a week/);
	expect(await refused(place({ scope: { scope: "until", until: now - 1 } }))).toMatch(/in the future/);
	expect(await refused(place({ scope: { scope: "task" } as never }))).toBe(
		"a permission given here lasts always or until a time",
	);
	expect((await s.harness.snapshot(Permissions, context))?.permissions ?? {}).toEqual({});
	expect(await refused(place({ scope: { scope: "until", until: now + 3_600_000 } }))).toBeUndefined();
	// the app is offered the same: the grains of each write that may take one, and none on the floor
	const tools = (await s.capabilities.view()).connections.find((view) => view.name === "github")?.tools ?? [];
	const grains = Object.fromEntries(
		tools.flatMap((tool) => (tool.grains === undefined ? [] : [[tool.name, tool.grains]])),
	);
	expect(grains).toEqual({
		github__add_issue_comment: {
			what: "comment on pull requests and issues",
			place: { words: "comment on pull requests and issues in {owner}/{repo}", place: "{owner}/{repo}" },
			action: { words: "comment on pull requests and issues anywhere" },
		},
		github__merge_pull_request: {
			what: "merge pull requests",
			place: { words: "merge pull requests in {owner}/{repo}", place: "{owner}/{repo}" },
			action: { words: "merge pull requests anywhere" },
		},
	});
});

it("the owner's route takes a grain's permission as given, and says what is missing from one that is not", async () => {
	const seen: GrainAsked[] = [];
	const routes: Partial<Routes> = {
		allowGrain: async (asked) => {
			seen.push(asked);
			return { routines: [], activity: [], permissions: [] };
		},
	};
	let port = 0;
	const server = createServer(handler(routes as Routes, () => port, "secret"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
	const post = (body: object) =>
		fetch(`http://127.0.0.1:${port}/api/agents/reader/permissions`, {
			method: "POST",
			headers: { authorization: "Bearer secret", "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const good = {
		connection: "github",
		tool: "github__merge_pull_request",
		account: "alice",
		grain: "place",
		place: { owner: "acme", repo: "banda" },
		scope: "until",
		until: 5,
	};
	expect((await post(good)).status).toBe(200);
	expect(seen).toEqual([{ ...place(), scope: { scope: "until", until: 5 } }]);
	for (const bad of [
		{ ...good, grain: "object" },
		{ ...good, scope: "task" },
		{ ...good, scope: "until", until: undefined },
		{ ...good, place: { owner: 1 } },
		{ ...good, account: undefined },
	])
		expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
	expect(seen).toHaveLength(1);
});

const MERGE_HERE = "Merge pull requests in acme/banda without asking until you take it back in Permissions";
const banda = (pullNumber: number, more: Partial<Merge> = {}): Merge => ({
	owner: "acme",
	repo: "banda",
	pullNumber,
	...more,
});

it("three clean approvals in one place earn it: the fourth card offers it alone, and giving it covers the place", async () => {
	const s = await setup();
	// not offered yet, so refused (and then declined)
	expect(await s.answered(banda(1), "approve", { permission: { scope: "place" } })).toMatchObject({
		refused: "that was not offered",
	});
	for (const pull of [2, 3, 4]) {
		const { scopes } = await s.answered(banda(pull));
		expect(scopes?.[0]?.scope).toBe("task");
		expect(scopes?.some((one) => one.scope === "place")).toBe(false);
	}
	const { turn, wait } = await s.start(banda(5));
	if (wait?.ask.type !== "approval") throw new Error("no ask");
	expect(wait.ask.scopes).toEqual([{ scope: "place", words: MERGE_HERE }]);
	const owner = { gateway: "web", peer: OWNER };
	expect(
		await answer(s.harness, wait.key, "approve", owner, "bearer", { approving: { permission: { scope: "always" } } }),
	).toEqual({ refused: "that was not offered" });
	expect(
		await answer(s.harness, wait.key, "approve", owner, "bearer", { approving: { permission: { scope: "place" } } }),
	).toMatchObject({ answered: expect.any(Number) });
	await s.harness.waitForTask(turn as TaskId, context);
	const permissions = Object.values((await s.harness.snapshot(Permissions, context))?.permissions ?? {});
	expect(permissions).toEqual([
		expect.objectContaining({
			tool: "github__merge_pull_request",
			match: { account: "alice", owner: "acme", repo: "banda" },
			what: "merge pull requests in acme/banda as @alice",
			scope: "always",
			grain: "place",
			agent: "reader",
		}),
	]);
	const events = (await s.harness.snapshot(ActivityLog, context))?.events.map((event) => event.what);
	expect(events).toContain("You allowed Reader to merge pull requests in acme/banda as @alice, always");
	expect(await s.merge(banda(6))).toMatchObject({ asked: false });
	expect(await s.merge({ owner: "acme", repo: "other", pullNumber: 1 })).toMatchObject({ asked: true });
	expect(s.merged().map((args) => (args as { pullNumber?: number }).pullNumber)).toEqual([2, 3, 4, 5, 6]);
});

it("a decline starts the count again, an edited approval does not count, and what a permission let run never counts", async () => {
	const s = await setup();
	await s.answered(banda(1));
	await s.answered(banda(2));
	await s.answered(banda(3), "deny");
	await s.answered(banda(4));
	await s.answered(banda(5));
	expect((await s.answered(banda(6))).scopes?.[0]?.scope).toBe("task");
	expect((await s.answered(banda(7))).scopes).toEqual([{ scope: "place", words: MERGE_HERE }]);
	// a comment: edited, it neither counts nor starts again
	const comment = (n: number): Merge => ({
		tool: "github__add_issue_comment",
		owner: "acme",
		repo: "banda",
		issue_number: n,
		body: "Looks good",
	});
	await s.answered(comment(1));
	await s.answered(comment(2), "approve", { edits: { body: "Looks good to me" } });
	await s.answered(comment(3));
	expect((await s.answered(comment(4))).scopes?.[0]?.scope).toBe("task");
	expect((await s.answered(comment(5))).scopes).toEqual([
		{ scope: "place", words: "Comment on pull requests and issues in acme/banda without asking until you take it back in Permissions" },
	]);
	// approved for an hour, then runs within it ask nothing and count nothing
	const hour = { permission: { scope: "until", until: Date.now() + 3_600_000 } } as const;
	await s.answered({ owner: "acme", repo: "later", pullNumber: 1 }, "approve", hour);
	const [given] = Object.entries((await s.harness.snapshot(Permissions, context))?.permissions ?? {}).find(
		([, permission]) => permission.match.repo === "later",
	) ?? [""];
	expect(await s.answered({ owner: "acme", repo: "later", pullNumber: 1 })).toEqual({ scopes: undefined });
	expect(await s.answered({ owner: "acme", repo: "later", pullNumber: 1 })).toEqual({ scopes: undefined });
	await revoke(s.harness, given, Date.now());
	expect((await s.answered({ owner: "acme", repo: "later", pullNumber: 1 })).scopes?.[0]?.scope).toBe("task");
	expect((await s.answered({ owner: "acme", repo: "later", pullNumber: 1 })).scopes?.[0]?.scope).toBe("task");
	expect((await s.answered({ owner: "acme", repo: "later", pullNumber: 1 })).scopes?.[0]?.scope).toBe("place");
});

it("another place, account or agent earns its own", async () => {
	const s = await setup();
	const writer = "---\nname: Writer\ndescription: Merges too\nconnections: [github]\n---\nMerge.";
	await s.harness.commit(async (tx) => {
		(await tx.doc(Accepted)).files["agents/writer.md"] = { text: writer, sha: shaOf(writer), at: 1 };
	}, context);
	await s.capabilities.switchAccount("writer", "github", "alice", true);
	await s.capabilities.switchAccount("reader", "github", "bob", true);
	for (const pull of [1, 2, 3]) await s.answered(banda(pull, { account: "alice" }));
	expect((await s.answered(banda(4, { account: "alice" }))).scopes?.[0]?.scope).toBe("place");
	expect((await s.answered({ owner: "acme", repo: "other", pullNumber: 1, account: "alice" })).scopes?.[0]).toEqual(
		expect.objectContaining({ scope: "task" }),
	);
	expect((await s.answered(banda(5, { account: "bob" }))).scopes?.[0]?.scope).toBe("task");
	expect((await s.answered(banda(6, { agent: "writer" }))).scopes?.[0]?.scope).toBe("task");
});
