/**
 * Egress without Docker (DESIGN.md "The box", Network): the daemon's side against a fake proxy (tickets taken into the
 * store and listed, a held request sent only as an approved draft or within a permission over its route, exactly as
 * held, once), the route a permission binds, and the proxy's own policy (proxy/policy.py) run by the host's python3
 * against the same vectors the proxy sees.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	type Harness,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { writeHash } from "../src/box/browser.ts";
import { browserLogin, browserMark, proxyMark, tabStamp } from "../src/box/container.ts";
import { boxEnv, boxTools } from "../src/box/tools.ts";
import { ActivityLog } from "../src/core/activity.ts";
import { AgentChats, LEAD } from "../src/core/agents.ts";
import { EFFECT } from "../src/core/ask.ts";

import {
	addressOf,
	draftArgs,
	type EgressControl,
	type HeldRequest,
	hostOf,
	ownCredential,
	permittedHost,
	permittedHosts,
	proposeSendTool,
	proxyKnows,
	type Replayed,
	requestHash,
	routeOf,
	SECRET_HEADERS,
	SECRET_QUERY,
	SENT_PENDING_MS,
	Sent,
	type SentRequest,
	sweepSent,
	type Taken,
	Tickets,
} from "../src/core/egress.ts";
import { OWNER, type Received } from "../src/core/gateway.ts";
import { hostCovers } from "../src/core/hosts.ts";
import { allowHost, covering, Permissions, revoke } from "../src/core/permissions.ts";
import { openWaits } from "../src/core/status.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { type Approving, answer } from "../src/core/wait.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { answerNudge } from "./fixtures/models.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

const owner = { gateway: "fake", peer: OWNER };
const web = { gateway: "web", peer: OWNER };

/** A request as the proxy holds it. */
function held(chat: number, over: Partial<HeldRequest> = {}): HeldRequest {
	return {
		ticket: `t${randomUUID().replace(/-/g, "").slice(0, 10)}`,
		chat,
		at: Date.now(),
		method: "POST",
		scheme: "https",
		host: "api.example.com",
		port: 443,
		path: "/v1/issues/42/comments?x=1",
		headers: [
			["Host", "api.example.com"],
			["Content-Type", "application/json"],
		],
		body: Buffer.from('{"text":"hi"}').toString("base64"),
		...over,
	};
}

/** A proxy in memory: what each chat's next command will have sent out, and every request it sent. */
class FakeProxy implements EgressControl {
	readonly pending = new Map<number, HeldRequest[]>();
	readonly reads = new Map<number, string[]>();
	readonly sent: HeldRequest[] = [];
	/** What each chat's next command will have sent straight through, under a host permission. */
	readonly sentOut = new Map<number, SentRequest[]>();
	readonly acked: string[] = [];
	async take(chat: number): Promise<Taken> {
		const reads = this.reads.get(chat) ?? [];
		return {
			held: [...(this.pending.get(chat) ?? [])],
			sent: [...(this.sentOut.get(chat) ?? [])],
			reads,
			readBytes: reads.join("\n").length,
		};
	}
	async ack(chat: number, readBytes: number, tickets: readonly string[]): Promise<void> {
		this.acked.push(...tickets);
		this.sentOut.set(
			chat,
			(this.sentOut.get(chat) ?? []).filter((one) => !tickets.includes(one.id)),
		);
		this.pending.set(
			chat,
			(this.pending.get(chat) ?? []).filter((h) => !tickets.includes(h.ticket)),
		);
		if (readBytes > 0) this.reads.delete(chat);
	}
	async replay(request: HeldRequest): Promise<Replayed> {
		this.sent.push(request);
		return {
			status: 201,
			reason: "Created",
			headers: [["content-type", "application/json"]],
			body: Buffer.from('{"id":7}').toString("base64"),
		};
	}
}

/**
 * A core with the box's tools (on the host) and `propose_send`, over a fake proxy. The model runs `bash` for an
 * owner message; when a result lists a held ticket it asks with `propose_send`; then it is done.
 */
function setup() {
	const gateway = new FakeGateway();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const proxy = new FakeProxy();
	const core = defineCore({ blobs: blobStore(), gateway: () => gateway, model: () => FAUX_MODEL, retryDelay: () => 5 });
	let n = 0;
	faux.setResponses(
		Array.from({ length: 1000 }, () => (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
			const heed = answerNudge(ctx.messages);
			if (heed !== undefined) return heed;
			const last = ctx.messages.at(-1);
			const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
			n += 1;
			if (last?.role === "user")
				return fauxAssistantMessage([fauxToolCall("bash", { command: "true" }, { id: `b${n}` })], {
					stopReason: "toolUse",
				});
			const ticket = /ticket (t[0-9a-f]{10})\)/.exec(text)?.[1];
			if (last?.role === "toolResult" && ticket !== undefined && !text.includes("Sent."))
				return fauxAssistantMessage([fauxToolCall("propose_send", { ticket }, { id: `r${n}` })], {
					stopReason: "toolUse",
				});
			return fauxAssistantMessage("Done.");
		}) as never,
	);
	const open = async (home: string) => {
		const box = openBox(hostBox(home), () => {});
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(boxTools({ egress: proxy }));
		registry.install(defineExtension({ name: "effects", tools: [core.effect(proposeSendTool(proxy))] }));
		const harness = await openStore(home, { models, registry, env: boxEnv(box) });
		harness.resume();
		const close = async () => {
			await harness.close(context);
			box.close();
		};
		return { harness, close };
	};
	const say = async (harness: Harness, thread = "t") => {
		const received: Received = await core.receive(harness, {
			id: randomUUID(),
			origin: { ...owner, thread },
			text: "send it",
		});
		if (!("turn" in received)) throw new Error(JSON.stringify(received));
		return received;
	};
	return { proxy, open, say };
}

const done = async (harness: Harness, turn: number) =>
	(await harness.getTask(turn as TaskId, context))?.state.status === "terminal";

const nextAsk = (harness: Harness, turn: number) =>
	until(async () => {
		const [wait] = await openWaits(harness);
		if (wait !== undefined) return { wait };
		return (await done(harness, turn)) ? { wait: undefined } : undefined;
	});

const approve = (harness: Harness, key: string, approving: Approving = {}) =>
	answer(harness, key, "approve", web, "bearer", { approving });

async function results(harness: Harness, chat: number): Promise<string[]> {
	const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
		{ order: "ascending" },
		1000,
		undefined,
		context,
	);
	return page.items
		.filter((e) => e.kind === "pi.tool-result")
		.map((e) =>
			((e.model?.[0] as { content?: { text?: string }[] } | undefined)?.content ?? []).map((p) => p.text).join(""),
		);
}

