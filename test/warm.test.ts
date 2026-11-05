import { randomUUID } from "node:crypto";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, type Harness, type ModelRef, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { defineTierSwitch } from "../src/core/agents.ts";
import { type Origin, OWNER } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { presetOf, TIERS } from "../src/core/tiers.ts";
import { defineCore, type TurnResult } from "../src/core/turn.ts";
import { COLD_AFTER, defineWarm } from "../src/server/warm.ts";
import { blobStore, FakeGateway, tempHome } from "./helpers.ts";

const ANTHROPIC = presetOf("anthropic")!;
const CONFIGURED: ModelRef = { provider: "anthropic", modelId: ANTHROPIC.models.deep };
const owner = (thread: string): Origin => ({ gateway: "fake", peer: OWNER, thread });

/** A faux Anthropic that records every request: its model, and its messages as JSON. */
function setup() {
	const requests: { model: string; messages: string[]; maxTokens?: number }[] = [];
	const faux = fauxProvider({
		provider: "anthropic",
		models: [...new Set(TIERS.map((tier) => ANTHROPIC.models[tier]))].map((id) => ({ id })),
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const respond = (
		ctx: { messages: readonly { role: string }[] },
		options: { maxTokens?: number } | undefined,
		_state: unknown,
		model: { id: string },
	) => {
		requests.push({
			model: model.id,
			messages: ctx.messages.map((message) => JSON.stringify(message)),
			...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
		});
		if (ctx.messages.at(-1)?.role === "user")
			return fauxAssistantMessage([fauxToolCall("message_user", { text: "on it" })], { stopReason: "toolUse" });
		return fauxAssistantMessage("done");
	};
	faux.setResponses(Array.from({ length: 1000 }, () => respond as never));
	const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => CONFIGURED });
	const open = async () => {
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(defineTierSwitch(() => CONFIGURED).extension);
		const harness = await openStore(await tempHome(), { models, registry });
		harness.resume();
		return harness;
	};
	return { requests, models, core, open };
}

async function say(s: ReturnType<typeof setup>, harness: Harness, text: string) {
	const got = await s.core.receive(harness, { id: randomUUID(), origin: owner("a"), text });
	if (!("turn" in got)) throw new Error(JSON.stringify(got));
	await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
	return got.chat;
}

describe("warming a chat's prompt cache", () => {
	it("sends what the next request starts with, on the chat's model, once the cache went cold, and once", async () => {
		const s = setup();
		const harness = await s.open();
		try {
			const chat = await say(s, harness, "hi");
			let later = 0;
			const warmer = defineWarm({ harness, models: s.models, now: () => Date.now() + later });
			// it just spoke: the cache is warm
			expect(await warmer.warm(chat)).toEqual({ skipped: "warm" });
			later = COLD_AFTER + 1000;
			const from = s.requests.length;
			const started = await warmer.warm(chat);
			if (!("warming" in started)) throw new Error(JSON.stringify(started));
			await started.warming;
			const warm = s.requests.slice(from);
			expect(warm).toHaveLength(1);
			expect(warm[0]).toMatchObject({ model: ANTHROPIC.models.quick, maxTokens: 1 });
			// warmed now: not again until it goes cold
			expect(await warmer.warm(chat)).toEqual({ skipped: "warm" });
			// the next run's first request starts with exactly what was warmed
			const next = s.requests.length;
			await say(s, harness, "again");
			const first = s.requests[next];
			expect(first?.model).toBe(ANTHROPIC.models.quick);
			expect(first?.messages.slice(0, warm[0]?.messages.length)).toEqual(warm[0]?.messages);
			expect(warm[0]?.messages.at(-1)).toMatch(/"role":"(user|toolResult|system)"/);
			expect(await warmer.warm(999)).toEqual({ skipped: "unknown" });
		} finally {
			await harness.close(context);
		}
	});
});
