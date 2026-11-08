import type { Context } from "@earendil-works/chord";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTool,
	type Harness,
	InboxDoc,
	type TaskId,
} from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ActivityLog } from "../src/core/activity.ts";
import { AgentChats, LEAD } from "../src/core/agents.ts";
import { EFFECT, type EffectRan } from "../src/core/ask.ts";
import { markForeign, readForeign } from "../src/core/foreign.ts";

import { OWNER, type Received } from "../src/core/gateway.ts";
import {
	covering,
	errandOf,
	FLOORS,
	matches,
	offeredScopes,
	openPermissions,
	type PermissionScope,
	Permissions,
	refusal,
	revoke,
	SCOPE_KINDS,
	scopeWords,
	shapeFor,
} from "../src/core/permissions.ts";
import { openWaits } from "../src/core/status.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { type Approving, type Ask, answer, WAIT, type WaitEnded } from "../src/core/wait.ts";
import {
	grainSentence,
	groupApprovals,
	placeValues,
	scopeOf,
	servesGroups,
	sharedScopes,
	usedWords,
} from "../web/src/lib/permissions.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const owner = { gateway: "fake", peer: OWNER };
const web = { gateway: "web", peer: OWNER };
const HOUR = 60 * 60_000;

type Call = { readonly tool: "send" | "pay" | "deploy" | "read"; readonly to: string; readonly body?: string };

/**
 * A core with three test effects that record their runs: `send` (a message to someone: a permission binds the recipient,
 * the owner may edit the body), `pay` (on the floor: money) and `deploy`; and `read`, a read from outside that marks its
 * chat as having read foreign content, held while `reading` is. The model makes the calls each owner message names, in
 * one round, and then says nothing more.
 */
function setup() {
	const gateway = new FakeGateway();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const clock = { skew: 0 };
	const now = () => Date.now() + clock.skew;
	const core = defineCore({
		blobs: blobStore(),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
		now,
	});
	const runs: Call[] = [];
	let hold: (() => void) | undefined;
	/** While `held` is pending, a `read` holds its run after marking it; `entered` once one has. */
	const reading = { entered: () => {}, held: Promise.resolve() };
	/** While `held` is pending, the model's answer after a tool round is held; `entered` once one is. */
	const answering = { entered: () => {}, held: Promise.resolve() };
	const record = async (call: Call, ctx: Context) => {
		runs.push(call);
		if (hold !== undefined) {
			hold();
			const signal = (ctx as { abortSignal?: AbortSignal }).abortSignal;
			await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
		}
		return { output: [{ type: "text" as const, text: `${call.tool} done` }] };
	};
	const tools = [
		core.effect({
			name: "send",
			description: "send a message",
			parameters: Type.Object({ to: Type.String(), body: Type.String() }),
			effect: "unsafe",
			describe: (args) => `send a message to ${args.to}`,
			editable: ["body"],
			permission: { args: ["to"], what: (args) => `send messages to ${args.to}` },
			run: (args, _effect, ctx) => record({ tool: "send", to: args.to, body: args.body }, ctx),
		}),
		core.effect({
			name: "pay",
			description: "pay someone",
			parameters: Type.Object({ to: Type.String() }),
			effect: "unsafe",
			floor: "money",
			describe: (args) => `pay ${args.to}`,
			run: (args, _effect, ctx) => record({ tool: "pay", to: args.to }, ctx),
		}),
		core.effect({
			name: "deploy",
			description: "deploy a target",
			parameters: Type.Object({ to: Type.String() }),
			effect: "unsafe",
			run: (args, _effect, ctx) => record({ tool: "deploy", to: args.to }, ctx),
		}),
		defineTool({
			name: "read",
			description: "read a page from outside",
			parameters: Type.Object({ to: Type.String() }),
			replay: "safe",
			execute: async (args, api, ctx) => {
				await api.commit((tx) => markForeign(tx, Number(api.conversationId)), ctx);
				runs.push({ tool: "read", to: args.to });
				reading.entered();
				await reading.held;
				return { output: [{ type: "text" as const, text: `the page at ${args.to}` }] };
			},
		}),
	];
	/** The calls the next owner message makes, by its text. */
	const planned = new Map<string, readonly Call[]>();
	faux.setResponses(
		Array.from({ length: 1000 }, () => async (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
			const last = ctx.messages.at(-1);
			if (last?.role !== "user") {
				answering.entered();
				await answering.held;
				return fauxAssistantMessage("ok");
			}
			const said = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
			const calls = planned.get(said) ?? [];
			if (calls.length === 0) return fauxAssistantMessage("nothing to do");
			return fauxAssistantMessage(
				calls.map((call, i) =>
					fauxToolCall(
						call.tool,
						(call.tool === "send" ? { to: call.to, body: call.body ?? "" } : { to: call.to }) as never,
						{
							id: `${said}-${i}`,
						},
					),
				),
				{ stopReason: "toolUse" },
			);
		}) as never,
	);
	const open = async (home: string) => {
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(defineExtension({ name: "test", tools }));
		const harness = await openStore(home, { models, registry, now });
		harness.resume();
		return harness;
	};
	let n = 0;
	/** Send an owner message whose run makes `calls`. */
	const say = async (harness: Harness, calls: readonly Call[], thread?: string) => {
		const text = `m${++n}`;
		planned.set(text, calls);
		const origin = thread === undefined ? owner : { ...owner, thread };
		const received: Received = await core.receive(harness, { id: text, origin, text });
		if (!("turn" in received)) throw new Error(`no Turn: ${JSON.stringify(received)}`);
		return received;
	};
	return {
		core,
		open,
		say,
		runs,
		clock,
		now,
		holding: () => new Promise<void>((resolve) => (hold = resolve)),
		release: () => (hold = undefined),
		/** Hold the next `read`: once it has marked its chat, `entered` resolves; `release` lets it answer. */
		holdReading: () => gate(reading),
		/** Hold the model's next answer after a tool round: `entered` once it is asked for, `release` lets it answer. */
		holdAnswer: () => gate(answering),
	};
}