describe("a held write", () => {
	it("is taken into the store and listed; approved, it is sent exactly as held, once", async () => {
		const s = setup();
		const home = await tempHome();
		const { harness, close } = await s.open(home);
		try {
			const first = await s.say(harness);
			const request = held(first.chat);
			s.proxy.pending.set(first.chat, [request]);
			const { wait } = await nextAsk(harness, first.turn);
			// the draft is the stored request whole, in words; the ticket and route are the daemon's
			expect(wait?.ask).toMatchObject({
				type: "approval",
				tool: "propose_send",
				label: "send POST https://api.example.com/v1/issues/42/comments?x=1",
				args: {
					method: "POST",
					address: "https://api.example.com/v1/issues/42/comments?x=1",
					headers: "Host: api.example.com\nContent-Type: application/json",
					body: '{"text":"hi"}',
					_ticket: request.ticket,
					_route: "POST api.example.com/v1/issues/*/comments",
				},
				permission: { match: { _route: "POST api.example.com/v1/issues/*/comments" } },
			});
			expect(s.proxy.acked).toEqual([request.ticket]);
			expect((await harness.snapshot(Tickets, context))?.tickets[request.ticket]).toEqual(request);
			expect(s.proxy.sent).toEqual([]);
			await approve(harness, wait!.key, { permission: { scope: "always" } });
			await until(() => done(harness, first.turn));
			expect(s.proxy.sent).toEqual([request]);
			const said = await results(harness, first.chat);
			expect(said[0]).toContain(
				`Held, not sent: POST https://api.example.com/v1/issues/42/comments?x=1 (ticket ${request.ticket})`,
			);
			expect(said[1]).toContain("Sent. The server answered 201 Created (application/json).");
			expect(said[1]).toContain('<response>\n{"id":7}\n</response>');
			// the activity says what reached outside
			const activity = (await harness.snapshot(ActivityLog, context))!.events;
			expect(activity.filter((e) => e.outside === "sent").map((e) => e.what)).toEqual([
				"Sent POST https://api.example.com/v1/issues/42/comments?x=1: it answered 201",
			]);

			// the same chat, whose answer came from outside, runs within the permission over the route, unasked: what a
			// chat read never changes what it may do
			const again = await s.say(harness);
			const next = held(first.chat, { path: "/v1/issues/43/comments" });
			s.proxy.pending.set(first.chat, [next]);
			expect((await nextAsk(harness, again.turn)).wait).toBeUndefined();
			expect(s.proxy.sent).toEqual([request, next]);

			// so does another chat
			const other = await s.say(harness, "other");
			const third = held(other.chat, { path: "/v1/issues/99/comments" });
			s.proxy.pending.set(other.chat, [third]);
			expect((await nextAsk(harness, other.turn)).wait).toBeUndefined();
			expect(s.proxy.sent).toEqual([request, next, third]);
			const page = await (await harness.conversation(other.chat as ConversationId, context))!.entries(
				{ order: "ascending" },
				1000,
				undefined,
				context,
			);
			expect(page.items.filter((e) => e.kind === EFFECT)).toHaveLength(1);
		} finally {
			await close();
		}
	});

	it("a ticket of another chat, or none, is refused before anything is asked", async () => {
		const s = setup();
		const { harness, close } = await s.open(await tempHome());
		try {
			const first = await s.say(harness);
			// the proxy says it held a request of chat 99 for this one: the daemon keeps only this one's
			s.proxy.pending.set(first.chat, [held(99)]);
			await until(() => done(harness, first.turn));
			expect(Object.keys((await harness.snapshot(Tickets, context))?.tickets ?? {})).toEqual([]);
			expect(await openWaits(harness)).toEqual([]);
			expect(s.proxy.sent).toEqual([]);
		} finally {
			await close();
		}
	});

	it("a read is logged as the chat's, and changes nothing the model is told or may do", async () => {
		const s = setup();
		const { harness, close } = await s.open(await tempHome());
		try {
			const first = await s.say(harness);
			s.proxy.reads.set(first.chat, ["example.com"]);
			await until(() => done(harness, first.turn));
			const [said] = await results(harness, first.chat);
			expect(said).not.toContain("[banda]");
			const activity = (await harness.snapshot(ActivityLog, context))!.events;
			expect(activity.map((e) => [e.what, e.outside])).toEqual([["Read from example.com", "read"]]);
		} finally {
			await close();
		}
	});
});

