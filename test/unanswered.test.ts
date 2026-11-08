import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
	Type,
} from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTool,
	type Harness,
	type JsonObject,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type Inbound, type Origin, OWNER, type Received, routeKey } from "../src/core/gateway.ts";
import { PROPOSAL_DECIDED } from "../src/core/proposals.ts";
import { WAKE } from "../src/core/routines.ts";
import { openWaits } from "../src/core/status.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, NUDGE, NUDGED, Routes, rowOf, stop, type TurnResult } from "../src/core/turn.ts";
import { type Row, unanswered } from "../src/core/unanswered.ts";
import { itemOf } from "../src/server/transcript.ts";
import { view } from "../web/src/lib/chat.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

const owner: Origin = { gateway: "fake", peer: OWNER };
const alice: Origin = { gateway: "fake", peer: "alice" };

describe("the unanswered rule", () => {
	const end: Row = { role: "assistant", calls: [] };
	const wrote: Row = { role: "user", origin: { peer: OWNER } };
	const acted = (name: string, call: string, error = false): Row[] => [
		{ role: "tool", call, error },
		{ role: "assistant", calls: [{ id: call, name }] },
	];

	it("a run answering the owner that sent them nothing left them unanswered", () => {
		expect(unanswered([end, wrote])).toEqual({ nudged: 0 });
		expect(unanswered([end, ...acted("bash", "a"), wrote])).toEqual({ nudged: 0 });
		// a message refused or given up says nothing
		expect(unanswered([end, ...acted("message_user", "m", true), wrote])).toEqual({ nudged: 0 });
	});

	it("a message, a question or a reaction that went through answers", () => {
		expect(unanswered([end, ...acted("message_user", "m"), wrote])).toBeUndefined();
		// a group member answers in its room
		expect(unanswered([end, ...acted("message_group", "m"), wrote])).toBeUndefined();
	});

	it("the owner acting after the run spoke (a steer, an answer to an ask) is owed an answer again", () => {
		expect(unanswered([end, wrote, ...acted("message_user", "m"), wrote])).toEqual({ nudged: 0 });
		expect(
			unanswered([
				end,
				{ role: "tool", call: "h", error: false },
				{ role: "wait", outcome: "answered", by: { peer: OWNER } },
				{ role: "assistant", calls: [{ id: "h", name: "browser_hand_over" }] },
				...acted("message_user", "m"),
				wrote,
			]),
		).toEqual({ nudged: 0 });
		// an ask that expired, or that a permission answered, is not the owner acting
		for (const wait of [
			{ role: "wait", outcome: "expired" },
			{ role: "wait", outcome: "answered", by: { peer: "permission" } },
		] satisfies Row[])
			expect(unanswered([end, wait, ...acted("message_user", "m"), wrote])).toBeUndefined();
	});

	it("a task going on (a nudge) answers the owner", () => {
		expect(unanswered([end, { role: "nudge" }, end, wrote])).toEqual({ nudged: 1 });
	});

	it("the daemon's word that the owner decided a proposal is no row: the walk goes on past it", () => {
		const decided = {
			id: "7" as never,
			conversationId: "1" as never,
			kind: PROPOSAL_DECIDED,
			data: { proposal: "p", state: "declined" },
			model: [{ role: "user" as const, content: "The owner declined your proposal.", timestamp: 1 }],
		} as unknown as Parameters<typeof rowOf>[0];
		expect(rowOf(decided)).toBeUndefined();
		// so a run that ended without answering the owner after one is still unanswered, and one that answered still did
		expect(unanswered([end, wrote])).toEqual({ nudged: 0 });
	});

	it("a run answering no one's input of the owner's (a wake, another person) may stay silent", () => {
		expect(unanswered([end, { role: "other" }])).toBeUndefined();
		expect(unanswered([end, { role: "user", origin: { peer: "alice" } }])).toBeUndefined();
		expect(
			unanswered([end, { role: "wait", outcome: "answered", by: { peer: OWNER } }, { role: "other" }]),
		).toBeUndefined();
		expect(unanswered([end])).toBeUndefined();
	});
});