/** Once a message waits in `chat`'s queue for the run at work. */
const queued = (harness: Harness, chat: number) =>
	until(async () => ((await harness.snapshot(InboxDoc, chat as ConversationId, context))?.items.length ?? 0) > 0);

/** Hold what `held` holds until `release`; `entered` once something waits on it. */
function gate(held: { entered: () => void; held: Promise<void> }) {
	let release!: () => void;
	held.held = new Promise<void>((resolve) => (release = resolve));
	const entered = new Promise<void>((resolve) => (held.entered = resolve));
	return { entered, release };
}

const done = async (harness: Harness, turn: number) =>
	(await harness.getTask(turn as TaskId, context))?.state.status === "terminal";

/** The next open ask, or undefined once the Turn is done. */
const nextAsk = (harness: Harness, turn: number) =>
	until(async () => {
		const [wait] = await openWaits(harness);
		if (wait !== undefined) return { wait };
		return (await done(harness, turn)) ? { wait: undefined } : undefined;
	});

const approve = (harness: Harness, key: string, approving: Approving = {}, now = Date.now()) =>
	answer(harness, key, "approve", web, "bearer", { now, approving });

async function entries(harness: Harness, chat: number) {
	const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
		{ order: "ascending" },
		1000,
		undefined,
		context,
	);
	return page.items;
}