describe("a host the owner allowed", () => {
	it("is offered last, and its sends there go unasked while another host asks, until revoked", async () => {
		const s = setup();
		const { harness, close } = await s.open(await tempHome());
		try {
			// the chat reads from outside in the same command that holds its write
			const first = await s.say(harness);
			const request = held(first.chat);
			s.proxy.pending.set(first.chat, [request]);
			s.proxy.reads.set(first.chat, ["example.com"]);
			const { wait } = await nextAsk(harness, first.turn);
			expect(wait?.ask.type === "approval" && wait.ask.scopes?.map((one) => one.scope)).toEqual([
				"task",
				"hour",
				"today",
				"always",
				"host",
			]);
			expect(wait?.ask).toMatchObject({
				args: { _host: "api.example.com" },
				// allowed for the agent asking, by name: the lead, whose companion has no name yet
				host: { match: { _host: "api.example.com" }, what: "your lead may send anything to api.example.com" },
			});
			expect(wait?.ask.type === "approval" && wait.ask.scopes?.at(-1)).toEqual({
				scope: "host",
				host: "api.example.com",
				words:
					"Your lead may send anything to api.example.com without asking from any of its chats, until you take it " +
					"back in Permissions; while your agents share one computer, any of them could use it",
			});
			expect(await approve(harness, wait!.key, { permission: { scope: "host" } })).toMatchObject({
				answered: expect.any(Number),
			});
			await until(() => done(harness, first.turn));
			expect(s.proxy.sent).toEqual([request]);
			const stored = Object.entries((await harness.snapshot(Permissions, context))!.permissions);
			expect(stored.map(([, p]) => [p.tool, p.match, p.scope, p.what, p.agent])).toEqual([
				["propose_send", { _host: "api.example.com" }, "host", "your lead may send anything to api.example.com", LEAD],
			]);
			// the proxy is told the host for the lead's chats, so their writes there go straight through from now on
			expect(await permittedHosts(harness)).toEqual({ [String(first.chat)]: ["api.example.com"] });
			// another agent's chat is not covered, by the daemon or the proxy; a host allowed for that agent covers it alone
			const other = first.chat + 1000;
			await harness.commit(async (tx) => {
				(await tx.doc(AgentChats)).chats[other] = "ledger";
			}, context);
			const draft = { tool: "propose_send", args: draftArgs(held(other)) };
			expect(await harness.commit((tx) => covering(tx, draft, other, Date.now()), context)).toBeUndefined();
			expect(await harness.commit((tx) => covering(tx, draft, first.chat, Date.now()), context)).toBeDefined();
			expect(Object.keys(await permittedHosts(harness))).toEqual([String(first.chat)]);
			await harness.commit(async (tx) => {
				const doc = await tx.doc(Permissions);
				doc.permissions.ledger = { ...stored[0]![1], match: { _host: "ledger.example" }, agent: "ledger" };
			}, context);
			expect(await permittedHosts(harness)).toEqual({
				[String(first.chat)]: ["api.example.com"],
				[String(other)]: ["ledger.example"],
			});
			await harness.commit(async (tx) => {
				delete (await tx.doc(Permissions)).permissions.ledger;
			}, context);

			// any method, any path, the host however it is spelled: unasked
			const sendsUnasked = async (over: Partial<HeldRequest>) => {
				const turn = await s.say(harness);
				const next = held(first.chat, over);
				s.proxy.pending.set(first.chat, [next]);
				expect((await nextAsk(harness, turn.turn)).wait).toBeUndefined();
				expect(s.proxy.sent.at(-1)).toEqual(next);
			};
			await sendsUnasked({ method: "DELETE", path: "/v2/anything/else" });
			await sendsUnasked({ method: "PUT", host: "API.Example.COM", path: "/" });

			// another host, a subdomain, another port, or a credential the box sent: each still asks
			const asks = async (over: Partial<HeldRequest>) => {
				const turn = await s.say(harness);
				const next = held(first.chat, over);
				s.proxy.pending.set(first.chat, [next]);
				const asked = await nextAsk(harness, turn.turn);
				expect(asked.wait?.ask).toMatchObject({ tool: "propose_send" });
				await answer(harness, asked.wait!.key, "deny", web, "bearer");
				await until(() => done(harness, turn.turn));
				expect(s.proxy.sent).not.toContainEqual(next);
				return asked.wait!.ask;
			};
			await asks({ host: "other.example.com" });
			await asks({ host: "eu.api.example.com" });
			await asks({ port: 8443 });
			expect(await asks({ headers: [["Authorization", "Bearer x"]] })).toMatchObject({
				floor: "credentials",
				scopes: [],
			});

			// taken back, it covers nothing
			const [id] = stored[0]!;
			expect(await revoke(harness, id, Date.now())).toBe(true);
			expect(await permittedHosts(harness)).toEqual({});
			await asks({ path: "/v1/issues/42/comments" });
		} finally {
			await close();
		}
	});

	it("is allowed by the owner directly, a pattern or every host, for one agent; the proxy is told", async () => {
		const s = setup();
		const { harness, close } = await s.open(await tempHome());
		try {
			const first = await s.say(harness);
			await until(() => done(harness, first.turn));
			// what the owner typed, spelled as the proxy reads it; what names no host is refused
			expect(await allowHost(harness, LEAD, "wss://*.Damus.io/", 1)).toEqual({ id: "1", host: "*.damus.io" });
			expect(await allowHost(harness, LEAD, "*.damus.io", 2)).toEqual({ id: "1", host: "*.damus.io" });
			expect(await allowHost(harness, LEAD, "*", 3)).toEqual({ id: "2", host: "*" });
			expect(await allowHost(harness, LEAD, "ws://relay.example:8080", 4)).toMatchObject({ id: "3" });
			for (const typed of ["", "a.*.example", "example.com/path", "ftp://x.example", "*.", "x.example:0"])
				expect(await allowHost(harness, LEAD, typed, 5)).toMatchObject({ refused: expect.any(String) });
			expect(await allowHost(harness, "nobody-here", "x.example", 5)).toEqual({ refused: "no such agent" });
			const stored = Object.values((await harness.snapshot(Permissions, context))!.permissions);
			expect(stored.map((p) => [p.match._host, p.scope, p.agent, p.what])).toEqual([
				["*.damus.io", "host", LEAD, "Sancho may send anything to *.damus.io"],
				["*", "host", LEAD, "Sancho may send anything to any host"],
				["http://relay.example:8080", "host", LEAD, "Sancho may send anything to http://relay.example:8080"],
			]);
			const events = (await harness.snapshot(ActivityLog, context))!.events.map((event) => event.what);
			expect(events).toContain("You allowed: Sancho may send anything to *.damus.io");
			expect(await permittedHosts(harness)).toEqual({
				[String(first.chat)]: ["*", "*.damus.io", "http://relay.example:8080"],
			});
			// a pattern covers a held request to a name under it, as the proxy would have let it through
			const under = { tool: "propose_send", args: draftArgs(held(first.chat, { host: "relay.damus.io" })) };
			const covered = await harness.commit(
				async (tx) => (await covering(tx, under, first.chat, Date.now()))?.permission.match._host,
				context,
			);
			expect(covered).toBe("*.damus.io");
			// another agent's chat is not covered
			const other = first.chat + 1000;
			await harness.commit(async (tx) => {
				(await tx.doc(AgentChats)).chats[other] = "ledger";
			}, context);
			const theirs = { tool: "propose_send", args: draftArgs(held(other, { host: "relay.damus.io" })) };
			expect(await harness.commit((tx) => covering(tx, theirs, other, Date.now()), context)).toBeUndefined();
		} finally {
			await close();
		}
	});

	it("is offered after the route's scopes, and the route's always stays as it was", async () => {
		const s = setup();
		const { harness, close } = await s.open(await tempHome());
		try {
			const first = await s.say(harness);
			s.proxy.pending.set(first.chat, [held(first.chat)]);
			const { wait } = await nextAsk(harness, first.turn);
			expect(wait?.ask.type === "approval" && wait.ask.scopes?.map((one) => one.scope)).toEqual([
				"task",
				"hour",
				"today",
				"always",
				"host",
			]);
			await answer(harness, wait!.key, "deny", web, "bearer");
			await until(() => done(harness, first.turn));
		} finally {
			await close();
		}
	});

	it("is the only permission the proxy is told: a route allowed always still goes through the daemon", async () => {
		const s = setup();
		const { harness, close } = await s.open(await tempHome());
		try {
			const first = await s.say(harness);
			s.proxy.pending.set(first.chat, [held(first.chat)]);
			const { wait } = await nextAsk(harness, first.turn);
			await approve(harness, wait!.key, { permission: { scope: "always" } });
			await until(() => done(harness, first.turn));
			expect(Object.keys((await harness.snapshot(Permissions, context))!.permissions)).toHaveLength(1);
			expect(await permittedHosts(harness)).toEqual({});
		} finally {
			await close();
		}
	});

	it("a write the proxy sent straight through is logged once, with its outcome and hash", async () => {
		const s = setup();
		const { harness, close } = await s.open(await tempHome());
		try {
			const first = await s.say(harness);
			const one: SentRequest = {
				id: "s00000000aa",
				chat: first.chat,
				at: Date.now(),
				method: "POST",
				scheme: "https",
				host: "github.com",
				port: 443,
				path: "/me/repo.git/git-receive-pack?x=1",
				hash: "cd".repeat(32),
				bytes: 300,
				status: 200,
			};
			const refused = {
				...one,
				id: "s00000000cc",
				host: "gitlab.com",
				status: undefined,
				failed: "connection refused",
			};
			// still on its way: logged once it has an outcome, or once it waited too long for one
			const pending = { ...one, id: "s00000000dd", status: undefined };
			const lost = { ...pending, id: "s00000000ee", at: Date.now() - SENT_PENDING_MS - 1 };
			// another chat's is not this chat's to log
			const others = { ...one, id: "s00000000bb", chat: first.chat + 100 };
			s.proxy.sentOut.set(first.chat, [one, refused, pending, lost, others]);
			await until(() => done(harness, first.turn));
			const said = (await results(harness, first.chat)).join("\n");
			expect(said).toContain(
				"Sent POST https://github.com/me/repo.git/git-receive-pack?x=1 under the owner's permission for github.com (HTTP 200).",
			);
			expect(said).toContain(
				"Tried POST https://gitlab.com/me/repo.git/git-receive-pack?x=1 under the owner's permission",
			);
			expect(s.proxy.acked).toEqual(expect.arrayContaining([one.id, refused.id]));
			// still on its way, or logged as unknown: kept at the proxy for its outcome
			expect(s.proxy.acked).not.toContain(pending.id);
			expect(s.proxy.acked).not.toContain(lost.id);
			const events = (await harness.snapshot(ActivityLog, context))!.events.filter((e) => e.hash !== undefined);
			expect(events.map((e) => [e.what, e.outside, e.hash, e.chat])).toEqual([
				[
					"Sent POST github.com/me/repo.git/git-receive-pack under your permission (HTTP 200)",
					"sent",
					one.hash,
					first.chat,
				],
				[
					"Tried POST gitlab.com/me/repo.git/git-receive-pack under your permission, not sent: connection refused",
					undefined,
					one.hash,
					first.chat,
				],
				[
					"Sent POST github.com/me/repo.git/git-receive-pack under your permission, its answer unknown",
					"sent",
					one.hash,
					first.chat,
				],
			]);
			expect(Object.keys((await harness.snapshot(Sent, context))!.sent).sort()).toEqual(
				[one.id, refused.id, lost.id].sort(),
			);
			// taken again (a kill before the proxy forgot it): nothing is logged twice; the pending one, answered, is
			s.proxy.sentOut.set(first.chat, [one, { ...pending, status: 201 }]);
			const again = await s.say(harness);
			await until(() => done(harness, again.turn));
			const after = (await harness.snapshot(ActivityLog, context))!.events.filter((e) => e.hash !== undefined);
			expect(after).toHaveLength(4);
			expect(after.at(-1)?.what).toBe(
				"Sent POST github.com/me/repo.git/git-receive-pack under your permission (HTTP 201)",
			);
			// the one logged as unknown: its outcome, come late, is logged too, and only then is it forgotten
			s.proxy.sentOut.set(first.chat, [{ ...lost, status: 200 }]);
			const late = await s.say(harness);
			await until(() => done(harness, late.turn));
			const last = (await harness.snapshot(ActivityLog, context))!.events.filter((e) => e.hash !== undefined);
			expect(last).toHaveLength(5);
			expect(last.at(-1)?.what).toBe(
				"Sent POST github.com/me/repo.git/git-receive-pack under your permission (HTTP 200), its answer late",
			);
			expect(s.proxy.acked).toContain(lost.id);
		} finally {
			await close();
		}
	});

	it("a sweep logs every chat's sent writes, though no command ran, and leaves held requests and reads alone", async () => {
		const s = setup();
		const { harness, close } = await s.open(await tempHome());
		try {
			const base: SentRequest = {
				id: "s0000000001",
				chat: 41,
				at: Date.now(),
				method: "POST",
				scheme: "https",
				host: "github.com",
				port: 443,
				path: "/a.git/git-receive-pack",
				hash: "ef".repeat(32),
				bytes: 9,
				status: 200,
			};
			s.proxy.sentOut.set(41, [base]);
			s.proxy.sentOut.set(42, [{ ...base, id: "s0000000002", chat: 42 }]);
			const request = held(42);
			s.proxy.pending.set(42, [request]);
			s.proxy.reads.set(42, ["example.com"]);
			const egress = Object.assign(s.proxy, { sentChats: async () => [...s.proxy.sentOut.keys()] });
			expect(await sweepSent(egress, harness, Date.now)).toBe(2);
			const events = (await harness.snapshot(ActivityLog, context))!.events.filter((e) => e.outside === "sent");
			expect(events.map((e) => e.chat)).toEqual([41, 42]);
			// a second sweep finds nothing; the held request and the reads wait for chat 42's next command
			expect(await sweepSent(egress, harness, Date.now)).toBe(0);
			expect(s.proxy.pending.get(42)).toEqual([request]);
			expect(s.proxy.reads.get(42)).toEqual(["example.com"]);
			expect(s.proxy.acked).toEqual(["s0000000001", "s0000000002"]);
		} finally {
			await close();
		}
	});
});

