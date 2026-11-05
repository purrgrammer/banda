/**
 * The owner's queued messages (src/server/transcript.ts, `queuedInputs` and the live stream's `queued`): what was sent
 * while a run works shows at once from pi-durable's inbox, and leaves it when the run takes it or a stop withdraws it.
 */
import { createRegistry, type Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type Inbound, type Origin, type Outbound, OWNER, routeKey } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, Routes, stop } from "../src/core/turn.ts";
import type { LiveEvent } from "../src/server/api.ts";
import { items, live, queuedInputs } from "../src/server/transcript.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

/** A gateway that holds the first reply until released, so the run is at work while the owner writes again. */
class Held extends FakeGateway {
	release!: () => void;
	#holding!: () => void;
	readonly held = new Promise<void>((resolve) => (this.#holding = resolve));
	override async send(to: Origin, out: Outbound, signal?: AbortSignal) {
		if (this.sent.length === 0) {
			this.#holding();
			// held until released, or until a stop aborts the send
			await new Promise<void>((resolve, reject) => {
				this.release = resolve;
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}
		return super.send(to, out);
	}
}

const owner: Origin = { gateway: "fake", peer: OWNER };
const msg = (id: string, text: string, origin = owner): Inbound => ({ id, origin, text });

async function setup() {
	const gateway = new Held();
	const { models } = echoModels();
	const core = defineCore({
		blobs: blobStore(),
		gateway: (name) => (name === gateway.name ? gateway : undefined),
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
		maxAttempts: 4,
	});
	const registry = createRegistry();
	registry.install(core.extension);
	const harness = await openStore(await tempHome(), { models, registry });
	harness.resume();
	await core.receive(harness, msg("m1", "one"));
	await gateway.held;
	const chat = (await harness.snapshot(Routes, context))!.routes[routeKey(owner)]!.chat;
	return { gateway, core, harness, chat };
}

const said = async (harness: Harness, chat: number) =>
	((await items(harness, chat, {}, context))?.items ?? []).flatMap((item) =>
		item.role === "user" ? [item.message] : [],
	);

describe("the owner's queued messages", () => {
	it("show while the run works, then leave the queue as the run takes them, as their entry", async () => {
		const { gateway, core, harness, chat } = await setup();
		const events: LiveEvent[] = [];
		const watching = new AbortController();
		const streaming = live(harness, chat, (event) => events.push(event), watching.signal);
		await core.receive(harness, msg("m2", "two"));
		const queued = await until(async () => {
			const now = await queuedInputs(harness, chat);
			return now.length > 0 && now;
		});
		expect(queued).toEqual([{ id: expect.any(String), text: "two", message: "m2" }]);
		expect(await said(harness, chat)).toEqual(["m1"]);
		// the stream says it at once, from the inbox
		await until(() => events.some((e) => e.type === "queued" && e.queued.some((q) => q.message === "m2")));
		gateway.release();
		await until(async () => (await said(harness, chat)).includes("m2"));
		await until(async () => (await queuedInputs(harness, chat)).length === 0);
		await until(() => last(events)?.length === 0);
		// the entry came before the queue said it left: never neither
		const entry = events.findIndex((e) => e.type === "entry" && e.item.role === "user" && e.item.message === "m2");
		const left = events.map((e) => e.type === "queued" && e.queued.length === 0).lastIndexOf(true);
		expect(entry).toBeGreaterThan(-1);
		expect(entry).toBeLessThan(left);
		watching.abort();
		await streaming;
		await harness.close(context);
	});

	it("leave the queue when a stop withdraws them, and never reach the transcript", async () => {
		const { gateway, core, harness, chat } = await setup();
		await core.receive(harness, msg("m2", "two"));
		await until(async () => (await queuedInputs(harness, chat)).length > 0);
		await stop(harness, chat);
		expect(await queuedInputs(harness, chat)).toEqual([]);
		gateway.release();
		expect(await said(harness, chat)).not.toContain("m2");
		await harness.close(context);
	});

	it("only the owner's: the daemon's own follow-up waiting for the run is not shown", async () => {
		const { core, harness, chat, gateway } = await setup();
		const conversation = (await harness.conversation(chat as never, context))!;
		await conversation.submit(
			{
				type: "input",
				content: "the answer",
				requestId: "follow-up:1",
				whenBusy: "followUp",
				entry: { kind: "banda.nudge", data: {} },
			},
			context,
		);
		await core.receive(harness, msg("m2", "two"));
		await until(async () => (await queuedInputs(harness, chat)).length > 0);
		expect((await queuedInputs(harness, chat)).map((q) => q.message)).toEqual(["m2"]);
		gateway.release();
		await harness.close(context);
	});
});

const last = (events: readonly LiveEvent[]) => {
	const found = events.filter((e) => e.type === "queued").at(-1);
	return found?.type === "queued" ? found.queued : undefined;
};