describe("permissions", () => {
	it("a permission covers its own tool and bound arguments, and nothing else", () => {
		const given = {
			tool: "propose_send",
			match: { _host: "github.com" },
			what: "",
			scope: "host",
			at: 1,
			wait: 1,
		} as const;
		expect(matches(given, "propose_send", { _host: "github.com" })).toBe(true);
		expect(matches(given, "propose_send", { _host: "gitlab.com" })).toBe(false);
		expect(matches(given, "propose_key", { _host: "github.com" })).toBe(false);
	});
	it("a permission for always: the same recipient runs without asking, in the activity log; another asks", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const first = await s.say(harness, [{ tool: "send", to: "ana", body: "hi" }]);
		const { wait } = await nextAsk(harness, first.turn);
		expect(wait?.ask).toMatchObject({
			label: "send a message to ana",
			editable: ["body"],
			permission: { match: { to: "ana" }, what: "send messages to ana" },
		});
		expect(await approve(harness, wait!.key, { permission: { scope: "always" } })).toMatchObject({
			answered: expect.any(Number),
		});
		await until(() => done(harness, first.turn));
		const second = await s.say(harness, [{ tool: "send", to: "ana", body: "again" }]);
		expect((await nextAsk(harness, second.turn)).wait).toBeUndefined();
		expect(s.runs).toEqual([
			{ tool: "send", to: "ana", body: "hi" },
			{ tool: "send", to: "ana", body: "again" },
		]);
		const events = (await harness.snapshot(ActivityLog, context))!.events.map((event) => event.what);
		expect(events).toEqual(["You allowed send messages to ana, always", "Ran without asking: send a message to ana"]);
		const ran = (await entries(harness, second.chat)).filter((entry) => entry.kind === EFFECT);
		expect(ran.map((entry) => entry.data as unknown as EffectRan)).toEqual([
			{
				tool: "send",
				label: "send a message to ana",
				permission: { what: "send messages to ana", scope: "always" },
				at: expect.any(Number),
			},
		]);
		// what it let run: the second send, never the approval that gave it
		expect((await openPermissions(harness, s.now()))[0]?.permission.ran).toMatchObject({ count: 1 });
		const third = await s.say(harness, [{ tool: "send", to: "bob", body: "hello" }]);
		expect((await nextAsk(harness, third.turn)).wait?.ask).toMatchObject({ args: { to: "bob" } });
		await harness.close(context);
	});

	it("each effect's result says first what let it run: an approval, an edit, a scope given, or a permission", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const said = async (chat: number) =>
			(await entries(harness, chat)).flatMap((entry) => {
				const message = entry.model?.[0] as { role?: string; content?: { type: string; text?: string }[] } | undefined;
				return message?.role === "toolResult" ? [message.content?.[0]?.text ?? ""] : [];
			});
		const once = await s.say(harness, [{ tool: "send", to: "ana", body: "1" }]);
		await approve(harness, (await nextAsk(harness, once.turn)).wait!.key);
		await until(() => done(harness, once.turn));
		const edited = await s.say(harness, [{ tool: "send", to: "ana", body: "2" }]);
		await approve(harness, (await nextAsk(harness, edited.turn)).wait!.key, { edits: { body: "two" } });
		await until(() => done(harness, edited.turn));
		const task = await s.say(harness, [
			{ tool: "send", to: "ana", body: "3" },
			{ tool: "send", to: "ana", body: "4" },
		]);
		await approve(harness, (await nextAsk(harness, task.turn)).wait!.key, { permission: { scope: "task" } });
		await until(() => done(harness, task.turn));
		const always = await s.say(harness, [{ tool: "send", to: "bob", body: "5" }]);
		await approve(harness, (await nextAsk(harness, always.turn)).wait!.key, { permission: { scope: "always" } });
		await until(() => done(harness, always.turn));
		const within = await s.say(harness, [{ tool: "send", to: "bob", body: "6" }]);
		await until(() => done(harness, within.turn));
		expect(await said(once.chat)).toEqual([
			"The owner approved this.\nsend done",
			"The owner approved this. They edited it before approving.\nsend done",
			"The owner approved this. They also allowed you to send messages to ana without asking, for this task, until the owner next writes to you.\nsend done",
			"Ran without asking, within your permission to send messages to ana, for this task, until the owner next writes to you.\nsend done",
			"The owner approved this. They also allowed you to send messages to bob without asking, always.\nsend done",
			"Ran without asking, within your permission to send messages to bob, always.\nsend done",
		]);
		await harness.close(context);
	});

	it("this once is no permission; a permission for the task covers the rest of that run and ends at the next message", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const once = await s.say(harness, [{ tool: "send", to: "ana", body: "1" }]);
		await approve(harness, (await nextAsk(harness, once.turn)).wait!.key);
		await until(() => done(harness, once.turn));
		const task = await s.say(harness, [
			{ tool: "send", to: "ana", body: "2" },
			{ tool: "send", to: "ana", body: "3" },
		]);
		const asked = (await nextAsk(harness, task.turn)).wait!;
		expect(asked.ask).toMatchObject({ args: { body: "2" } });
		await approve(harness, asked.key, { permission: { scope: "task" } });
		// the second call of the same run is the same task
		expect((await nextAsk(harness, task.turn)).wait).toBeUndefined();
		expect((await openPermissions(harness, s.now())).map(({ permission }) => permission.scope)).toEqual(["task"]);
		const next = await s.say(harness, [{ tool: "send", to: "ana", body: "4" }]);
		expect((await nextAsk(harness, next.turn)).wait?.ask).toMatchObject({ args: { body: "4" } });
		expect(await openPermissions(harness, s.now())).toEqual([]);
		expect(s.runs.map((run) => run.body)).toEqual(["1", "2", "3"]);
		await harness.close(context);
	});

	it("the owner's steer joins the task under way: a run that read foreign content stays foreign after it", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const reading = s.holdReading();
		const first = await s.say(harness, [{ tool: "read", to: "example.com" }]);
		await reading.entered;
		// the owner writes while the read holds its round: it steers the run that read the page
		const steer = await s.say(harness, [{ tool: "send", to: "ana", body: "1" }]);
		await queued(harness, first.chat);
		reading.release();
		const { wait } = await nextAsk(harness, first.turn);
		const inbound = (await entries(harness, first.chat)).filter((entry) => entry.kind === "banda.inbound");
		expect(inbound).toHaveLength(2);
		expect(wait?.ask).toMatchObject({ errand: { input: Number(inbound[0]?.id) }, foreign: true, scopes: [] });
		await approve(harness, wait!.key);
		await until(async () => (await done(harness, first.turn)) && (await done(harness, steer.turn)));
		// the run is over, and its task is still the one the owner's first message began
		const errand = await harness.commit((tx) => errandOf(tx, first.chat), context);
		expect(errand.input).toBe(Number(inbound[0]?.id));
		expect(await harness.commit((tx) => readForeign(tx, first.chat, errand.input), context)).toBe(true);
		// the owner's next message starts a run, and a clean task
		const next = await s.say(harness, [{ tool: "send", to: "bo", body: "2" }]);
		const clean = (await nextAsk(harness, next.turn)).wait;
		expect(clean?.ask).not.toHaveProperty("foreign");
		expect(clean?.ask.type === "approval" && clean.ask.scopes?.map((one) => one.scope)).toEqual([
			"task",
			"hour",
			"today",
			"always",
		]);
		await approve(harness, clean!.key);
		await until(() => done(harness, next.turn));
		expect(s.runs.map((run) => run.to)).toEqual(["example.com", "ana", "bo"]);
		await harness.close(context);
	});

	it("the owner's message queued as a run ends starts the next run, and a task of its own", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const answering = s.holdAnswer();
		const first = await s.say(harness, [{ tool: "read", to: "example.com" }]);
		await answering.entered;
		// past the read's round, the run's last answer is on its way: this message waits for it, then starts a run
		const next = await s.say(harness, [{ tool: "send", to: "ana", body: "1" }]);
		await queued(harness, first.chat);
		answering.release();
		const { wait } = await nextAsk(harness, next.turn);
		const inbound = (await entries(harness, first.chat)).filter((entry) => entry.kind === "banda.inbound");
		expect(wait?.ask).toMatchObject({ errand: { input: Number(inbound[1]?.id) } });
		expect(wait?.ask).not.toHaveProperty("foreign");
		await approve(harness, wait!.key);
		await until(async () => (await done(harness, first.turn)) && (await done(harness, next.turn)));
		await harness.close(context);
	});

	it("a permission for a while covers until its time, and lists in plain words while open", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const first = await s.say(harness, [{ tool: "send", to: "ana", body: "1" }]);
		const until1h = s.now() + HOUR;
		await approve(
			harness,
			(await nextAsk(harness, first.turn)).wait!.key,
			{ permission: { scope: "until", until: until1h } },
			s.now(),
		);
		await until(() => done(harness, first.turn));
		expect(
			(await openPermissions(harness, s.now())).map(({ permission }) => [
				permission.what,
				permission.scope,
				permission.until,
			]),
		).toEqual([["send messages to ana", "until", until1h]]);
		const within = await s.say(harness, [{ tool: "send", to: "ana", body: "2" }]);
		expect((await nextAsk(harness, within.turn)).wait).toBeUndefined();
		s.clock.skew = 2 * HOUR;
		expect(await openPermissions(harness, s.now())).toEqual([]);
		const after = await s.say(harness, [{ tool: "send", to: "ana", body: "3" }]);
		expect((await nextAsk(harness, after.turn)).wait).toBeDefined();
		expect(s.runs.map((run) => run.body)).toEqual(["1", "2"]);
		await harness.close(context);
	});

	it("the floor is never permitted: asked for, it is refused; planted in the store, it covers nothing", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const paying = await s.say(harness, [{ tool: "pay", to: "ana" }]);
		const { wait } = await nextAsk(harness, paying.turn);
		expect(wait?.ask).toMatchObject({ floor: "money", label: "pay ana" });
		expect(wait?.ask).not.toHaveProperty("permission");
		for (const permission of [
			{ scope: "always" },
			{ scope: "task" },
			{ scope: "until", until: s.now() + HOUR },
		] as PermissionScope[])
			expect(await approve(harness, wait!.key, { permission })).toEqual({
				refused: "this is never allowed ahead: it asks every time, as it moves money",
			});
		await approve(harness, wait!.key);
		await until(() => done(harness, paying.turn));
		// a permission for it, however it got into the store, covers nothing
		await harness.commit(async (tx) => {
			const doc = await tx.doc(Permissions);
			doc.permissions["99"] = { tool: "pay", match: {}, what: "pay anyone", scope: "always", at: 0, wait: 0 };
		}, context);
		const again = await s.say(harness, [{ tool: "pay", to: "ana" }]);
		expect((await nextAsk(harness, again.turn)).wait?.ask).toMatchObject({ floor: "money" });
		expect(s.runs).toEqual([{ tool: "pay", to: "ana" }]);
		await harness.close(context);
	});

	it("a revoked permission stops covering at once, an effect already waiting its turn included", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const first = await s.say(harness, [{ tool: "send", to: "ana", body: "1" }]);
		await approve(harness, (await nextAsk(harness, first.turn)).wait!.key, { permission: { scope: "always" } });
		await until(() => done(harness, first.turn));
		// a deploy that asks, and behind it a send the permission would cover
		const queued = await s.say(harness, [
			{ tool: "deploy", to: "prod" },
			{ tool: "send", to: "ana", body: "2" },
		]);
		const deploy = (await nextAsk(harness, queued.turn)).wait!;
		const [{ id }] = await openPermissions(harness, s.now());
		expect(await revoke(harness, id!, s.now())).toBe(true);
		expect(await revoke(harness, id!, s.now())).toBe(false);
		await approve(harness, deploy.key);
		const send = (await nextAsk(harness, queued.turn)).wait;
		expect(send?.ask).toMatchObject({ tool: "send", args: { body: "2" } });
		expect(s.runs.map((run) => run.tool)).toEqual(["send", "deploy"]);
		const events = (await harness.snapshot(ActivityLog, context))!.events.map((event) => event.what);
		expect(events).toContain("You took back: send messages to ana");
		await harness.close(context);
	});

	it("an edited draft binds the edited bytes: what runs, and runs again after a restart, is the edit", async () => {
		const s = setup();
		const home = await tempHome();
		let harness = await s.open(home);
		const turn = await s.say(harness, [{ tool: "send", to: "ana", body: "draft" }]);
		const { wait } = await nextAsk(harness, turn.turn);
		expect(await approve(harness, wait!.key, { edits: { to: "eve" } })).toEqual({ refused: "to cannot be edited" });
		expect(await answer(harness, wait!.key, "deny", web, "bearer", { approving: { edits: { body: "x" } } })).toEqual({
			refused: "only an approval, approved, carries edits or a permission",
		});
		const running = s.holding();
		await approve(harness, wait!.key, { edits: { body: "edited by the owner" } });
		await running;
		await harness.close(context); // a crash while the effect runs
		s.release();
		harness = await s.open(home);
		const again = await until(async () => (await openWaits(harness)).find((w) => w.ask.type === "approval"));
		expect(again.ask).toMatchObject({ interrupted: true, args: { to: "ana", body: "edited by the owner" } });
		expect(await approve(harness, again.key, { edits: { body: "other" } })).toEqual({
			refused: "running it again is approved once, as it was",
		});
		await approve(harness, again.key);
		await until(() => done(harness, turn.turn));
		expect(s.runs.map((run) => run.body)).toEqual(["edited by the owner", "edited by the owner"]);
		const ended = (await entries(harness, turn.chat))
			.filter((entry) => entry.kind === WAIT)
			.map((entry) => entry.data as unknown as WaitEnded);
		expect(ended[0]?.edited).toEqual({ to: "ana", body: "edited by the owner" });
		await harness.close(context);
	});
});