describe("what the proxy was told", () => {
	it("a chat the proxy was not told of is told before its command; one it was told of, or with nothing allowed, is not", async () => {
		const harness = await openStore(await tempHome(), { models: createModels(), registry: createRegistry() });
		try {
			await harness.commit(async (tx) => {
				(await tx.doc(AgentChats)).chats[5] = LEAD;
				(await tx.doc(AgentChats)).chats[6] = "ledger";
				(await tx.doc(Permissions)).permissions["1"] = {
					tool: "propose_send",
					match: { _host: "github.com" },
					what: "your lead may send anything to github.com",
					scope: "host",
					agent: LEAD,
					at: 1,
					wait: 1,
				};
			}, context);
			let tells = 0;
			const knows = proxyKnows(harness, async () => {
				tells += 1;
				await knows.permitted();
				knows.told();
			});
			await knows.ready(6);
			expect(tells).toBe(0);
			await knows.ready(5);
			await knows.ready(5);
			expect(tells).toBe(1);
			// a chat of the lead started since: told again before its first command
			await harness.commit(async (tx) => {
				(await tx.doc(AgentChats)).chats[7] = LEAD;
			}, context);
			await knows.ready(7);
			expect(tells).toBe(2);
		} finally {
			await harness.close(context);
		}
	});
});