/** The trailing user messages of a request, as text: what the model has not answered yet. */
const pending = (ctx: ModelContext) => {
	const at = [...ctx.messages].reverse().findIndex((m) => m.role !== "user");
	return ctx.messages
		.slice(at === -1 ? 0 : ctx.messages.length - at)
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
};
const nudged = (ctx: ModelContext) => pending(ctx).some((text) => text.includes("without answering the owner"));

type Respond = (ctx: ModelContext) => ReturnType<typeof fauxAssistantMessage>;

/** A core over a fake gateway, a model answering by `respond`, and a tool that hands something to the owner. */
function setup(respond: Respond) {
	const gateway = new FakeGateway();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let requests = 0;
	faux.setResponses(
		Array.from(
			{ length: 200 },
			() =>
				((ctx: ModelContext) => {
					requests++;
					return respond(ctx);
				}) as never,
		),
	);
	const core = defineCore({
		blobs: blobStore(),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
		ownerOrigin: () => owner,
	});
	// as the browser's hand-over does: an ask of its own, which the owner ends by giving the browser back
	const handOver = defineTool({
		name: "hand_over",
		description: "Hand something to the owner.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, ctx) => {
			const ended = await core.ask(
				api,
				"hand-over",
				{ type: "question", question: "Do it, then give it back.", options: ["Done"] },
				api.now() + 60_000,
				ctx,
			);
			return { output: [{ type: "text", text: ended === undefined ? "cancelled" : "given back" }] };
		},
	});
	const open = async () => {
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(defineExtension({ name: "test", tools: [handOver] }));
		const harness = await openStore(await tempHome(), { models, registry, settings: { retry: { maxRetries: 0 } } });
		harness.resume();
		return harness;
	};
	return { gateway, core, open, requests: () => requests };
}

const msg = (id: string, text: string, origin = owner): Inbound => ({ id, origin, text });
const turnOf = async (received: Promise<Received>) => {
	const got = await received;
	if (!("turn" in got)) throw new Error(`no Turn: ${JSON.stringify(got)}`);
	return got.turn as TaskId<TurnResult>;
};
const chatOf = async (harness: Harness, origin = owner) =>
	(await harness.snapshot(Routes, context))!.routes[routeKey(origin)]!.chat;
const texts = (gateway: FakeGateway) => gateway.sent.map((sent) => sent.out.text);
const call = (name: string, args: JsonObject, id: string) =>
	fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

/** Every Turn and message so far has ended, those they started included (nudges, notices). */
async function quiet(harness: Harness) {
	for (let seen = -1; ; ) {
		const tasks = await harness.commit(
			async (tx) => [
				...(await tx.scanTasks({ kind: "banda.turn" }, 1000)).items,
				...(await tx.scanTasks({ kind: "banda.message" }, 1000)).items,
			],
			context,
		);
		if (tasks.length === seen) return;
		seen = tasks.length;
		for (const task of tasks) await harness.waitForTask(task.id, context);
	}
}

async function kinds(harness: Harness, chat: number) {
	const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
		{ order: "ascending" },
		1000,
		undefined,
		context,
	);
	return page.items;
}
const nudges = async (harness: Harness, chat: number) =>
	(await kinds(harness, chat)).filter((entry) => entry.kind === NUDGE).length;