describe("the scopes an ask offers", () => {
	const shape = { match: { to: "ana" }, what: "send messages to ana" };

	it("the task's first, each worded as its consequence; none on the floor or for a run again", () => {
		expect(offeredScopes({ permission: shape })).toEqual([
			{ scope: "task", words: "Send messages to ana without asking until this task is done" },
			{ scope: "hour", words: "Send messages to ana without asking for the next hour" },
			{ scope: "today", words: "Send messages to ana without asking until midnight" },
			{ scope: "always", words: "Send messages to ana without asking until you take it back in Permissions" },
		]);
		for (const kind of SCOPE_KINDS)
			if (kind !== "place") expect(scopeWords(shape.what, kind)).toMatch(/^Send messages to ana without asking /);
		expect(offeredScopes({ floor: "money" })).toEqual([]);
		expect(offeredScopes({ floor: "private", permission: shape })).toEqual([]);
		expect(offeredScopes({})).toEqual([]);
		expect(offeredScopes({ permission: shape, interrupted: true })).toEqual([]);
	});

	it("an earned place alone, worded as what it covers; in a chat that read foreign content, nothing else", () => {
		const merge = {
			match: { account: "alice", owner: "acme", repo: "banda", pullNumber: 4 },
			what: "merge acme/banda #4",
		};
		const place = {
			match: { account: "alice", owner: "acme", repo: "banda" },
			what: "merge pull requests in acme/banda as @alice",
			words: "merge pull requests in acme/banda",
		};
		const offered = (ask: Parameters<typeof offeredScopes>[0]) => offeredScopes(ask).map((one) => one.scope);
		expect(offered({ permission: merge, place })).toEqual(["task", "hour", "today", "always"]);
		const earned = { ...place, earned: true } as const;
		expect(offeredScopes({ permission: merge, place: earned })).toEqual([
			{
				scope: "place",
				words: "Merge pull requests in acme/banda without asking until you take it back in Permissions",
			},
		]);
		expect(offered({ permission: merge, place: earned, foreign: true })).toEqual(["place"]);
		expect(offered({ permission: merge, place, foreign: true })).toEqual([]);
		expect(offered({ permission: merge, foreign: true })).toEqual([]);
		expect(offered({ permission: merge, place: earned, interrupted: true })).toEqual([]);
		expect(offered({ floor: "money", permission: merge, place: earned })).toEqual([]);
		// the place's own words, filled from the connection's data: a comment's too
		expect(
			offeredScopes({
				permission: merge,
				place: { ...earned, words: "comment on pull requests and issues in acme/banda" },
			})[0]?.words,
		).toBe("Comment on pull requests and issues in acme/banda without asking until you take it back in Permissions");
		// never the action anywhere, whatever the ask carries
		for (const ask of [{ permission: merge, place }, { permission: merge, place: earned }, { permission: merge }])
			expect(offeredScopes(ask).some((one) => /anywhere/.test(one.words))).toBe(false);
		// given, the place's shape; refused where it was not offered
		const now = Date.now();
		expect(shapeFor({ scope: "place" }, { permission: merge, place: earned })).toEqual({
			match: place.match,
			what: place.what,
		});
		expect(refusal({ scope: "place" }, merge, undefined, now, offeredScopes({ permission: merge, place }))).toBe(
			"that was not offered",
		);
		expect(
			refusal({ scope: "always" }, merge, undefined, now, offeredScopes({ permission: merge, place: earned })),
		).toBe("that was not offered");
		expect(
			refusal({ scope: "place" }, place, undefined, now, offeredScopes({ permission: merge, place: earned })),
		).toBeUndefined();
	});

	it("a host shape adds the host's, last, and never on the floor or run again", () => {
		const host = { match: { _host: "github.com" }, what: "send anything to github.com", host: "github.com" };
		const words =
			"Send anything to github.com without asking from any of its chats, until you take it back in Permissions; while your agents share one computer, any of them could use it";
		expect(offeredScopes({ permission: shape, host }).map((one) => one.scope)).toEqual([
			"task",
			"hour",
			"today",
			"always",
			"host",
		]);
		expect(offeredScopes({ permission: shape, host }).at(-1)).toEqual({ scope: "host", words, host: "github.com" });
		expect(offeredScopes({ floor: "credentials", host })).toEqual([]);
		expect(offeredScopes({ permission: shape, host, interrupted: true })).toEqual([]);
		// the host's binds its own shape; without one there is nothing to give
		expect(shapeFor({ scope: "host" }, { permission: shape, host })).toEqual({
			match: { _host: "github.com" },
			what: "send anything to github.com",
		});
		expect(shapeFor({ scope: "always" }, { permission: shape, host })).toEqual(shape);
		expect(shapeFor({ scope: "host" }, { permission: shape })).toBeUndefined();
		expect(refusal({ scope: "host" }, undefined, undefined, 0)).toBe("this cannot be allowed ahead");
		const offered = offeredScopes({ permission: shape, host });
		expect(refusal({ scope: "always" }, shape, undefined, 0, offered)).toBeUndefined();
		expect(refusal({ scope: "host" }, shapeFor({ scope: "host" }, { host }), undefined, 0, offered)).toBeUndefined();
		expect(refusal({ scope: "host" }, shape, undefined, 0, offeredScopes({ permission: shape }))).toBe(
			"that was not offered",
		);
	});

	it("covers a call by its route's permission, and by a host permission only in its agent's chats", async () => {
		const harness = await openStore(await tempHome(), { models: createModels(), registry: createRegistry() });
		try {
			const at = 1_000;
			const draft = { tool: "propose_send", args: { _route: "POST github.com/x", _host: "github.com" } };
			await harness.commit(async (tx) => {
				const doc = await tx.doc(Permissions);
				const base = { tool: "propose_send", at, wait: 1 };
				doc.permissions["1"] = {
					...base,
					match: { _route: "POST github.com/x" },
					what: "route",
					scope: "always",
					agent: LEAD,
				};
				doc.permissions["2"] = { ...base, match: { _host: "github.com" }, what: "host", scope: "host", agent: LEAD };
				doc.next = 3;
				// chat 7 runs the lead, chat 8 another agent, chat 9 none the store knows of
				(await tx.doc(AgentChats)).chats[7] = LEAD;
				(await tx.doc(AgentChats)).chats[8] = "ledger";
			}, context);
			const found = () => harness.commit((tx) => covering(tx, draft, 7, at), context);
			expect((await found())?.id).toBe("1");
			// a permission is its agent's: the lead's route covers none of another agent's chats, nor one of no agent
			for (const chat of [8, 9])
				expect(await harness.commit((tx) => covering(tx, draft, chat, at), context), `chat ${chat}`).toBeUndefined();
			// the lead's host covers none of another agent's chats, nor one of no agent
			const hostOnly = { ...draft, args: { ...draft.args, _route: "POST github.com/y" } };
			expect((await harness.commit((tx) => covering(tx, hostOnly, 7, at), context))?.id).toBe("2");
			for (const chat of [8, 9])
				expect(await harness.commit((tx) => covering(tx, hostOnly, chat, at), context), `chat ${chat}`).toBeUndefined();
			// a chat is covered by its own agent's permissions: one that runs another agent is not, one that runs the
			// lead is
			await harness.commit(async (tx) => {
				const { chats } = await tx.doc(AgentChats);
				chats[10] = "researcher";
				chats[11] = LEAD;
			}, context);
			expect(await harness.commit((tx) => covering(tx, hostOnly, 10, at), context)).toBeUndefined();
			expect((await harness.commit((tx) => covering(tx, hostOnly, 11, at), context))?.id).toBe("2");
			expect(
				await harness.commit(
					(tx) => covering(tx, { ...hostOnly, args: { ...hostOnly.args, _host: "api.github.com" } }, 7, at),
					context,
				),
			).toBeUndefined();
			expect(
				await harness.commit((tx) => covering(tx, { ...draft, floor: "credentials" }, 7, at), context),
			).toBeUndefined();
			// another tool with the same argument: never covered by a host permission
			expect(await harness.commit((tx) => covering(tx, { ...draft, tool: "other" }, 7, at), context)).toBeUndefined();
			expect(await revoke(harness, "2", at)).toBe(true);
			expect(await harness.commit((tx) => covering(tx, hostOnly, 7, at), context)).toBeUndefined();
			expect((await found())?.id).toBe("1");
		} finally {
			await harness.close(context);
		}
	});

	it("as a property: never on the floor, the task always first, and words naming the effect", () => {
		fc.assert(
			fc.property(
				fc.record(
					{
						floor: fc.constantFrom(...FLOORS),
						what: fc.string({ minLength: 1, maxLength: 20 }),
						interrupted: fc.boolean(),
						host: fc.constantFrom("github.com", "api.example.com:8443"),
					},
					{ requiredKeys: ["what"] },
				),
				({ floor, what, interrupted, host }) => {
					const offered = offeredScopes({
						...(floor === undefined ? {} : { floor }),
						permission: { match: {}, what },
						...(host === undefined ? {} : { host: { match: { _host: host }, what: `send anything to ${host}`, host } }),
						interrupted,
					});
					const hosts = offered.filter((one) => one.scope === "host");
					expect(hosts.length).toBe(host !== undefined && floor === undefined && !interrupted ? 1 : 0);
					if (floor !== undefined || interrupted) expect(offered).toEqual([]);
					else {
						expect(offered.filter((one) => one.scope !== "host").map((one) => one.scope)).toEqual([
							"task",
							"hour",
							"today",
							"always",
						]);
						for (const one of offered)
							if (one.scope !== "host" && one.scope !== "place") expect(one.words).toBe(scopeWords(what, one.scope));
						expect(offered[0]?.words.toLowerCase()).toContain(what.slice(1).toLowerCase());
					}
				},
			),
			{ numRuns: pbtRuns(100) },
		);
	});

	it("an ask carries its task and its scopes; an answer giving a scope not offered is refused", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const first = await s.say(harness, [{ tool: "send", to: "ana", body: "1" }]);
		const { wait } = await nextAsk(harness, first.turn);
		expect(wait?.ask).toMatchObject({
			errand: { chat: first.chat, input: expect.any(Number) },
			scopes: offeredScopes({ permission: { match: { to: "ana" }, what: "send messages to ana" } }),
		});
		// a scope the ask did not offer is refused: a host's, for a draft with no host
		expect(await approve(harness, wait!.key, { permission: { scope: "host" } })).toEqual({
			refused: "this cannot be allowed ahead",
		});
		expect(await approve(harness, wait!.key)).toMatchObject({ answered: expect.any(Number) });
		await until(() => done(harness, first.turn));
		expect(await openPermissions(harness, s.now())).toEqual([]);
		expect(s.runs.map((run) => run.body)).toEqual(["1"]);
		await harness.close(context);
	});

	it("never asks twice: a permission answers the other open asks it covers, in the commit that gives it", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const one = await s.say(harness, [{ tool: "send", to: "ana", body: "1" }], "a");
		const two = await s.say(harness, [{ tool: "send", to: "ana", body: "2" }], "b");
		const three = await s.say(harness, [{ tool: "send", to: "bob", body: "3" }], "c");
		const open = await until(async () => {
			const waits = await openWaits(harness);
			return waits.length === 3 ? waits : undefined;
		});
		const first = open.find((wait) => wait.chat === one.chat)!;
		expect(await approve(harness, first.key, { permission: { scope: "always" } })).toMatchObject({
			answered: expect.any(Number),
		});
		await until(() => done(harness, one.turn));
		await until(() => done(harness, two.turn));
		// bob's is another permission's to give: still open
		expect((await openWaits(harness)).map((wait) => wait.chat)).toEqual([three.chat]);
		expect(s.runs.map((run) => run.body).sort()).toEqual(["1", "2"]);
		const ended = (await entries(harness, two.chat))
			.filter((entry) => entry.kind === WAIT)
			.map((entry) => entry.data as unknown as WaitEnded);
		expect(ended).toMatchObject([{ outcome: "answered", answer: "approve", permitted: { scope: "always" } }]);
		const permissions = await openPermissions(harness, s.now());
		expect(permissions).toHaveLength(1);
		// the ask it answered in the commit that gave it is what it let run; the approval that gave it is not
		expect(permissions[0]?.permission.ran).toEqual({ count: 1, last: expect.any(Number) });
		// what it serves: the task it was given in, titled by the owner's words
		expect(permissions[0]?.serves).toEqual({ kind: "task", chat: one.chat, input: expect.any(Number), title: "m1" });
		const events = (await harness.snapshot(ActivityLog, context))!.events.map((event) => event.what);
		expect(events.filter((what) => what.startsWith("You allowed"))).toEqual([
			"You allowed send messages to ana, always",
		]);
		await answer(harness, (await openWaits(harness))[0]!.key, "deny", web, "bearer");
		await until(() => done(harness, three.turn));
		await harness.close(context);
	});
	it("a permission given answers only its own agent's open asks, never another agent's of the same shape", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const one = await s.say(harness, [{ tool: "send", to: "ana", body: "1" }], "a");
		const two = await s.say(harness, [{ tool: "send", to: "ana", body: "2" }], "b");
		const open = await until(async () => {
			const waits = await openWaits(harness);
			return waits.length === 2 ? waits : undefined;
		});
		// the second chat runs another agent
		await harness.commit(async (tx) => {
			(await tx.doc(AgentChats)).chats[two.chat] = "mara";
		}, context);
		const first = open.find((wait) => wait.chat === one.chat)!;
		await approve(harness, first.key, { permission: { scope: "always" } });
		await until(() => done(harness, one.turn));
		expect((await openWaits(harness)).map((wait) => wait.chat)).toEqual([two.chat]);
		expect(s.runs.map((run) => run.body)).toEqual(["1"]);
		await answer(harness, (await openWaits(harness))[0]!.key, "deny", web, "bearer");
		await until(() => done(harness, two.turn));
		await harness.close(context);
	});
});

