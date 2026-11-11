import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { CUT_OFF } from "../src/core/cut-off.ts";
import { type Inbound, messageKey, type Origin, OWNER, type Received, routeKey } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, MessageRefs, Routes, type TurnResult } from "../src/core/turn.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

function setup(gateway = new FakeGateway()) {
	const { models } = echoModels();
	const core = defineCore({
		blobs: blobStore(),
		gateway: (name) => (name === gateway.name ? gateway : undefined),
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
		maxAttempts: 4,
	});
	const reports: unknown[] = [];
	const open = async (home: string) => {
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(home, { models, registry, onReport: (error) => reports.push(error) });
		harness.resume();
		return harness;
	};
	return { gateway, core, open, reports };
}

const alice: Origin = { gateway: "fake", peer: "alice" };
const msg = (id: string, text: string, origin = alice): Inbound => ({ id, origin, text });
const turnOf = async (received: Promise<Received>) => {
	const got = await received;
	if (!("turn" in got)) throw new Error(`no Turn: ${JSON.stringify(got)}`);
	return got.turn as TaskId<TurnResult>;
};

async function transcriptKinds(harness: Harness, chat: number) {
	const page = await (await harness.conversation(chat as never, context))!.entries({}, 1000, undefined, context);
	return [...page.items].reverse();
}

async function toolResults(harness: Harness, chat: number) {
	return (await transcriptKinds(harness, chat))
		.filter((e) => e.kind === "pi.tool-result")
		.map((e) =>
			((e.model?.[0] as { content?: { text?: string }[] } | undefined)?.content ?? []).map((p) => p.text).join(""),
		);
}

