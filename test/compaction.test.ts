/**
 * Compaction (DESIGN.md "The prompt"): pi-durable's thresholds at one share of each model's window; a compaction
 * shows in the raw transcript as a checkpoint, never as anyone's message, and the context endpoint says how full the
 * chat is against its budget.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { BUDGET_SHARE, budgetPolicy, compactionSettings, summarizedTokens } from "../src/core/compaction.ts";
import { MAIN_THREAD } from "../src/core/gateway.ts";
import { rowOf } from "../src/core/turn.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ChatContext, Item, ItemPage, Posted } from "../src/server/api.ts";
import { itemOf } from "../src/server/transcript.ts";
import { view } from "../web/src/lib/chat.ts";
import { aroundCompaction, cached, dollars, sent, tokens, turnTotals } from "../web/src/lib/usage.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome, until } from "./helpers.ts";

describe("the budget", () => {
	it("is one share of the window, the same for every model, with room to cut on a small one", () => {
		for (const window of [32_000, 200_000, 1_000_000]) {
			const policy = budgetPolicy(window);
			expect(window - policy.reserveTokens).toBe(Math.floor(window * BUDGET_SHARE));
			const budget = window - policy.reserveTokens;
			expect(policy.backgroundTokens).toBeLessThan(budget);
			// what a summary keeps verbatim fits well under the budget, so a cut is always found
			expect(policy.keepRecentTokens).toBeLessThan(budget - policy.backgroundTokens);
		}
	});

	it("is read from the catalog when pi-durable looks a model up; an unknown model keeps the defaults", () => {
		const windows: Record<string, number> = { "a/small": 32_000, "b/large": 1_000_000 };
		const settings = compactionSettings({
			getModel: (provider: string, id: string) =>
				windows[`${provider}/${id}`] === undefined
					? undefined
					: ({ contextWindow: windows[`${provider}/${id}`] } as never),
		});
		expect(settings.modelOverrides?.["a/small"]).toEqual(budgetPolicy(32_000));
		expect(settings.modelOverrides?.["b/large"]?.reserveTokens).toBe(500_000);
		expect(settings.modelOverrides?.["c/unknown"]).toBeUndefined();
		// pi-durable spreads the compaction settings: the overrides survive it
		const spread = { ...{ reserveTokens: 1 }, ...settings };
		expect(spread.modelOverrides?.["a/small"]).toEqual(budgetPolicy(32_000));
	});
});

const compaction = {
	id: 40,
	kind: "pi.compaction",
	head: 31,
	data: { reason: "threshold" },
	model: [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nplan the trip\n</summary>",
				},
			],
			timestamp: 5,
		},
	],
} as unknown as EntryRecord;

describe("what a compaction would summarize", () => {
	it("counts what was said, never the system prompt pi-durable writes again after a compaction", () => {
		const said = (role: string, text: string) => ({
			kind: "x",
			model: [{ role, content: [{ type: "text", text }], timestamp: 0 }],
		});
		const words = "word ".repeat(400);
		const system = { kind: "pi.system", model: [{ role: "system", content: words, timestamp: 0 }] };
		const head = { ...said("user", words), kind: "pi.compaction" };
		expect(summarizedTokens([head, system, system] as never)).toBe(0);
		expect(summarizedTokens([head, system, said("user", words)] as never)).toBeGreaterThan(400);
	});
});

describe("a compaction entry", () => {
	it("is a checkpoint with its summary, never the owner's message, and the chat shows nothing of it", () => {
		const item = itemOf(compaction);
		expect(item).toEqual({ id: 40, role: "compaction", reason: "threshold", summary: "## Goal\nplan the trip", at: 5 });
		const segments = view([item as Item], [], { busy: false, running: [], thinking: false }, {});
		expect(segments).toEqual([]);
	});

	it("is no one's input: whether the owner was answered walks on past it", () => {
		expect(rowOf(compaction)).toBeUndefined();
	});
});

describe("an answer's usage", () => {
	it("carries what the provider reported, and its model", () => {
		const entry = {
			id: 3,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					provider: "p",
					model: "m",
					stopReason: "stop",
					timestamp: 1,
					usage: {
						input: 100,
						output: 20,
						cacheRead: 900,
						cacheWrite: 0,
						reasoning: 5,
						totalTokens: 1020,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
					},
				},
			],
		} as unknown as EntryRecord;
		expect(itemOf(entry)).toMatchObject({
			role: "assistant",
			model: "p/m",
			usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, reasoning: 5, cost: 0.0123 },
		});
	});

	it("reads in words", () => {
		expect([tokens(812), tokens(12_345), tokens(1_200_000), tokens(9_950)]).toEqual(["812", "12k", "1.2M", "9.9k"]);
		expect([dollars(0), dollars(0.0012), dollars(1.5)]).toEqual(["$0", "$0.0012", "$1.50"]);
		expect(cached({ input: 100, output: 1, cacheRead: 900, cacheWrite: 0, cost: 0 })).toBe(0.9);
		expect(cached({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 })).toBeUndefined();
	});

	it("tells a compaction's size before and after from the answers around it", () => {
		const usage = (sent: number, output = 0) => ({ input: sent, output, cacheRead: 0, cacheWrite: 0, cost: 0 });
		const items: Item[] = [
			{ id: 1, role: "assistant", text: "", usage: usage(9_000, 500) },
			{ id: 2, role: "compaction", reason: "threshold", summary: "s" },
			{ id: 3, role: "user", text: "next" },
			{ id: 4, role: "assistant", text: "", usage: usage(2_000) },
		];
		expect(aroundCompaction(items, 2)).toEqual({ before: 9_500, after: 2_000 });
		expect(aroundCompaction(items.slice(1), 2)).toEqual({ after: 2_000 });
	});
});

/** A daemon on the faux model, its model to resize, and how to talk to its main chat. */
async function daemonOnFaux() {
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const web = join(home, "web");
	await mkdir(web, { recursive: true });
	await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
	const { models } = echoModels();
	const model = models.getModel("faux", "faux-1") as { contextWindow: number };
	const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
	const token = (await readDaemonFile(home))!.token!;
	const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
		const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, ...init.headers },
		});
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	};
	/** Say `text` in the main chat and wait for its echo. */
	const say = async (text: string) => {
		const posted = await api<Posted>("/messages", {
			method: "POST",
			body: JSON.stringify({ id: randomUUID(), text, thread: MAIN_THREAD }),
		});
		if (!("chat" in posted) || posted.chat === undefined) throw new Error(`refused: ${JSON.stringify(posted)}`);
		const chat = posted.chat;
		await until(async () => {
			const page = await api<ItemPage>(`/chats/${chat}/items`);
			return page.items.some(
				(item) => item.role === "assistant" && item.calls?.some((call) => call.args.text === `re: ${text}`),
			);
		});
		return chat;
	};
	/** Every item of the chat, oldest first. */
	const all = async (chat: number) => {
		const items: Item[] = [];
		let after = 0;
		for (;;) {
			const page = await api<ItemPage>(`/chats/${chat}/items?after=${after}`);
			items.push(...page.items);
			if (page.next === undefined) return items;
			after = page.next;
		}
	};
	/** The chat's context, once its first answer counted it. */
	const counted = (chat: number) =>
		until(async () => {
			const found = await api<ChatContext>(`/chats/${chat}/context`);
			return found.tokens === undefined ? undefined : found;
		});
	return { daemon, model, api, say, all, counted };
}