/** One thing that happens, in the property. */
type Step =
	| {
			readonly kind: "message";
			readonly calls: readonly Call[];
			/** How the owner answers each ask the message raises, in order; past the end, deny. */
			readonly answers: readonly Decision[];
	  }
	| { readonly kind: "revoke"; readonly pick: number }
	| { readonly kind: "later" };

type Decision = {
	readonly approve: boolean;
	readonly scope: "once" | "task" | "hour" | "always";
	readonly edit?: string;
};

const callArb: fc.Arbitrary<Call> = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.record({
			tool: fc.constant("send" as const),
			to: fc.constantFrom("ana", "bob"),
			body: fc.constantFrom("a", "b"),
		}),
	},
	{ weight: 1, arbitrary: fc.record({ tool: fc.constant("pay" as const), to: fc.constantFrom("ana", "bob") }) },
);
const decisionArb: fc.Arbitrary<Decision> = fc.record(
	{
		approve: fc.boolean(),
		scope: fc.constantFrom("once", "task", "hour", "always"),
		edit: fc.constantFrom("edited", "other"),
	},
	{ requiredKeys: ["approve", "scope"] },
);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record({
			kind: fc.constant("message" as const),
			calls: fc.array(callArb, { minLength: 1, maxLength: 3 }),
			answers: fc.array(decisionArb, { maxLength: 3 }),
		}),
	},
	{ weight: 1, arbitrary: fc.record({ kind: fc.constant("revoke" as const), pick: fc.nat(5) }) },
	{ weight: 1, arbitrary: fc.constant({ kind: "later" as const }) },
);