describe("Turn", () => {
	it("a rate-limited send waits as long as the gateway asked, not its own short delay", async () => {
		class RateLimited extends FakeGateway {
			readonly times: number[] = [];
			override async send(...args: Parameters<FakeGateway["send"]>) {
				this.times.push(Date.now());
				if (this.times.length === 1) throw Object.assign(new Error("Too Many Requests"), { retryAfterMs: 400 });
				return super.send(...args);
			}
		}
		const s = setup(new RateLimited());
		const harness = await s.open(await tempHome());
		const turn = await turnOf(s.core.receive(harness, msg("m1", "hello")));
		await harness.waitForTask(turn, context);
		const [first, second] = (s.gateway as RateLimited).times;
		expect(second! - first!).toBeGreaterThanOrEqual(400);
		await harness.close(context);
	});

	it("answers an inbound with its message to the origin, threaded to the input; the notes stay home", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const turn = await turnOf(s.core.receive(harness, msg("m1", "hello")));
		expect((await harness.waitForTask(turn, context)).state.outcome).toEqual({
			status: "completed",
			result: { ended: "answered" },
		});
		expect(s.gateway.sent).toEqual([{ to: alice, out: { text: "re: hello", replyTo: "m1" }, id: "out-1" }]);
		const routes = await harness.snapshot(Routes, context);
		const chat = routes!.routes[routeKey(alice)]!.chat;
		const refs = await harness.snapshot(MessageRefs, context);
		expect(refs!.messages[messageKey("fake", "m1")]).toEqual({ chat, turn: Number(turn) });
		expect(await toolResults(harness, chat)).toEqual(["Sent."]);
		const inbound = (await transcriptKinds(harness, chat)).find((e) => e.kind === "banda.inbound");
		expect(inbound?.data).toEqual({ origin: alice, message: "m1" });
		expect(s.reports).toEqual([]);
		await harness.close(context);
	});

	it("a redelivered message starts nothing", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const first = await turnOf(s.core.receive(harness, msg("m1", "hello")));
		await harness.waitForTask(first, context);
		expect(await turnOf(s.core.receive(harness, msg("m1", "hello")))).toBe(first);
		await harness.waitForIdle(context);
		expect(s.gateway.sent).toHaveLength(1);
		await harness.close(context);
	});

	it("routes by gateway, peer and thread", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const origins: Origin[] = [
			alice,
			{ gateway: "fake", peer: "bob" },
			{ gateway: "fake", peer: "alice", thread: "t" },
			alice,
		];
		const turns = [];
		for (const [i, origin] of origins.entries())
			turns.push(await turnOf(s.core.receive(harness, msg(`m${i}`, `hi ${i}`, origin))));
		for (const turn of turns) await harness.waitForTask(turn, context);
		const routes = (await harness.snapshot(Routes, context))!.routes;
		expect(Object.keys(routes).sort()).toEqual([origins[0]!, origins[2]!, origins[1]!].map(routeKey).sort());
		expect(new Set(Object.values(routes).map((r) => r.chat)).size).toBe(3);
		expect(
			s.gateway.sent.filter((s) => s.to.peer === "alice" && s.to.thread === undefined).map((s) => s.out.text),
		).toEqual(["re: hi 0", "re: hi 3"]);
		await harness.close(context);
	});

	it("a transient failure retries the same message; a permanent one leaves a notice, and the model hears it", async () => {
		const s = setup();
		s.gateway.fail = (attempt, out) =>
			out.text.includes("perm") ? "permanent" : attempt <= 2 ? "transient" : undefined;
		const harness = await s.open(await tempHome());
		await harness.waitForTask(await turnOf(s.core.receive(harness, msg("m1", "retry me"))), context);
		await harness.waitForTask(await turnOf(s.core.receive(harness, msg("m2", "perm"))), context);
		const chat = (await harness.snapshot(Routes, context))!.routes[routeKey(alice)]!.chat;
		expect(await toolResults(harness, chat)).toEqual(["Sent.", "Not delivered: rejected."]);
		const notice = (await transcriptKinds(harness, chat)).find((e) => e.kind === "banda.notice");
		expect(notice?.data).toMatchObject({ undelivered: { replyTo: "m2", reason: "rejected", attempts: 1 } });
		expect(s.gateway.sent.map((s) => s.out.text)).toEqual(["re: retry me"]);
		await harness.close(context);
	});

	it("gives a message up after too many attempts", async () => {
		const s = setup();
		s.gateway.fail = () => "transient";
		const harness = await s.open(await tempHome());
		const turn = await turnOf(s.core.receive(harness, msg("m1", "hello")));
		const { chat } = (await harness.getTask(turn, context))!.input as { chat: number };
		await harness.waitForTask(turn, context);
		expect(await toolResults(harness, chat)).toEqual(["Not delivered: unreachable."]);
		expect(s.gateway.attempts).toBe(4);
		await harness.close(context);
	});

	it("replies to one origin go out in order, even when an earlier send is slow to succeed", async () => {
		const s = setup();
		s.gateway.fail = (attempt, out) => (out.text === "re: one" && attempt <= 3 ? "transient" : undefined);
		const harness = await s.open(await tempHome());
		const turns = [];
		for (const [i, text] of ["one", "two", "three"].entries())
			turns.push(await turnOf(s.core.receive(harness, msg(`m${i}`, text))));
		for (const turn of turns) await harness.waitForTask(turn, context);
		expect(s.gateway.sent.map((s) => s.out.text)).toEqual(["re: one", "re: two", "re: three"]);
		await harness.close(context);
	});

	it("the owner's input while the agent works steers: it lands after the current tool round, in the same run", async () => {
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
		const s = setup(new Held());
		const gateway = s.gateway as Held;
		const harness = await s.open(await tempHome());
		const owner: Origin = { gateway: "fake", peer: OWNER };
		const first = await turnOf(s.core.receive(harness, msg("m1", "one", owner)));
		await gateway.held;
		const second = await turnOf(s.core.receive(harness, msg("m2", "two", owner)));
		gateway.release();
		for (const turn of [first, second])
			expect((await harness.waitForTask(turn, context)).state.outcome).toEqual({
				status: "completed",
				result: { ended: "answered" },
			});
		expect(gateway.sent.map((sent) => sent.out)).toEqual([
			{ text: "re: one", replyTo: "m1" },
			{ text: "re: two", replyTo: "m2" },
		]);
		const chat = (await harness.snapshot(Routes, context))!.routes[routeKey(owner)]!.chat;
		const kinds = (await transcriptKinds(harness, chat)).map((e) => e.kind).filter((k) => k !== "pi.system");
		expect(kinds).toEqual([
			"banda.inbound",
			"pi.assistant",
			"pi.tool-result",
			"banda.inbound",
			"pi.assistant",
			"pi.tool-result",
			"pi.assistant",
		]);
		await harness.close(context);
	});

	it("a run that fails tells its sender, as nothing else would", async () => {
		const gateway = new FakeGateway();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })]);
		const core = defineCore({
			blobs: blobStore(),
			gateway: () => gateway,
			model: () => FAUX_MODEL,
			retryDelay: () => 5,
		});
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), {
			models,
			registry,
			settings: { retry: { maxRetries: 0 } },
		});
		harness.resume();
		const turn = await turnOf(core.receive(harness, msg("m1", "hello")));
		const { outcome } = (await harness.waitForTask(turn, context)).state;
		expect(outcome).toMatchObject({ status: "completed", result: { failed: expect.stringContaining("overloaded") } });
		await until(() => gateway.sent.length > 0);
		expect(gateway.sent.map((sent) => sent.out.text)).toEqual([expect.stringMatching(/^The run failed: .*overloaded/)]);
		await harness.close(context);
	});

	it("a reply cut off mid tool call fails its run and says why; a cut reply of words alone stands", async () => {
		const gateway = new FakeGateway();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("message_user", { text: "The first half of" }, { id: "c1" })], {
				stopReason: "length",
			}),
			fauxAssistantMessage("Notes cut short", { stopReason: "length" }),
		]);
		const core = defineCore({
			blobs: blobStore(),
			gateway: () => gateway,
			model: () => FAUX_MODEL,
			retryDelay: () => 5,
		});
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), { models, registry, settings: { retry: { maxRetries: 0 } } });
		harness.resume();
		const cut = await turnOf(core.receive(harness, msg("m1", "hello")));
		expect((await harness.waitForTask(cut, context)).state.outcome).toMatchObject({
			status: "completed",
			result: { failed: CUT_OFF },
		});
		await until(() => gateway.sent.length > 0);
		// the call never ran: the half message was not sent, the failure was
		expect(gateway.sent.map((sent) => sent.out.text)).toEqual([`The run failed: ${CUT_OFF}`]);
		const words = await turnOf(core.receive(harness, msg("m2", "again")));
		expect((await harness.waitForTask(words, context)).state.outcome).toMatchObject({
			status: "completed",
			result: { ended: "answered" },
		});
		await harness.close(context);
	});

	it("the prompt tells the agent that only message_user reaches the person", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		const turn = await turnOf(s.core.receive(harness, msg("m1", "hello")));
		await harness.waitForTask(turn, context);
		const chat = (await harness.snapshot(Routes, context))!.routes[routeKey(alice)]!.chat;
		const system = (await transcriptKinds(harness, chat)).find((e) => e.kind === "pi.system");
		expect(JSON.stringify(system?.model)).toContain(
			"sees only what you send them: words and files with `message_user`",
		);
		await harness.close(context);
	});
});