describe("a turn's usage", () => {
	it("is each request's own on its answer, and the turn's sum once, at its last", async () => {
		const { daemon, api, say, all } = await daemonOnFaux();
		try {
			let chat = 0;
			for (const text of ["hello", "and the trains?"]) {
				chat = await say(text);
				// the turn ends with the notes after the reply (faux: `sent: …`)
				await until(async () =>
					(await all(chat)).some((item) => item.role === "assistant" && item.text === `sent: re: ${text}`),
				);
			}
			const items = await all(chat);
			const answers = items.filter((item) => item.role === "assistant");
			// two requests a turn: the reply (a tool call) and the notes after it; each carries what its own request took
			expect(answers).toHaveLength(4);
			const [reply, notes] = answers.slice(2);
			expect(reply?.usage).not.toEqual(notes?.usage);
			// nothing copied or carried over: the items add up to what pi-durable counted, request by request
			const context = await api<ChatContext>(`/chats/${chat}/context`);
			const sum = (key: "input" | "output" | "cacheRead" | "cacheWrite") =>
				answers.reduce((n, item) => n + (item.usage?.[key] ?? 0), 0);
			expect({
				input: sum("input"),
				output: sum("output"),
				cacheRead: sum("cacheRead"),
				cacheWrite: sum("cacheWrite"),
			}).toEqual({
				input: context.spent.input,
				output: context.spent.output,
				cacheRead: context.spent.cacheRead,
				cacheWrite: context.spent.cacheWrite,
			});
			// one line a turn, at its notes, with both its requests summed and the context at the last
			const turns = turnTotals(items, false);
			expect([...turns.keys()]).toEqual([answers[1]?.id, answers[3]?.id]);
			const second = turns.get(notes!.id)!;
			expect(second.requests).toBe(2);
			expect(second.model).toBe("faux/faux-1");
			expect(second.usage.input).toBe(reply!.usage!.input + notes!.usage!.input);
			expect(second.usage.cacheRead).toBe(reply!.usage!.cacheRead + notes!.usage!.cacheRead);
			expect(second.context).toBe(sent(notes!.usage!) + notes!.usage!.output);
		} finally {
			await daemon.close();
		}
	});
});