/** The reference: a permission as the owner gave it. */
type Given = { id: string; to: string; scope: PermissionScope["scope"]; until?: number; message?: number };

describe("permissions, as a property", () => {
	it(
		"an effect runs only drafted-and-approved or within an open permission, exactly as approved, never twice; the floor is never permitted",
		async () => {
			await fc.assert(
				fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 7 }), async (steps) => {
					const s = setup();
					const harness = await s.open(await tempHome());
					const expected: Call[] = [];
					let given: Given[] = [];
					let next = 1;
					let message = 0;
					const open = (permission: Given) =>
						permission.scope === "always" ||
						(permission.scope === "until" && s.now() < (permission.until ?? 0)) ||
						(permission.scope === "task" && permission.message === message);
					try {
						for (const step of steps) {
							if (step.kind === "later") s.clock.skew += 2 * HOUR;
							else if (step.kind === "revoke") {
								const live = given.filter(open);
								const target = live[step.pick % Math.max(live.length, 1)];
								if (target === undefined) continue;
								expect(await revoke(harness, target.id, s.now())).toBe(true);
								given = given.filter((permission) => permission !== target);
							} else {
								message++;
								const turn = await s.say(harness, step.calls);
								const answers = [...step.answers];
								for (const call of step.calls) {
									const covered =
										call.tool === "send" && given.some((permission) => permission.to === call.to && open(permission));
									const before = expected.length;
									// what the call did: ran, asked, or neither before its run ended
									const did = await until(async () => {
										if (s.runs.length > before) return { ran: true, wait: undefined };
										const [wait] = await openWaits(harness);
										if (wait !== undefined) return { ran: false, wait };
										return (await done(harness, turn.turn)) ? { ran: false, wait: undefined } : undefined;
									});
									const { wait } = did;
									if (covered) {
										expect(did.ran, `${call.tool} to ${call.to} runs within a permission, unasked`).toBe(true);
										expected.push(call);
										continue;
									}
									expect(wait?.ask, `${call.tool} to ${call.to} asks`).toMatchObject({
										tool: call.tool,
										args: { to: call.to },
									});
									// the reference offers what the daemon offers: every scope, the task's first; none on the floor
									expect((wait!.ask as { scopes?: { scope: string }[] }).scopes?.map((one) => one.scope)).toEqual(
										call.tool === "pay" ? [] : ["task", "hour", "today", "always"],
									);
									const decision = answers.shift() ?? { approve: false, scope: "once" };
									if (!decision.approve) {
										await answer(harness, wait!.key, "deny", web, "bearer");
										continue;
									}
									const scope: PermissionScope | undefined =
										decision.scope === "once"
											? undefined
											: decision.scope === "hour"
												? { scope: "until", until: s.now() + HOUR }
												: { scope: decision.scope };
									const edits =
										call.tool === "send" && decision.edit !== undefined ? { body: decision.edit } : undefined;
									const approving: Approving = {
										...(scope === undefined ? {} : { permission: scope }),
										...(edits === undefined ? {} : { edits }),
									};
									if (call.tool === "pay" && scope !== undefined) {
										// the floor: a permission is refused, and the owner approves it once
										expect(await approve(harness, wait!.key, approving, s.now())).toMatchObject({
											refused: expect.any(String),
										});
										await approve(harness, wait!.key, {}, s.now());
									} else {
										expect(await approve(harness, wait!.key, approving, s.now())).toMatchObject({
											answered: expect.any(Number),
										});
										if (scope !== undefined)
											given.push({
												id: String(next++),
												to: call.to,
												scope: scope.scope,
												...(scope.scope === "until" ? { until: scope.until } : {}),
												...(scope.scope === "task" ? { message } : {}),
											});
									}
									expected.push(edits === undefined ? call : { ...call, body: edits.body });
								}
								expect((await nextAsk(harness, turn.turn)).wait).toBeUndefined();
							}
							expect(s.runs).toEqual(expected);
							expect((await openPermissions(harness, s.now())).map(({ id }) => id)).toEqual(
								given.filter(open).map((permission) => permission.id),
							);
						}
					} finally {
						await harness.close(context);
					}
				}),
				{ numRuns: pbtRuns(15) },
			);
		},
		pbtRuns(120) * 1000,
	);
});

