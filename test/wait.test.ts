import type { Context } from "@earendil-works/chord";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	type Harness,
	type JsonObject,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type Inbound, type Origin, OWNER, type Received } from "../src/core/gateway.ts";
import { openWaits, status } from "../src/core/status.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, fresh, stop } from "../src/core/turn.ts";
import {
	type Ask,
	answer,
	cancelledEnd,
	dismissQuestion,
	normalize,
	outcomeLabel,
	WAIT,
	type WaitEnded,
} from "../src/core/wait.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

const owner: Origin = { gateway: "fake", peer: OWNER };
const bob: Origin = { gateway: "fake", peer: "bob" };

/** A core over a fake gateway, a scripted model, and two effects that record their runs. */
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
	const runs: { tool: string; target: string; key: string }[] = [];
	/** While set, a run blocks until the Harness closes under it. */
	let hold: (() => void) | undefined;
	const effect = (name: string, kind: "idempotent" | "unsafe") =>
		core.effect({
			name,
			description: `${name} a target`,
			parameters: Type.Object({ target: Type.String() }),
			effect: kind,
			run: async (args, { key }, ctx: Context) => {
				runs.push({ tool: name, target: args.target, key });
				if (hold !== undefined) {
					hold();
					const signal = (ctx as { abortSignal?: AbortSignal }).abortSignal;
					await new Promise((_, reject) =>
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
					);
				}
				return { output: [{ type: "text", text: `${name}ed ${args.target}` }] };
			},
		});
	const reports: unknown[] = [];
	const open = async (home: string) => {
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(
			defineExtension({ name: "test", tools: [effect("deploy", "unsafe"), effect("publish", "idempotent")] }),
		);
		const harness = await openStore(home, { models, registry, now, onReport: (error) => reports.push(error) });
		harness.resume();
		return harness;
	};
	const script = (...messages: ReturnType<typeof fauxAssistantMessage>[]) => faux.setResponses(messages);
	const call = (tool: string, args: JsonObject, id = "c1") =>
		fauxAssistantMessage([fauxToolCall(tool, args, { id })], { stopReason: "toolUse" });
	const holding = () => new Promise<void>((resolve) => (hold = resolve));
	const release = () => (hold = undefined);
	return { gateway, core, open, script, call, runs, reports, clock, holding, release };
}

const msg = (id: string, text: string, origin = owner, extra: Partial<Inbound> = {}): Inbound => ({
	id,
	origin,
	text,
	...extra,
});

const asked = (harness: Harness, n = 1) =>
	until(async () => {
		const waits = await openWaits(harness);
		return waits.length >= n ? waits : undefined;
	});

async function entries(harness: Harness, chat: number) {
	const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
		{ order: "ascending" },
		1000,
		undefined,
		context,
	);
	return page.items;
}

const toolResults = async (harness: Harness, chat: number) =>
	(await entries(harness, chat))
		.filter((e) => e.kind === "pi.tool-result")
		.map((e) =>
			((e.model?.[0] as (Message & { content: { text?: string }[] }) | undefined)?.content ?? [])
				.map((p) => p.text)
				.join(""),
		);

const ended = async (harness: Harness, chat: number) =>
	(await entries(harness, chat)).filter((e) => e.kind === WAIT).map((e) => e.data as unknown as WaitEnded);

const turn = (received: Received) => {
	if (!("turn" in received)) throw new Error(`no Turn: ${JSON.stringify(received)}`);
	return received;
};

describe("a Wait stopped with its tool", () => {
	it("keeps an answer that came too late, and says it was not used", () => {
		const input = {
			key: "k",
			ask: { type: "approval", tool: "deploy", args: {} },
			who: "owner",
			deadline: 9,
			call: "c1",
		} as const;
		const by = { gateway: "web", peer: OWNER };
		const late = cancelledEnd(input, { answer: "approve", by, at: 5 }, 7);
		expect(late).toEqual({ ask: input.ask, call: "c1", outcome: "cancelled", answer: "approve", by, at: 5 });
		expect(outcomeLabel(late)).toBe("✗ Stopped before your answer was used");
		const unanswered = cancelledEnd(input, {}, 7);
		expect(unanswered).toEqual({ ask: input.ask, call: "c1", outcome: "cancelled", at: 7 });
		expect(outcomeLabel(unanswered)).toBe("✗ Cancelled");
	});
});