describe("routes", () => {
	it("bind the method, the host and the path, its ids as *", () => {
		const r = (method: string, path: string, host = "api.example.com", port = 443) =>
			routeOf({ method, scheme: "https", host, port, path });
		expect(r("post", "/v1/issues/42/comments?x=1#f")).toBe("POST api.example.com/v1/issues/*/comments");
		expect(r("PUT", "/files/0b6f2c1e-3a4b-4c5d-8e9f-001122334455")).toBe("PUT api.example.com/files/*");
		expect(r("DELETE", "/repos/banda/box/git/refs/a94a8fe5ccb19ba61c4c0873d391e987982fbbd3")).toBe(
			"DELETE api.example.com/repos/banda/box/git/refs/*",
		);
		expect(r("POST", "/v1/messages")).toBe("POST api.example.com/v1/messages");
		expect(r("POST", "")).toBe("POST api.example.com/");
		expect(r("POST", "/x", "API.Example.com", 8443)).toBe("POST api.example.com:8443/x");
		expect(r("POST", "/u/sk_live_ABCDEF0123456789")).toBe("POST api.example.com/u/*");
		expect(addressOf({ scheme: "http", host: "a.example", port: 80, path: "/p" })).toBe("http://a.example/p");
		expect(addressOf({ scheme: "https", host: "a.example", port: 8443, path: "/p" })).toBe("https://a.example:8443/p");
	});

	it("a host binds its name in lower case and its port unless the scheme's; a subdomain is another host", () => {
		const h = (host: string, port = 443, scheme: "http" | "https" = "https") => hostOf({ scheme, host, port });
		expect(h("GitHub.COM")).toBe("github.com");
		expect(h("github.com.")).toBe("github.com");
		expect(h("github.com", 80, "http")).toBe("github.com");
		expect(h("github.com", 8443)).toBe("github.com:8443");
		expect(h("github.com", 443, "http")).toBe("github.com:443");
		expect(h("api.github.com")).not.toBe(h("github.com"));
		// an IPv6 address is bracketed, so its port cannot read as part of it
		expect(h("2001:db8::1", 8443)).toBe("[2001:db8::1]:8443");
		expect(h("2001:db8::1:8443")).not.toBe(h("2001:db8::1", 8443));
		expect(draftArgs(held(1, { host: "API.example.com" }))._host).toBe("api.example.com");
		// the permission names plain http, so allowing a host never covers sending to it in the clear
		expect(permittedHost({ scheme: "https", host: "GitHub.com", port: 443 })).toBe("github.com");
		expect(permittedHost({ scheme: "http", host: "github.com", port: 80 })).toBe("http://github.com");
		expect(draftArgs(held(1, { scheme: "http", port: 80 }))._host).toMatch(/^http:\/\//);
	});

	it("a draft names a binary body by its size, never its bytes, and a credential the box sent puts it on the floor", () => {
		const binary = held(1, { body: Buffer.from([0, 1, 2, 255]).toString("base64") });
		expect(draftArgs(binary).body).toBe("(4 bytes of binary data)");
		expect(draftArgs(held(1, { body: "" })).body).toBe("(empty)");
		const tool = proposeSendTool(new FakeProxy());
		const floorOf = tool.floor as (args: unknown) => string | undefined;
		expect(floorOf(draftArgs(held(1)))).toBeUndefined();
		expect(floorOf(draftArgs(held(1, { headers: [["Authorization", "Bearer x"]] })))).toBe("credentials");
		expect(floorOf(draftArgs(held(1, { headers: [["cookie", "a=b"]] })))).toBe("credentials");
		// the forges' own spellings, and a token in the query
		for (const header of ["Private-Token", "X-Auth-Token", "X-Access-Token"])
			expect(floorOf(draftArgs(held(1, { headers: [[header, "glpat-x"]] }))), header).toBe("credentials");
		for (const path of ["/v1/x?access_token=abc", "/v1/x?a=1&TOKEN=abc", "/v1/x?api_key=k", "/v1/x?private_token=t"])
			expect(floorOf(draftArgs(held(1, { path }))), path).toBe("credentials");
		expect(floorOf(draftArgs(held(1, { path: "/v1/x?tokens=1&page=2" })))).toBeUndefined();
	});

	it("a draft masks the credentials it carries: the ticket binds the bytes, so none is written whole", () => {
		const key = "glpat-9fA2kQ7xZ1mN4bV8cL3d";
		const args = draftArgs(
			held(1, {
				path: `/v1/x?private_token=${key}&page=2`,
				headers: [
					["Content-Type", "application/json"],
					["Private-Token", key],
				],
			}),
		);
		expect(args.headers).toBe("Content-Type: application/json\nPrivate-Token: glpa… (26 characters)");
		expect(String(args.address)).toMatch(/private_token=glpa.*&page=2$/);
		expect(JSON.stringify(args)).not.toContain(key);
		expect((proposeSendTool(new FakeProxy()).floor as (args: unknown) => string | undefined)(args)).toBe("credentials");
	});
});

const python = (() => {
	try {
		const version = execFileSync("python3", ["-c", "import sys; print(sys.version_info >= (3, 9))"], {
			encoding: "utf8",
		}).trim();
		return version === "True";
	} catch {
		return false;
	}
})();

/** Run proxy/policy.py's `expression` for each of `cases` (a JSON value each, as `x`), with names resolved by `names`. */
function policy(expression: string, cases: readonly unknown[], names: { [host: string]: string[] } = {}): unknown[] {
	const dir = fileURLToPath(new URL("../proxy/", import.meta.url));
	const script = [
		"import json, sys",
		`sys.path.insert(0, ${JSON.stringify(dir)})`,
		"import policy",
		"names = json.loads(sys.argv[1])",
		"def resolve(host, port):",
		"    if host not in names: raise OSError('no such name')",
		"    return names[host]",
		`print(json.dumps([(lambda x: ${expression})(x) for x in json.load(sys.stdin)]))`,
	].join("\n");
	const out = execFileSync("python3", ["-I", "-B", "-c", script, JSON.stringify(names)], {
		input: JSON.stringify(cases),
		encoding: "utf8",
	});
	return JSON.parse(out) as unknown[];
}

describe.skipIf(!python)("the proxy's policy", () => {
	it("refuses loopback, private, link-local and metadata addresses, in every spelling; passes public ones", () => {
		const refused = [
			"127.0.0.1",
			"127.1",
			"0x7f.1",
			"0x7f000001",
			"2130706433",
			"017700000001",
			"0177.0.0.1",
			"0",
			"0.0.0.0",
			"10.1.2.3",
			"172.16.0.1",
			"192.168.1.1",
			"100.64.0.1",
			"169.254.169.254",
			"0xa9.0xfe.0xa9.0xfe",
			"::1",
			"[::1]",
			"::ffff:127.0.0.1",
			"[::ffff:7f00:1]",
			"::ffff:a9fe:a9fe",
			"64:ff9b::a9fe:a9fe",
			"2002:7f00:1::",
			"fe80::1",
			"fd00::1",
			"::",
			"224.0.0.1",
			"255.255.255.255",
			"198.51.100.7",
			"localhost",
			"metadata.google.internal",
			"rebind.example",
			"08.1.2.3",
			"1.2.3.4.5",
			"256.1.1.1",
			"fe80::1%eth0",
		];
		const names = {
			localhost: ["127.0.0.1", "::1"],
			"metadata.google.internal": ["169.254.169.254"],
			// a name answering one public and one private address is refused whole
			"rebind.example": ["93.184.215.14", "10.0.0.1"],
			"example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
		};
		const got = policy("policy.pin(x, 443, resolve, 7795)", refused, names) as [string | null, string | null][];
		for (const [i, [address, why]] of got.entries()) {
			expect(address, `${refused[i]} passed`).toBeNull();
			expect(why, String(refused[i])).toEqual(expect.any(String));
		}
		const passed = policy(
			"policy.pin(x, 443, resolve, 7795)",
			["example.com", "93.184.215.14", "1.1.1.1", "[2606:4700::1111]", "::ffff:1.1.1.1"],
			names,
		);
		expect(passed).toEqual([
			["93.184.215.14", null],
			["93.184.215.14", null],
			["1.1.1.1", null],
			["2606:4700::1111", null],
			["1.1.1.1", null],
		]);
		// the daemon's port, on any host
		expect(policy("policy.pin(x, 7795, resolve, 7795)", ["example.com"], names)).toEqual([
			[null, "port 7795 is banda's own"],
		]);
	});

	it("knows writes, git fetches to named forges, a Host naming another server, and the daemon's login marks", () => {
		expect(
			policy("policy.is_write(x[0], x[1], x[2])", [
				["GET", [], "https://a.example/"],
				["head", [], "https://a.example/"],
				["OPTIONS", [], "https://a.example/"],
				["POST", [], "https://a.example/"],
				["PATCH", [], "https://a.example/"],
				["GET", [["Upgrade", "websocket"]], "https://a.example/ws"],
				["GET", [], "https://a.example/graphql?query=mutation%20%7Bx%7D"],
				["GET", [], "https://a.example/graphql?query=%7Bx%7D"],
			]),
		).toEqual([false, false, false, true, true, true, true, false]);
		// a git fetch reads, at a forge the daemon names: a POST to <path>/git-upload-pack of git's type, its body
		// (as sent, or gzipped) framed as pkt-lines that ask for refs or objects; anything else stays a write
		const pkt = (data: string) => `${(data.length + 4).toString(16).padStart(4, "0")}${data}`;
		const FETCH = [["Content-Type", "application/x-git-upload-pack-request"]];
		const GZIP = [...FETCH, ["Content-Encoding", "gzip"]];
		const want = `${pkt(`want ${"a".repeat(40)} ofs-delta\n`)}0000${pkt("done\n")}`;
		const lsRefs = `${pkt("command=ls-refs\n")}0001${pkt("peel\n")}0000`;
		const forge = "https://forge.example/o/r.git/git-upload-pack";
		const gz = (text: string) => gzipSync(Buffer.from(text, "latin1")).toString("latin1");
		expect(
			policy(
				"policy.git_fetch(x[0], x[1], x[2], x[3], None if x[4] is None else x[4].encode('latin1'), ['forge.example'])",
				[
					["forge.example", "POST", FETCH, forge, lsRefs],
					[
						"forge.example",
						"POST",
						FETCH,
						forge,
						`${pkt("command=fetch")}${pkt("agent=git/2.39.5")}0001${pkt("done\n")}0000`,
					],
					["forge.example", "POST", FETCH, "https://forge.example/o/r/git-upload-pack", want],
					["forge.example", "POST", GZIP, forge, gz(lsRefs)],
					// another host, the push's endpoint, path tricks, another type, a method, no body, a body not git's
					["a.example", "POST", FETCH, "https://a.example/o/r.git/git-upload-pack", lsRefs],
					[
						"forge.example",
						"POST",
						[["Content-Type", "application/x-git-receive-pack-request"]],
						"https://forge.example/o/r.git/git-receive-pack",
						want,
					],
					["forge.example", "POST", FETCH, `${forge}?action=edit&text=secret`, lsRefs],
					["forge.example", "POST", FETCH, "https://forge.example/api/send;/git-upload-pack", lsRefs],
					["forge.example", "POST", FETCH, "https://forge.example/api%2Fsend/git-upload-pack", lsRefs],
					["forge.example", "POST", FETCH, "https://forge.example/o/../api/git-upload-pack", lsRefs],
					["forge.example", "POST", FETCH, "https://forge.example/git-upload-pack", lsRefs],
					["forge.example", "POST", FETCH, `${forge}/x`, lsRefs],
					["forge.example", "POST", [["Content-Type", "application/json"]], forge, lsRefs],
					["forge.example", "PUT", FETCH, forge, lsRefs],
					["forge.example", "POST", FETCH, forge, null],
					["forge.example", "POST", FETCH, forge, '{"secret": "x"}'],
					["forge.example", "POST", FETCH, forge, `${lsRefs}00`],
					["forge.example", "POST", FETCH, forge, `${pkt("secret=x\n")}0000`],
					["forge.example", "POST", FETCH, forge, "0000"],
					// an encoding git does not send, gzip that is not, and gzip that inflates past the limit
					["forge.example", "POST", [...FETCH, ["Content-Encoding", "br"]], forge, lsRefs],
					["forge.example", "POST", GZIP, forge, lsRefs],
					["forge.example", "POST", GZIP, forge, gz(lsRefs + "0000".repeat(3_000_000))],
					// over the limit as sent
					["forge.example", "POST", FETCH, forge, lsRefs + pkt(`have ${"b".repeat(40)}\n`).repeat(25_000)],
				],
			),
		).toEqual([true, true, true, true, ...Array(19).fill(false)]);
		expect(
			// the forges named, as git fetches find them: exactly, or under an entry `*.example.com`
			policy("policy.listed(x, ['forge.example', '*.githubusercontent.com'])", [
				"forge.example",
				"Forge.Example.",
				"raw.githubusercontent.com",
				"githubusercontent.com.evil.example",
				"evil-forge.example",
			]),
		).toEqual([true, true, true, false, false]);
		expect(
			policy("policy.same_server(x[0], x[1], x[2])", [
				["a.example", "a.example", "a.example"],
				["a.example", "A.example:443", null],
				["a.example", "b.example", null],
				["a.example", "a.example", "b.example"],
				["a.example", "a.example.b.example", null],
			]).map((why) => why === null),
		).toEqual([true, true, false, false, false]);
		// a Host header beside the authority (HTTP/2) names the server too: one naming another is refused
		expect(
			policy("policy.same_server(x[0], x[1], None, x[2])", [
				["github.com", "github.com", ["github.com"]],
				["github.com", "github.com", ["evil.example"]],
				["github.com", "github.com", ["github.com", "evil.example"]],
			]).map((why) => why === null),
		).toEqual([true, false, false]);
		// the owner's key goes only over https, unless the credential names http
		expect(
			policy("policy.credential_for(x[0], x[1], x[2])", [
				["a.example", [{ host: "a.example", header: "Authorization", value: "Bearer k" }], "https"],
				["a.example", [{ host: "a.example", header: "Authorization", value: "Bearer k" }], "http"],
				["a.example", [{ host: "a.example", header: "Authorization", value: "Bearer k", scheme: "http" }], "http"],
			]),
		).toEqual([[["Authorization", "Bearer k"]], [], [["Authorization", "Bearer k"]]]);
		const key = "11".repeat(32);
		expect(
			policy(`policy.identity(x[0], x[1], "${key}")`, [
				["c7", proxyMark(key, 7)],
				["c7", proxyMark(key, 8)],
				["c8", proxyMark(key, 7)],
				["c0", proxyMark(key, 0)],
				["admin", proxyMark(key, 7)],
			]),
		).toEqual([7, null, null, 0, null]);
		expect(
			policy(
				'policy.scrub(x.encode(), [{"host": "a", "header": "Authorization", "value": "Bearer sekret-token-123"}]).decode()',
				["echo: Bearer sekret-token-123", "token=sekret-token-123", "nothing here"],
			),
		).toEqual(["echo: [removed by banda]", "token=[removed by banda]", "nothing here"]);
		// a body that streams: a credential split across chunks, wherever it splits, is scrubbed as a whole body is
		const C = '[{"host": "a", "header": "Authorization", "value": "Bearer sekret-token-123"}]';
		const text = "echo: Bearer sekret-token-123 and sekret-token-123.";
		const whole = "echo: [removed by banda] and [removed by banda].";
		const splits = Array.from({ length: text.length - 1 }, (_, i) => [text, i + 1]);
		expect(
			policy(
				`(lambda s: b''.join([s(x[0][:x[1]].encode()), s(x[0][x[1]:].encode()), s(b'')]).decode())(policy.scrubber(${C}))`,
				splits,
			),
		).toEqual(splits.map(() => whole));
		expect(
			policy(`(lambda s: b''.join([s(c.encode()) for c in x] + [s(b'')]).decode())(policy.scrubber(${C}))`, [
				[...text],
			]),
		).toEqual([whole]);
		// and undone from gzip as it arrives, in pieces; an encoding it does not know is none
		const zipped = gzipSync(Buffer.from(text.repeat(50))).toString("latin1");
		expect(
			policy(
				"(lambda d, b: b''.join([d(b[:x]), d(b[x:]), d(b'')]).decode())(policy.decoder('gzip'), " +
					`${JSON.stringify(zipped)}.encode('latin1'))`,
				[1, 10, Math.floor(zipped.length / 2), zipped.length - 1],
			),
		).toEqual(Array(4).fill(text.repeat(50)));
		expect(policy("policy.decoder(x) is None", ["compress", "gzip, br", "identity", ""])).toEqual([
			true,
			true,
			false,
			false,
		]);
	});

	it("knows each agent's browser's login, and hashes a write the owner approved as the daemon does", () => {
		const key = "22".repeat(32);
		expect(
			policy(`policy.browser_login(x[0], x[1], "${key}")`, [
				[browserLogin("sancho"), browserMark(key, "sancho")],
				[browserLogin("mara-two"), browserMark(key, "mara-two")],
				// one agent's mark never logs in as another's browser
				[browserLogin("mara"), browserMark(key, "sancho")],
				[browserLogin("sancho"), proxyMark(key, 7)],
				["c7", browserMark(key, "sancho")],
				["b", browserMark(key, "sancho")],
				["b-Bad", browserMark(key, "Bad")],
			]),
		).toEqual(["sancho", "mara-two", null, null, null, null, null]);
		// a tab's stamp names its chat only with the daemon's mark for that agent's browser and that chat
		const [, mark7 = ""] = tabStamp(key, "sancho", 7).split(".");
		expect(
			policy(`policy.tab_chat(x, "${key}", "sancho")`, [
				tabStamp(key, "sancho", 7),
				tabStamp(key, "sancho", 123456),
				`8.${mark7}`,
				`7.${"0".repeat(32)}`,
				tabStamp("33".repeat(32), "sancho", 7),
				// another agent's browser's stamp for the same chat is not this browser's
				tabStamp(key, "mara", 7),
				"",
				"0.x",
				`07.${mark7}`,
			]),
		).toEqual([7, 123456, null, null, null, null, null, null, null]);
		// the proxy's side gets the host and port as the tunnel names them, the path as the request line does
		const writes: [string, string, number, string, string, string][] = [
			["POST", "Shop.Example", 443, "/keys?x=1", "label=banda", "https://shop.example/keys?x=1"],
			["put", "api.example", 8080, "/v1/a%20b", '{"é":1}', "http://api.example:8080/v1/a%20b"],
			["DELETE", "a.example", 80, "/", "", "http://a.example/"],
		];
		expect(
			policy(
				"policy.write_hash(x[0], x[1], x[2], x[3], x[4].encode())",
				writes.map(([method, host, port, path, body]) => [method, host, port, path, body]),
			),
		).toEqual(writes.map(([method, , , , body, url]) => writeHash(method, url, Buffer.from(body))));
	});
});

/** proxy/addon.py on the host (test/fixtures/proxy-addon.py stands in for mitmproxy): what each request met. */
function admit(config: object, cases: readonly object[]) {
	const dir = fileURLToPath(new URL("../proxy/", import.meta.url));
	const harness = fileURLToPath(new URL("./fixtures/proxy-addon.py", import.meta.url));
	const state = mkdtempSync(join(tmpdir(), "banda-proxy-state-"));
	try {
		const out = execFileSync("python3", ["-I", "-B", harness, dir, state, JSON.stringify(config)], {
			input: JSON.stringify(cases),
			encoding: "utf8",
		});
		return JSON.parse(out) as {
			cases: (
				| { status: number; body: string }
				| { on: true; headers: [string, string][]; streams?: boolean; frames?: string[] }
			)[];
			held: { [chat: string]: HeldRequest[] };
			sent: { [chat: string]: SentRequest[] };
		};
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
}

describe.skipIf(!python)("a host the owner allowed, at the proxy", () => {
	it("spells a permitted host as the daemon does, knows the floor's headers, and hashes as the daemon does", () => {
		const requests: [string, string, number][] = [
			["https", "github.com", 443],
			["https", "GitHub.com.", 443],
			["https", "api.example.com", 8443],
			["http", "forge.example", 8080],
			["http", "forge.example", 80],
			["https", "2001:db8::1", 443],
		];
		expect(policy("policy.permitted_host(x[0], x[1], x[2])", requests)).toEqual(
			requests.map(([scheme, host, port]) => permittedHost({ scheme: scheme as "http" | "https", host, port })),
		);
		expect(policy("sorted(policy.SECRET_HEADERS)", [null])).toEqual([[...SECRET_HEADERS].sort()]);
		expect(policy("sorted(policy.SECRET_QUERY)", [null])).toEqual([[...SECRET_QUERY].sort()]);
		// the proxy reads a path's query as the daemon does
		const paths = ["/a?access_token=1", "/a?x=1&Token=2", "/a?tokens=1", "/a", "/a?api_key=", "/a#token=1"];
		expect(policy("policy.own_credentials([], x)", paths)).toEqual(paths.map((path) => ownCredential([], path)));
		const write = { method: "post", host: "Forge.Example", port: 443, path: "/a?b=1", body: "cGFjaw==" };
		expect(
			policy("policy.write_hash(x[0], x[1], x[2], x[3], b'pack')", [[write.method, write.host, 443, write.path]]),
		).toEqual([requestHash(write)]);
	});

	const key = "33".repeat(32);
	const config = (permitted: string[]) => ({
		key,
		git: [],
		credentials: [{ host: "forge.example", header: "Authorization", value: "Bearer owner-token-12345" }],
		// by chat, as the daemon names them: 7, 8 (a tab of sancho's browser) and 9; chat 11 runs an agent with none
		permitted: permitted.length === 0 ? {} : { 7: permitted, 8: permitted, 9: permitted },
		browsers: { sancho: { tabs: { 8: { owner: false } } } },
	});
	const push = {
		login: "c7",
		method: "POST",
		host: "forge.example",
		path: "/me/repo.git/git-receive-pack",
		body: "pack",
	};

	it("lets a chat's write to a permitted host through, credentials set and recorded; holds the rest", () => {
		const cases = [
			push,
			{ ...push, host: "other.example" },
			{ ...push, headers: [["Authorization", "Bearer mine-own-token"]] },
			{ ...push, headers: [["Cookie", "session=1"]] },
			{ ...push, headers: [["X-Api-Key", "k"]] },
			// chat 8's tab in sancho's browser: a browser's write never goes by a host permission, it waits
			{ ...push, login: "b-sancho", headers: [["x-banda-tab", tabStamp(key, "sancho", 8)]] },
			{ ...push, scheme: "http", port: 80 },
			{ ...push, port: 8443 },
			{ ...push, host: "sub.forge.example" },
			{ ...push, login: "c0" },
			{ ...push, login: "c11" },
			// a chat's reads go to any public host, whatever it read before
			{ login: "c7", method: "GET", host: "forge.example", path: "/me/repo.git/info/refs" },
			{ login: "c7", method: "GET", host: "other.example", path: "/" },
		];
		const result = admit(config(["forge.example"]), cases);
		const [direct, ...rest] = result.cases;
		expect(direct).toMatchObject({ on: true });
		expect((direct as { headers: [string, string][] }).headers).toContainEqual([
			"Authorization",
			"Bearer owner-token-12345",
		]);
		expect(rest.map((one) => ("status" in one ? one.status : 200))).toEqual([
			403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 200, 200,
		]);
		const body = (n: number) => (rest[n] as { body: string }).body;
		expect(body(0)).toMatch(
			/ticket t[0-9a-f]{10}\. It has not been sent\. Ask the owner to allow other\.example \(propose_send with this ticket offers 'Always allow other\.example'; ask_hosts asks for several hosts at once\), then run the command again\./,
		);
		expect(body(1)).toContain("It carries a credential of its own, so the owner is asked every time.");
		expect(body(5)).toContain("Always allow http://forge.example'");
		expect(body(6)).toContain("Always allow forge.example:8443'");
		expect(body(8)).toContain("nobody's chat only reads");
		expect(body(9)).toContain("Ask the owner to allow forge.example");
		// the one write sent is recorded, with its bytes' hash, before it went; nothing else of chat 7's was
		expect(result.sent).toEqual({
			"7": [
				expect.objectContaining({
					chat: 7,
					method: "POST",
					scheme: "https",
					host: "forge.example",
					port: 443,
					path: push.path,
					bytes: 4,
					hash: requestHash({ ...push, port: 443, body: Buffer.from("pack").toString("base64") }),
					id: expect.stringMatching(/^s[0-9a-f]{10}$/),
				}),
			],
		});
		// the browser's page write is held under its holder, as before
		expect(Object.keys(result.held).sort()).toEqual(["11", "7", "8"]);
	});

	it("streams a WebSocket to a permitted host, recorded as it opens and scrubbed; cuts every other", () => {
		const relay = { login: "c7", method: "GET", host: "relay.example", path: "/", headers: [["Upgrade", "websocket"]] };
		const result = admit(config(["*.example", "forge.example"]), [
			{ ...relay, answer: 101, frames: ['["EVENT",{}]', "echo Bearer owner-token-12345"] },
			{ ...relay, host: "forge.example", answer: 101, frames: ["ok"] },
			// held, so never opened: another host, nobody's chat, a credential of its own, the browser
			{ ...relay, host: "relay.other", frames: ["no"] },
			{ ...relay, login: "c11", frames: ["no"] },
			{ ...relay, headers: [...relay.headers, ["Authorization", "Bearer mine"]], frames: ["no"] },
			// a plain read that becomes a WebSocket without asking (no Upgrade it said) is cut
			{ login: "c7", method: "GET", host: "relay.example", path: "/", frames: ["no"] },
		]);
		expect(result.cases.map((one) => ("status" in one ? one.status : (one as { streams: boolean }).streams))).toEqual([
			true,
			true,
			403,
			403,
			403,
			false,
		]);
		// a held WebSocket points at ask_hosts: a stream is never replayed as one request
		expect((result.cases[2] as { body: string }).body).toContain("ask the owner to allow relay.other with ask_hosts");
		// what the server sends is scrubbed of the owner's credentials
		expect((result.cases[0] as { frames: string[] }).frames).toEqual(['["EVENT",{}]', "echo [removed by banda]"]);
		expect((result.cases[1] as { frames: string[] }).frames).toEqual(["ok"]);
		// each opening is recorded before it went, with what its server answered
		expect(result.sent["7"]?.map((one) => [one.host, one.status]).sort()).toEqual([
			["forge.example", 101],
			["relay.example", 101],
		]);
	});

	it("reads a pattern as the daemon does: a name under it, or every host, at its scheme and port", () => {
		const cases: [string, string][] = [
			["*.damus.io", "relay.damus.io"],
			["*.damus.io", "a.b.damus.io"],
			["*.damus.io", "damus.io"],
			["*.damus.io", "evildamus.io"],
			["*.damus.io", "relay.damus.io.evil"],
			["*.damus.io", "relay.damus.io:8443"],
			["*.damus.io", "http://relay.damus.io"],
			["*", "nos.lol"],
			["*", "nos.lol:444"],
			["*", "[2001:db8::1]"],
			["http://*", "http://a.example"],
			["*:8443", "a.example:8443"],
			["nos.lol", "nos.lol"],
			["nos.lol", "x.nos.lol"],
		];
		const expected = [true, true, false, false, false, false, false, true, false, false, true, true, true, false];
		expect(policy("policy.host_covers(x[0], x[1])", cases)).toEqual(expected);
		expect(cases.map(([allowed, spelled]) => hostCovers(allowed, spelled))).toEqual(expected);
	});

	it("notes each direct write's outcome after it was recorded: its server's status, or why the connection failed", () => {
		const result = admit(config(["forge.example"]), [
			{ ...push, answer: 201 },
			{ ...push, login: "c9", fails: "connection refused" },
			{ ...push, login: "c9", path: "/b.git/git-receive-pack", fails: "peer closed", reached: true },
		]);
		expect(result.sent["7"]?.map((one) => one.status)).toEqual([201]);
		const nine = [...(result.sent["9"] ?? [])].sort((a, b) => a.path.localeCompare(b.path));
		expect(nine.map((one) => [one.path, one.failed, one.reached, one.status])).toEqual([
			["/b.git/git-receive-pack", "peer closed", true, undefined],
			[push.path, "connection refused", false, undefined],
		]);
	});

	it("holds a write to a permitted host that carries a forge's token header or a token in its query", () => {
		const cases = [
			{ ...push, headers: [["Private-Token", "glpat-1"]] },
			{ ...push, headers: [["X-Auth-Token", "t"]] },
			{ ...push, headers: [["X-Access-Token", "t"]] },
			{ ...push, path: `${push.path}?access_token=abc` },
			{ ...push, path: `${push.path}?service=x&token=abc` },
		];
		const result = admit(config(["forge.example"]), cases);
		expect(result.cases.map((one) => ("status" in one ? one.status : 200))).toEqual([403, 403, 403, 403, 403]);
		for (const one of result.cases) expect((one as { body: string }).body).toContain("a credential of its own");
		expect(result.sent).toEqual({});
	});

	it("holds the write again once the host is taken back; another chat of the agent's goes through", () => {
		const revoked = admit(config([]), [push, { ...push, login: "c9" }]);
		expect(revoked.cases.map((one) => ("status" in one ? one.status : 200))).toEqual([403, 403]);
		expect(revoked.sent).toEqual({});
		const clean = admit(config(["forge.example"]), [{ ...push, login: "c9" }]);
		expect(clean.cases[0]).toMatchObject({ on: true });
		expect(Object.keys(clean.sent)).toEqual(["9"]);
	});
});
