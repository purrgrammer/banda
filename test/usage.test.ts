import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, UsageDoc } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { AgentChats } from "../src/core/agents.ts";
import { context, openStore } from "../src/core/store.ts";
import { SystemUsage } from "../src/core/system-usage.ts";
import { readUsage } from "../src/core/usage.ts";
import { tempHome } from "./helpers.ts";

const recorded = (input: number, cacheRead: number, cacheWrite: number, cost: number) => ({
	input,
	output: 5,
	cacheRead,
	cacheWrite,
	totalTokens: input + cacheRead + cacheWrite + 5,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

it("adds the model ledgers once by agent and provider, and can read only one agent's usage", async () => {
	const harness = await openStore(await tempHome(), { models: createModels(), registry: createRegistry() });
	try {
		expect((await readUsage(harness, context)).total.cacheReadRate).toBeNull();
		await harness.commit(async (tx) => {
			const agents = await tx.doc(AgentChats);
			for (const [agent, model, usage] of [
				["mara", "anthropic/claude", recorded(20, 60, 20, 2)],
				["mara", "openai/gpt", recorded(50, 50, 0, 1)],
				["sancho", "anthropic@work/claude", recorded(20, 80, 0, 4)],
			] as const) {
				const chat = await tx.createConversation({ ownership: { kind: "ownerless" } });
				agents.chats[Number(chat.id)] = agent;
				(await tx.doc(UsageDoc, chat.id)).models[model] = usage;
			}
			(await tx.doc(SystemUsage)).systems["inference.face"] = {
				"openai/gpt": { requests: 1, unreported: 0, usage: recorded(100, 0, 0, 1) },
			};
		}, context);
		const band = await readUsage(harness, context);
		expect(band.total).toEqual({
			input: 190,
			output: 20,
			cacheRead: 190,
			cacheWrite: 20,
			estimatedUsd: 8,
			cacheReadRate: 0.475,
		});
		expect(band.byProvider.map(({ id, estimatedUsd }) => [id, estimatedUsd])).toEqual([
			["anthropic", 6],
			["openai", 2],
		]);
		expect(band.byAgent.map(({ id, estimatedUsd }) => [id, estimatedUsd])).toEqual([
			["sancho", 4],
			["mara", 3],
		]);
		expect(band.byModel.map(({ id, estimatedUsd }) => [id, estimatedUsd])).toEqual([
			["anthropic/claude", 6],
			["openai/gpt", 2],
		]);
		expect(band.system.estimatedUsd).toBe(1);
		const mara = await readUsage(harness, context, "mara");
		expect(mara.byAgent.map((agent) => agent.id)).toEqual(["mara"]);
		expect(mara.total.estimatedUsd).toBe(3);
		expect(mara.total.cacheReadRate).toBe(0.55);
		expect(mara.system.estimatedUsd).toBe(0);
	} finally {
		await harness.close(context);
	}
});