describe("answers", () => {
	const form: Ask = {
		type: "question",
		question: "Export where?",
		fields: [
			{ name: "bucket" },
			{ name: "days", type: "number" },
			{ name: "public", type: "boolean" },
			{ name: "region", type: "choice", options: ["eu-west-1", "us-east-1"] },
			{ name: "prefix", optional: true },
		],
	};
	const picks: Ask = { type: "question", question: "Which?", options: ["a", "b", "c"], multiple: true };

	it("a form's values are typed, from the web's values or the CLI's text alike", () => {
		const typed = { bucket: "archive", days: 30, public: false, region: "eu-west-1" };
		expect(normalize(form, typed)).toEqual({ answer: typed });
		expect(normalize(form, { bucket: " archive ", days: "30", public: "no", region: "EU-WEST-1", prefix: "" })).toEqual(
			{
				answer: typed,
			},
		);
		for (const [values, why] of [
			[{ ...typed, days: "thirty" }, "days is a number"],
			[{ ...typed, public: "maybe" }, "public is yes or no"],
			[{ ...typed, region: "mars" }, "region is one of eu-west-1, us-east-1"],
			[{ ...typed, bucket: "" }, "bucket is required"],
			[{ ...typed, colour: "red" }, "no field colour"],
		] as const)
			expect(normalize(form, values)).toEqual({ invalid: why });
		// text is always the asker's own words
		expect(normalize(form, "the usual bucket")).toEqual({ answer: "the usual bucket" });
	});

	it("several options only where the question takes several", () => {
		expect(normalize(picks, ["a", "c", "a"])).toEqual({ answer: ["a", "c"] });
		expect(normalize(picks, [])).toEqual({ invalid: "pick at least one" });
		expect(normalize({ ...picks, multiple: false }, ["a"])).toEqual({ invalid: "this question takes one answer" });
	});

	it("the model hears what is wrong with an ask it cannot make", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(
			s.call("ask_user", { question: "Pick", fields: [{ name: "size", type: "choice" }] }),
			fauxAssistantMessage("ok"),
		);
		const { turn: id, chat } = turn(await s.core.receive(harness, msg("m1", "go")));
		await harness.waitForTask(id as never, context);
		expect(await toolResults(harness, chat)).toEqual(["Not sent: the choice field size needs at least two options."]);
		await harness.close(context);
	});
});