describe("the app's permission words and groups", () => {
	const ask = (chat: number, input: number, to: string, extra: object = {}) =>
		({
			type: "approval" as const,
			tool: "send",
			args: { to, body: "hi" },
			permission: { match: { to }, what: `send messages to ${to}` },
			errand: { chat, input },
			scopes: offeredScopes({ permission: { match: { to }, what: `send messages to ${to}` } }),
			...extra,
		}) as Extract<Ask, { type: "approval" }>;

	it("says what a permission let run, and that one a month unused is not used lately", () => {
		const now = new Date(2026, 10, 7, 12).getTime();
		const day = 86_400_000;
		expect(usedWords({ at: now - day }, now)).toBe("Not used yet");
		expect(usedWords({ at: now - 31 * day }, now)).toBe("Not used lately");
		expect(usedWords({ at: now - 40 * day, ran: { count: 2, last: now - day } }, now)).toMatch(/^Used 2 times · last /);
		expect(usedWords({ at: now - 40 * day, ran: { count: 1, last: now - day } }, now)).toMatch(/^Used once · last /);
		expect(usedWords({ at: now - 90 * day, ran: { count: 9, last: now - 30 * day } }, now)).toBe("Not used lately");
	});

	it("reads a typed place by its template and fills the daemon's words with it", () => {
		expect(placeValues("{owner}/{repo}", " purrgrammer/banda ")).toEqual({ owner: "purrgrammer", repo: "banda" });
		for (const typed of ["purrgrammer", "purrgrammer/banda/x", "purr grammer/banda", "/banda", ""])
			expect(placeValues("{owner}/{repo}", typed), typed).toBeUndefined();
		expect(
			grainSentence("merge pull requests in {owner}/{repo}", { owner: "purrgrammer", repo: "banda" }, "@bandarra"),
		).toBe("merge pull requests in purrgrammer/banda as @bandarra");
		expect(grainSentence("merge pull requests anywhere", {}, "@bandarra")).toBe(
			"merge pull requests anywhere as @bandarra",
		);
	});

	it("groups the asks of one task and tool; the floor, an ask with no scope and a run again stand alone", () => {
		const waits = [
			{ key: "a", ask: ask(1, 10, "ana") },
			{ key: "b", ask: ask(2, 20, "ana") },
			{ key: "c", ask: ask(1, 10, "bob") },
			{ key: "d", ask: ask(1, 10, "eve", { scopes: [] }) },
			{ key: "e", ask: ask(1, 10, "kim", { interrupted: true }) },
			{ key: "f", ask: ask(1, 10, "joe", { floor: "private", scopes: [] }) },
			{ key: "g", ask: ask(1, 11, "ana") },
		];
		expect(groupApprovals(waits).map((group) => group.map((wait) => wait.key))).toEqual([
			["a", "c"],
			["b"],
			["d"],
			["e"],
			["f"],
			["g"],
		]);
		expect(sharedScopes([ask(1, 10, "ana"), ask(1, 10, "bob")]).map((one) => one.scope)).toEqual([
			"task",
			"hour",
			"today",
			"always",
		]);
	});

	it("a scope picked becomes the permission the answer gives: a window timed from the answer", () => {
		const now = new Date(2026, 10, 1, 10, 0).getTime();
		expect(scopeOf("task", now)).toEqual({ scope: "task" });
		expect(scopeOf("always", now)).toEqual({ scope: "always" });
		expect(scopeOf("hour", now)).toEqual({ scope: "until", until: now + HOUR });
		expect(scopeOf("today", now)).toEqual({ scope: "until", until: new Date(2026, 10, 1, 23, 59, 59, 999).getTime() });
	});

	it("groups standing permissions by what they serve: tasks, then routines, then the rest", () => {
		const task = { kind: "task" as const, chat: 3, input: 41, title: "Book the train" };
		const groups = servesGroups([
			{ id: "1", what: "a", scope: "always", at: 0 },
			{
				id: "2",
				what: "b",
				scope: "always",
				at: 0,
				serves: { kind: "routine", routine: "news", title: "Morning news" },
			},
			{ id: "3", what: "c", scope: "task", at: 0, serves: task },
			{ id: "4", what: "d", scope: "always", at: 0, serves: task },
		]);
		expect(groups.map((group) => [group.title, group.kind, group.permissions.map((one) => one.id)])).toEqual([
			["For “Book the train”", "task", ["3", "4"]],
			["For “Morning news”", "routine", ["2"]],
			["Other", undefined, ["1"]],
		]);
	});
});