describe("a long chat", () => {
	it("compacts at its budget, shows a checkpoint in the transcript and its context against the budget", async () => {
		const { daemon, model, api, say, all, counted } = await daemonOnFaux();
		try {
			const chat = await say("hello");
			const first = await counted(chat);
			expect(first).toMatchObject({ model: "faux/faux-1", window: model.contextWindow, compacting: false });
			expect(first.budget).toBe(Math.floor(model.contextWindow * BUDGET_SHARE));
			expect(first.since).toBeUndefined();
			// a window whose budget the next few long messages pass: the catalog is read at each request
			model.contextWindow = 2 * (first.tokens! + 3_000);
			const long = (n: number) => `topic ${n}: ${"words about the trip ".repeat(150)}`;
			for (let n = 0; n < 6; n++) await say(long(n));
			const compacted = await until(async () => (await all(chat)).find((item) => item.role === "compaction"));
			if (compacted.role !== "compaction") throw new Error("unreachable");
			expect(compacted.summary).toContain("faux summary");
			// the summary never comes back as the owner's message
			expect((await all(chat)).filter((item) => item.role === "user" && item.text.includes("faux summary"))).toEqual(
				[],
			);
			// the chat goes on after it, and the context says where it starts
			await say("after the summary");
			const after = await api<ChatContext>(`/chats/${chat}/context`);
			expect(after.since).toBeDefined();
			expect(after.spent.input + after.spent.cacheRead + after.spent.cacheWrite).toBeGreaterThan(0);
		} finally {
			await daemon.close();
		}
	}, 120_000);

	it("does not compact on every short turn when what a compaction keeps sits near the threshold", async () => {
		const { daemon, model, say, all, counted } = await daemonOnFaux();
		try {
			const chat = await say("hello");
			const first = await counted(chat);
			// the background threshold just under what the chat holds now: without the guard, every turn compacts
			model.contextWindow = Math.ceil(first.tokens! / 0.4);
			const turns = 40;
			for (let n = 0; n < turns; n++) await say(`note ${n}: ${"a few words ".repeat(25)}`);
			const items = await all(chat);
			const compactions = items.filter((item) => item.role === "compaction").length;
			expect(compactions).toBeGreaterThan(0);
			// without the guard, each of these turns compacts (40 of 40)
			expect(compactions).toBeLessThan(turns / 4);
		} finally {
			await daemon.close();
		}
	}, 120_000);
});