describe("a run that leaves the owner unanswered", () => {
	it("ends in its final text alone: nudged once, it answers with message_user, and its notes are never sent", async () => {
		const s = setup((ctx) =>
			nudged(ctx)
				? call("message_user", { text: "Hello back" }, `m${ctx.messages.length}`)
				: pending(ctx).length > 0
					? fauxAssistantMessage("Hello back (my notes)")
					: fauxAssistantMessage("sent it"),
		);
		const harness = await s.open();
		await harness.waitForTask(await turnOf(s.core.receive(harness, msg("m1", "hello"))), context);
		await quiet(harness);
		expect(texts(s.gateway)).toEqual(["Hello back"]);
		expect(s.gateway.sent[0]?.out.replyTo).toBe("m1");
		const chat = await chatOf(harness);
		expect(await nudges(harness, chat)).toBe(1);
		// the nudge is the daemon's, never the owner's words in the chat
		const nudge = (await kinds(harness, chat)).find((entry) => entry.kind === NUDGE)!;
		const instruction = itemOf(nudge);
		expect(instruction).toMatchObject({ role: "instruction", text: NUDGED });
		expect(view(instruction ? [instruction] : [], [], { busy: false, running: [], thinking: false })).toEqual([]);
		expect(JSON.stringify(nudge.model)).toContain(NUDGED.slice(0, 40));
		await harness.close(context);
	});

	it("never answers: nudged exactly once, then the chat says it did not answer", async () => {
		const s = setup(() => fauxAssistantMessage("thinking aloud"));
		const harness = await s.open();
		await harness.waitForTask(await turnOf(s.core.receive(harness, msg("m1", "hello"))), context);
		await quiet(harness);
		const chat = await chatOf(harness);
		expect(await nudges(harness, chat)).toBe(1);
		expect(s.requests()).toBe(2);
		const notices = (await kinds(harness, chat)).filter((entry) => entry.kind === "banda.notice");
		expect(notices.map((entry) => itemOf(entry))).toEqual([
			{ id: expect.any(Number), role: "notice", text: "Sancho didn't answer." },
		]);
		expect(texts(s.gateway)).toEqual(["Sancho didn't answer."]);
		await harness.close(context);
	});

	it("a reaction alone answers; a message then notes answers", async () => {
		const s = setup((ctx) =>
			pending(ctx).some((text) => text.includes("thanks"))
				? call("react", { reaction: "👍" }, `r${ctx.messages.length}`)
				: pending(ctx).length > 0
					? call("message_user", { text: "the answer" }, `m${ctx.messages.length}`)
					: fauxAssistantMessage("done, notes"),
		);
		const harness = await s.open();
		await harness.waitForTask(await turnOf(s.core.receive(harness, msg("m1", "question"))), context);
		await harness.waitForTask(await turnOf(s.core.receive(harness, msg("m2", "thanks"))), context);
		await quiet(harness);
		expect(await nudges(harness, await chatOf(harness))).toBe(0);
		expect(texts(s.gateway)).toEqual(["the answer", "👍"]);
		await harness.close(context);
	});

	it("someone else's message and a routine's wake may stay silent: no nudge", async () => {
		const s = setup((ctx) =>
			pending(ctx).some((text) => text.includes("hello"))
				? call("message_user", { text: "hi" }, `c${ctx.messages.length}`)
				: fauxAssistantMessage("notes"),
		);
		const harness = await s.open();
		await harness.waitForTask(await turnOf(s.core.receive(harness, msg("a1", "just notes", alice))), context);
		await harness.waitForTask(await turnOf(s.core.receive(harness, msg("m1", "hello"))), context);
		const chat = await chatOf(harness);
		await harness.commit(async (tx) => {
			await s.core.followUp(tx, chat, {
				key: "wake-1",
				text: "Check the news.",
				entry: { kind: WAKE, data: { routine: "news", description: "Check the news." } },
			});
		}, context);
		await quiet(harness);
		expect(await nudges(harness, chat)).toBe(0);
		expect(await nudges(harness, await chatOf(harness, alice))).toBe(0);
		expect(texts(s.gateway)).toEqual(["hi"]);
		await harness.close(context);
	});

	it("the browser handed back resumes the run, which must answer again: nudged when it does not", async () => {
		const s = setup((ctx) => {
			if (nudged(ctx)) return call("message_user", { text: "Signed in: your balance is 12." }, "after");
			if (ctx.messages.at(-1)?.role === "user")
				return fauxAssistantMessage(
					[
						fauxToolCall("message_user", { text: "Over to you." }, { id: "m" }),
						fauxToolCall("hand_over", {}, { id: "h" }),
					],
					{ stopReason: "toolUse" },
				);
			return fauxAssistantMessage("signed in, balance 12");
		});
		const harness = await s.open();
		const turn = await turnOf(s.core.receive(harness, msg("m1", "check my balance")));
		await until(async () => (await openWaits(harness)).length > 0 && s.gateway.sent.length >= 2);
		expect(await s.core.receive(harness, msg("m2", "Done"))).toMatchObject({ answered: expect.any(Number) });
		await harness.waitForTask(turn, context);
		await quiet(harness);
		expect(texts(s.gateway)).toEqual([
			"Over to you.",
			expect.stringContaining("Do it, then give it back."),
			"Signed in: your balance is 12.",
		]);
		expect(await nudges(harness, await chatOf(harness))).toBe(1);
		await harness.close(context);
	});

	it("the owner's steer after a message is owed an answer: one nudge for the two Turns of the run", async () => {
		class Held extends FakeGateway {
			release!: () => void;
			#holding!: () => void;
			readonly held = new Promise<void>((resolve) => (this.#holding = resolve));
			override async send(...args: Parameters<FakeGateway["send"]>) {
				if (this.sent.length === 0) {
					this.#holding();
					await new Promise<void>((resolve) => (this.release = resolve));
				}
				return super.send(...args);
			}
		}
		const gateway = new Held();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(
			Array.from(
				{ length: 50 },
				() =>
					((ctx: ModelContext) => {
						if (nudged(ctx)) return call("message_user", { text: "re: two" }, `n${ctx.messages.length}`);
						const inputs = pending(ctx);
						if (inputs.some((text) => text.includes("two"))) return fauxAssistantMessage("two, in notes");
						if (inputs.length > 0) return call("message_user", { text: "re: one" }, "a");
						return fauxAssistantMessage("notes");
					}) as never,
			),
		);
		const core = defineCore({
			blobs: blobStore(),
			gateway: () => gateway,
			model: () => FAUX_MODEL,
			retryDelay: () => 5,
		});
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), { models, registry });
		harness.resume();
		const first = await turnOf(core.receive(harness, msg("m1", "one")));
		await gateway.held;
		const second = await turnOf(core.receive(harness, msg("m2", "two")));
		gateway.release();
		for (const turn of [first, second]) await harness.waitForTask(turn, context);
		await quiet(harness);
		expect(gateway.sent.map((sent) => sent.out.text)).toEqual(["re: one", "re: two"]);
		expect(await nudges(harness, await chatOf(harness))).toBe(1);
		await harness.close(context);
	});

	it("a run that fails or is stopped is not nudged: a failure is told instead", async () => {
		const s = setup((ctx) =>
			pending(ctx).at(-1)?.includes("fail")
				? fauxAssistantMessage("half an answer", { stopReason: "error", errorMessage: "overloaded" })
				: call("hand_over", {}, "h"),
		);
		const harness = await s.open();
		const failed = await turnOf(s.core.receive(harness, msg("m1", "fail")));
		expect((await harness.waitForTask(failed, context)).state.outcome).toMatchObject({
			result: { failed: expect.any(String) },
		});
		const stopped = await turnOf(s.core.receive(harness, msg("m2", "wait for me")));
		await until(async () => (await openWaits(harness)).length > 0);
		await stop(harness, await chatOf(harness));
		await harness.waitForTask(stopped, context);
		await quiet(harness);
		expect(await nudges(harness, await chatOf(harness))).toBe(0);
		expect(texts(s.gateway)).toEqual([
			expect.stringMatching(/^The run failed: .*overloaded/),
			expect.stringContaining("Do it, then give it back."),
		]);
		await harness.close(context);
	});
});