describe("Wait", () => {
	it("a question may be dismissed once, without an invented answer; an approval may not", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		try {
			s.script(
				s.call("ask_user", { question: "Which colour?", options: ["red", "blue"] }),
				fauxAssistantMessage("Noted."),
			);
			const { turn: id, chat } = turn(await s.core.receive(harness, msg("dismiss-ask", "pick a colour")));
			const [wait] = await asked(harness);
			expect(wait).toBeDefined();
			expect(await dismissQuestion(harness, wait!.key, { gateway: "fake", peer: "bob" }, "bearer")).toMatchObject({
				refused: "this ask is not yours to answer",
			});
			expect(await dismissQuestion(harness, wait!.key, { gateway: "fake", peer: OWNER }, "bearer")).toMatchObject({
				answered: expect.any(Number),
				chat,
			});
			expect(await dismissQuestion(harness, wait!.key, { gateway: "fake", peer: OWNER }, "bearer")).toHaveProperty(
				"refused",
			);
			await harness.waitForTask(id as never, context);
			expect(await ended(harness, chat)).toEqual([
				expect.objectContaining({ outcome: "dismissed", by: { gateway: "fake", peer: OWNER } }),
			]);
			expect((await ended(harness, chat))[0]).not.toHaveProperty("answer");
			expect(await toolResults(harness, chat)).toContain(
				"The owner dismissed this question. Do not ask it again; carry on with what you can.",
			);
		} finally {
			await harness.close(context);
		}
	});

	it("ask: the question goes to the asker, their plain reply answers it, and the tool hears the answer", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(
			s.call("ask_user", { question: "Which colour?", options: ["red", "blue"] }),
			fauxAssistantMessage("Blue it is."),
			fauxAssistantMessage("Noted, red."),
		);
		const { turn: id, chat } = turn(await s.core.receive(harness, msg("m1", "pick a colour")));
		const [wait] = await asked(harness);
		expect(wait).toMatchObject({ chat, ask: { type: "question", question: "Which colour?" } });
		const ask = await until(() => s.gateway.sent.find((sent) => sent.out.ask !== undefined));
		expect(ask.to).toEqual(owner);
		expect(ask.out.ask?.key).toBe(wait?.key);
		expect(ask.out.text).toContain("Which colour?");
		expect((await status(harness)).chats[0]?.state).toBe("waiting");
		// forwarded words are someone else's: a message, queued behind the open ask
		const forwarded = await s.core.receive(harness, msg("m2", "red", owner, { forwarded: true }));
		expect("turn" in forwarded).toBe(true);
		expect(await s.core.receive(harness, msg("m3", "blue, please"))).toEqual({
			answered: expect.any(Number),
			chat,
		});
		// a redelivered answer answers nothing new
		expect(await s.core.receive(harness, msg("m3", "blue, please"))).toEqual({
			answered: expect.any(Number),
			chat,
		});
		await harness.waitForTask(id as never, context);
		expect(await toolResults(harness, chat)).toEqual(["The owner answered:\nblue, please"]);
		expect(await ended(harness, chat)).toEqual([
			expect.objectContaining({ outcome: "answered", answer: "blue, please", by: { gateway: "fake", peer: OWNER } }),
		]);
		// the run's final text is its notes: never sent
		expect(s.gateway.sent.filter((sent) => sent.out.ask === undefined)).toEqual([]);
		await until(async () => (await status(harness)).chats[0]?.state === "idle");
		expect(s.reports).toEqual([]);
		await harness.close(context);
	});

	it("approval: the effect runs once, with the arguments the owner approved", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(s.call("deploy", { target: "prod" }), fauxAssistantMessage("Deployed."), fauxAssistantMessage("ok"));
		const { turn: id, chat } = turn(await s.core.receive(harness, msg("m1", "ship it")));
		const [wait] = await asked(harness);
		expect(wait?.ask).toEqual({
			type: "approval",
			tool: "deploy",
			args: { target: "prod" },
			label: "deploy",
			permission: { match: { target: "prod" }, what: "deploy, target prod" },
			errand: { chat, input: expect.any(Number) },
			scopes: ["task", "hour", "today", "always"].map((scope) => ({ scope, words: expect.any(String) })),
		});
		// plain text never approves: it is a message, queued behind the ask
		expect("turn" in (await s.core.receive(harness, msg("m2", "yes")))).toBe(true);
		const pressed = await s.core.receive(
			harness,
			msg("p1", "", owner, { press: { key: wait!.key, value: "approve" } }),
		);
		expect(pressed).toEqual({ answered: expect.any(Number), chat });
		// first writer wins
		expect(await s.core.receive(harness, msg("p2", "", owner, { press: { key: wait!.key, value: "deny" } }))).toEqual({
			refused: "this ask is closed",
		});
		await harness.waitForTask(id as never, context);
		expect(s.runs.map((r) => [r.tool, r.target])).toEqual([["deploy", "prod"]]);
		expect(await toolResults(harness, chat)).toEqual(["deployed prod"]);
		await harness.close(context);
	});

	it("deny, by `no <id>`: the effect never runs and the model hears why", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(s.call("deploy", { target: "prod" }), fauxAssistantMessage("Understood."));
		const { turn: id, chat } = turn(await s.core.receive(harness, msg("m1", "ship it")));
		const [wait] = await asked(harness);
		expect(await s.core.receive(harness, msg("m2", `no ${wait!.key}`))).toEqual({
			answered: expect.any(Number),
			chat,
		});
		await harness.waitForTask(id as never, context);
		expect(s.runs).toEqual([]);
		expect(await toolResults(harness, chat)).toEqual(["deploy did not run: the owner denied it."]);
		await harness.close(context);
	});

	it("a reply to the ask's own message answers it; an approval takes only yes or no there", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(s.call("deploy", { target: "prod" }), fauxAssistantMessage("Done."));
		const { turn: id, chat } = turn(await s.core.receive(harness, msg("m1", "ship it")));
		const ask = await until(() => s.gateway.sent.find((sent) => sent.out.ask !== undefined));
		expect(await s.core.receive(harness, msg("m2", "sure thing", owner, { replyTo: ask.id }))).toEqual({
			refused: "answer an approval with yes or no",
		});
		expect(await s.core.receive(harness, msg("m3", "Yes", owner, { replyTo: ask.id }))).toEqual({
			answered: expect.any(Number),
			chat,
		});
		await harness.waitForTask(id as never, context);
		expect(s.runs).toHaveLength(1);
		await harness.close(context);
	});

	it("an answer from anyone but the owner is refused", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(s.call("deploy", { target: "prod" }), fauxAssistantMessage("ok"));
		const { turn: id } = turn(await s.core.receive(harness, msg("m1", "ship it")));
		const [approval] = await asked(harness);
		for (const tries of [
			msg("b1", "", bob, { press: { key: approval!.key, value: "approve" } }),
			msg("b2", `yes ${approval!.key}`, bob),
		])
			expect(await s.core.receive(harness, tries)).toEqual({ refused: "this ask is not yours to answer" });
		await s.core.receive(harness, msg("p1", "", owner, { press: { key: approval!.key, value: "deny" } }));
		await harness.waitForTask(id as never, context);

		await harness.close(context);
	});

	it("restart while asking: the same ask is still open; restart while the approved effect runs: asked before again", async () => {
		const s = setup();
		const home = await tempHome();
		let harness = await s.open(home);
		s.script(s.call("deploy", { target: "prod" }), fauxAssistantMessage("Noted."));
		const { turn: id, chat } = turn(await s.core.receive(harness, msg("m1", "ship it")));
		const [before] = await asked(harness);
		await harness.close(context);

		harness = await s.open(home);
		const [after] = await asked(harness);
		expect(after?.key).toBe(before?.key);
		expect((await status(harness)).chats[0]?.state).toBe("waiting");
		const running = s.holding();
		await answer(harness, after!.key, "approve", { gateway: "web", peer: OWNER }, "bearer");
		await running;
		expect((await status(harness)).chats[0]?.state).toBe("running");
		await harness.close(context); // a crash in the middle of an unsafe effect

		s.release();
		harness = await s.open(home);
		const [again] = await until(async () => {
			const waits = await openWaits(harness);
			return waits.some((w) => w.ask.type === "approval" && w.ask.interrupted) ? waits : undefined;
		});
		// running it again is asked once, as it was: no permission is given with it
		expect(again?.ask).toEqual({
			type: "approval",
			tool: "deploy",
			args: { target: "prod" },
			label: "deploy",
			interrupted: true,
		});
		await answer(harness, again!.key, "approve", { gateway: "web", peer: OWNER }, "bearer");
		await harness.waitForTask(id as never, context);
		expect(s.runs.map((r) => r.target)).toEqual(["prod", "prod"]);
		expect(await toolResults(harness, chat)).toEqual(["deployed prod"]);
		await harness.close(context);
	});

	it("an idempotent effect interrupted by a restart runs again with the same key, unasked", async () => {
		const s = setup();
		const home = await tempHome();
		let harness = await s.open(home);
		s.script(s.call("publish", { target: "blog" }), fauxAssistantMessage("Published."));
		const { turn: id } = turn(await s.core.receive(harness, msg("m1", "publish")));
		const [wait] = await asked(harness);
		const running = s.holding();
		await answer(harness, wait!.key, "approve", { gateway: "web", peer: OWNER }, "bearer");
		await running;
		await harness.close(context);
		s.release();
		harness = await s.open(home);
		await harness.waitForTask(id as never, context);
		expect(s.runs.map((r) => r.target)).toEqual(["blog", "blog"]);
		expect(s.runs[1]?.key).toBe(s.runs[0]?.key);
		await harness.close(context);
	});

	it("an approval binds its tool call, never its call id: the same id in a later call asks again", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(s.call("deploy", { target: "staging" }), fauxAssistantMessage("Staged."));
		const first = turn(await s.core.receive(harness, msg("m1", "stage it")));
		const [staging] = await asked(harness);
		await answer(harness, staging!.key, "approve", { gateway: "web", peer: OWNER }, "bearer");
		await harness.waitForTask(first.turn as never, context);
		s.script(s.call("deploy", { target: "prod" }), fauxAssistantMessage("ok"));
		const second = turn(await s.core.receive(harness, msg("m2", "now prod")));
		const [prod] = await asked(harness);
		expect(prod?.key).not.toBe(staging?.key);
		expect(prod?.ask).toMatchObject({ args: { target: "prod" } });
		expect(await answer(harness, staging!.key, "approve", { gateway: "web", peer: OWNER }, "bearer")).toEqual({
			refused: "no open ask has this id",
		});
		expect(s.runs.map((r) => r.target)).toEqual(["staging"]);
		await answer(harness, prod!.key, "deny", { gateway: "web", peer: OWNER }, "bearer");
		await harness.waitForTask(second.turn as never, context);
		expect(s.runs.map((r) => r.target)).toEqual(["staging"]);
		await harness.close(context);
	});

	it("the deadline is decided where the slot is read: an expired approval is denied, a late answer refused", async () => {
		const s = setup();
		const home = await tempHome();
		let harness = await s.open(home);
		s.script(s.call("deploy", { target: "prod" }), fauxAssistantMessage("It expired."));
		const { turn: id, chat } = turn(await s.core.receive(harness, msg("m1", "ship it")));
		const [wait] = await asked(harness);
		await harness.close(context);
		s.clock.skew = 2 * 24 * 60 * 60_000;
		harness = await s.open(home);
		await harness.waitForTask(id as never, context);
		expect(
			await answer(harness, wait!.key, "approve", { gateway: "web", peer: OWNER }, "bearer", {
				now: Date.now() + s.clock.skew,
			}),
		).toEqual({
			refused: "no open ask has this id",
		});
		expect(s.runs).toEqual([]);
		expect(await toolResults(harness, chat)).toEqual(["deploy did not run: the approval expired."]);
		expect((await ended(harness, chat)).map((e) => e.outcome)).toEqual(["expired"]);
		await harness.close(context);
	});

	it("cancel while asking: the ask ends cancelled, and the chat is idle", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(s.call("ask_user", { question: "Colour?" }));
		const { chat } = turn(await s.core.receive(harness, msg("m1", "pick")));
		await asked(harness);
		await (await harness.conversation(chat as ConversationId, context))!.abort(context);
		await until(async () => (await ended(harness, chat)).length === 1 || undefined);
		expect((await ended(harness, chat)).map((e) => e.outcome)).toEqual(["cancelled"]);
		expect(await openWaits(harness)).toEqual([]);
		await until(async () => (await status(harness)).chats[0]?.state !== "waiting" || undefined);
		await harness.close(context);
	});

	it("plain text answers a question only once the ask reached that thread", async () => {
		const s = setup();
		s.gateway.fail = (_attempt, out) => (out.ask === undefined ? undefined : "transient");
		const harness = await s.open(await tempHome());
		s.script(s.call("ask_user", { question: "Which env?" }), fauxAssistantMessage("ok"), fauxAssistantMessage("ok"));
		const { chat } = turn(await s.core.receive(harness, msg("m1", "deploy")));
		const [wait] = await asked(harness);
		// typed before the ask could be seen: a message, queued behind it
		expect("turn" in (await s.core.receive(harness, msg("m2", "also wipe staging")))).toBe(true);
		s.gateway.fail = () => undefined;
		await until(() => s.gateway.sent.find((sent) => sent.out.ask?.key === wait?.key));
		expect(await s.core.receive(harness, msg("m3", "staging"))).toEqual({ answered: expect.any(Number), chat });
		await harness.close(context);
	});

	it("text that names an open ask answers it or is refused, and never reaches the model as a message", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(s.call("deploy", { target: "prod" }), fauxAssistantMessage("Deployed."));
		const { turn: id, chat } = turn(await s.core.receive(harness, msg("m1", "ship it")));
		const [wait] = await asked(harness);
		for (const [n, text] of [`approve ${wait!.key} please`, wait!.key, `maybe ${wait!.key.toUpperCase()}`].entries())
			expect(await s.core.receive(harness, msg(`r${n}`, text))).toEqual({
				refused: `answer an ask by its id with yes ${wait!.key} or no ${wait!.key}`,
			});
		expect(await s.core.receive(harness, msg("m2", `Yes ${wait!.key.toUpperCase()}.`))).toEqual({
			answered: expect.any(Number),
			chat,
		});
		await harness.waitForTask(id as never, context);
		expect(s.runs).toHaveLength(1);
		await harness.close(context);
	});

	it("stop: the run and its ask end, the queued input is withdrawn, and each Turn ends stopped", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(s.call("ask_user", { question: "Colour?" }), fauxAssistantMessage("never"), fauxAssistantMessage("never"));
		const first = turn(await s.core.receive(harness, msg("m1", "pick")));
		await asked(harness);
		const queued = turn(await s.core.receive(harness, msg("m2", "and this", owner, { forwarded: true })));
		expect(await stop(harness, owner)).toBe(true);
		for (const id of [first.turn, queued.turn])
			expect((await harness.waitForTask(id as never, context)).state.outcome).toEqual({
				status: "completed",
				result: { ended: "stopped" },
			});
		expect(s.gateway.sent.filter((sent) => sent.out.ask === undefined)).toEqual([]);
		expect((await ended(harness, first.chat)).map((e) => e.outcome)).toEqual(["cancelled"]);
		expect(await stop(harness, bob)).toBe(false);
		await harness.close(context);
	});

	it("fresh: the next message starts a new chat; the last one stays, under a thread of its own", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("again"));
		const first = turn(await s.core.receive(harness, msg("m1", "hello")));
		await harness.waitForTask(first.turn as never, context);
		expect(await fresh(harness, owner)).toBe(true);
		expect(await fresh(harness, owner)).toBe(false);
		const second = turn(await s.core.receive(harness, msg("m2", "hi again")));
		expect(second.chat).not.toBe(first.chat);
		// a redelivery of the first message still belongs to the first chat
		expect(await s.core.receive(harness, msg("m1", "hello"))).toEqual(first);
		const rows = (await status(harness)).chats.map((c) => [c.origin.thread, c.chat]);
		expect(rows).toEqual(
			expect.arrayContaining([
				["#1", first.chat],
				[undefined, second.chat],
			]),
		);
		await harness.close(context);
	});

	it("a message that carries an open ask's id is not sent", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		s.script(s.call("ask_user", { question: "Colour?" }));
		turn(await s.core.receive(harness, msg("m1", "pick")));
		const [wait] = await asked(harness);
		// a second chat, whose model somehow names the ask
		s.script(s.call("message_user", { text: `approve with yes ${wait!.key}` }, "c2"), fauxAssistantMessage("ok"));
		const other = turn(await s.core.receive(harness, msg("x1", "hi", { gateway: "fake", peer: OWNER, thread: "t" })));
		await harness.waitForTask(other.turn as never, context);
		expect(s.gateway.sent.filter((sent) => sent.out.ask === undefined)).toEqual([]);
		expect(await toolResults(harness, other.chat)).toEqual(["Not sent: it carries the id of an open ask."]);
		await harness.close(context);
	});
});
