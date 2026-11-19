/**
 * The exchange between two agents (DESIGN.md "Agents and groups"): what `message_agent` delivered each way, read from
 * both direct chats as one conversation, oldest first, each message naming the call that sent it; paged so a page never
 * interleaves out of order with the next; nothing of either chat's turns, tools or the owner's words in it. Over the
 * API it is the owner's alone: the token or nothing, and no such pair when either is no agent of the band.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted, agentPath, LEAD_TEXT, shaOf } from "../src/core/agents.ts";
import { agentMainThread, OWNER } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, type TurnResult } from "../src/core/turn.ts";
import { startDaemon } from "../src/daemon.ts";
import { ownerToken } from "../src/home.ts";
import type { ChatRow, ExchangeMessage, ExchangeView } from "../src/server/api.ts";
import { exchange, type Fetched, mergeExchange } from "../src/server/routes/exchanges.ts";
import { items } from "../src/server/transcript.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

const asText = (content: ModelContext["messages"][number]["content"]): string =>
	typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

/**
 * The model, scripted by the words it reads: the owner's "tell reader: X" has the lead message reader X; a message
 * that reaches reader asking for a reply has it message the lead back; anything else ends the turn in words.
 */
function scripted() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const respond = (request: ModelContext) => {
		const last = request.messages.at(-1);
		const said = last?.role === "user" ? asText(last.content) : "";
		const told = /^tell (\S+): (.+)$/s.exec(said);
		if (told !== null)
			return fauxAssistantMessage([fauxToolCall("message_agent", { agent: told[1], text: told[2] })], {
				stopReason: "toolUse",
			});
		const from = /<agent-message from="([^"]+)">\n"(.*)"\n<\/agent-message>/s.exec(said);
		// a reply is never answered: the two would go on for ever
		if (from !== null && from[2]?.includes("reply") === true && !from[2].startsWith("Reply:"))
			return fauxAssistantMessage(
				[fauxToolCall("message_agent", { agent: from[1], text: `Reply: ${from[2].replace(/\\n/g, " ")}` })],
				{ stopReason: "toolUse" },
			);
		return fauxAssistantMessage("Noted.");
	};
	faux.setResponses(Array.from({ length: 200 }, () => respond as never));
	return models;
}

const READER = "---\nname: Reader\ndescription: Reads things\n---\nYou are Reader.\n";

const message = (over: Partial<ExchangeMessage>): ExchangeMessage => ({
	chat: 1,
	entry: 1,
	from: "a",
	to: "b",
	text: "",
	at: 0,
	...over,
});

describe("merging the two sides into pages", () => {
	it("keeps everything when neither side has older messages, oldest first", () => {
		const a: Fetched = { items: [message({ chat: 2, entry: 5, at: 50 })], more: false, last: 5 };
		const b: Fetched = {
			items: [message({ chat: 1, entry: 3, at: 30, from: "b", to: "a" }), message({ chat: 1, entry: 9, at: 90 })],
			more: false,
			last: 3,
		};
		const page = mergeExchange([a, b]);
		expect(page.items.map((item) => item.at)).toEqual([30, 50, 90]);
		expect(page.next).toBeUndefined();
	});

	it("holds the other side's older messages back to where an unread side could interleave", () => {
		// side a is whole from entry 20 up; side b has nothing older: its message at 10 waits for the next page
		const a: Fetched = { items: [message({ chat: 2, entry: 20, at: 200 })], more: true, last: 20 };
		const b: Fetched = {
			items: [message({ chat: 1, entry: 4, at: 100 }), message({ chat: 1, entry: 6, at: 300 })],
			more: false,
			last: 4,
		};
		const page = mergeExchange([a, b]);
		expect(page.items.map((item) => item.at)).toEqual([200, 300]);
		// a reads below 20 next; b below its oldest kept message, where the held one is
		expect(page.next).toBe("20.6");
	});

	it("holds everything back while an unread side gave nothing yet, and reads that side on", () => {
		const a: Fetched = { items: [], more: true, last: 1500 };
		const b: Fetched = { items: [message({ chat: 1, entry: 4, at: 100 })], more: false, last: 4 };
		const page = mergeExchange([a, b]);
		expect(page.items).toEqual([]);
		expect(page.next).toBe("1500.5");
	});

	it("ends a side at 0 once it is read whole", () => {
		const a: Fetched = { items: [], more: false, last: undefined };
		const b: Fetched = { items: [message({ chat: 1, entry: 4, at: 100 })], more: true, last: 4 };
		expect(mergeExchange([a, b]).next).toBe("0.4");
	});
});

describe("the exchange read from the store", () => {
	it("is both directions in order, each message naming its call, paged whole, and nothing else of either chat", async () => {
		const models = scripted();
		const registry = createRegistry();
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), { models, registry });
		try {
			await harness.commit(async (tx) => {
				const accepted = await tx.doc(Accepted);
				accepted.files[agentPath("reader")] = { sha: shaOf(READER), text: READER, at: 1 };
				const lead = accepted.files[agentPath("sancho")];
				if (lead === undefined) throw new Error("missing lead definition");
				accepted.files[agentPath("sancho")] = { ...lead, text: LEAD_TEXT, sha: shaOf(LEAD_TEXT) };
			}, context);
			harness.resume();
			// before anyone wrote: the pair exists, with nothing between them; a stranger makes no pair
			expect(await exchange(harness, core.directChat, "sancho", "reader", undefined, context)).toEqual({
				agents: ["sancho", "reader"],
				items: [],
			});
			expect(await exchange(harness, core.directChat, "sancho", "nobody", undefined, context)).toBeUndefined();
			const texts = ["First, please reply", "Second", "Third, please reply too", "Fourth", "Fifth"];
			for (const [n, text] of texts.entries()) {
				const started = await core.receive(harness, {
					id: `owner-${n}`,
					// the lead's one chat, as the app addresses it: where a reply to the lead lands too
					origin: { gateway: "web", peer: OWNER, thread: agentMainThread("sancho") },
					text: `tell reader: ${text}`,
					agent: "sancho",
				});
				if (!("turn" in started)) throw new Error(JSON.stringify(started));
				await harness.waitForTask(started.turn as TaskId<TurnResult>, context);
			}
			// five went to reader, two replies came back to the lead
			const whole = await until(async () => {
				const view = await exchange(harness, core.directChat, "sancho", "reader", undefined, context);
				return view !== undefined && view.items.length === 7 ? view : undefined;
			});
			expect(whole.next).toBeUndefined();
			expect(whole.items.map((item) => [item.from, item.to, item.text])).toEqual([
				["sancho", "reader", "First, please reply"],
				["reader", "sancho", "Reply: First, please reply"],
				["sancho", "reader", "Second"],
				["sancho", "reader", "Third, please reply too"],
				["reader", "sancho", "Reply: Third, please reply too"],
				["sancho", "reader", "Fourth"],
				["sancho", "reader", "Fifth"],
			]);
			expect(whole.items.map((item) => item.at)).toEqual([...whole.items.map((item) => item.at)].sort((a, b) => a - b));
			// each message is the entry in the recipient's chat, and names the sender's call
			const readerChat = await core.directChat(harness, "reader", context);
			const leadChat = await core.directChat(harness, "sancho", context);
			for (const item of whole.items) {
				expect(Object.keys(item).sort()).toEqual(["at", "call", "chat", "entry", "from", "text", "to"]);
				expect(item.chat).toBe(item.to === "reader" ? readerChat : leadChat);
				// the sender's own transcript, as the app reads it, holds that call: its "Messaged X" line names it
				const calls: string[] = [];
				for (let after: number | undefined = 0; after !== undefined; ) {
					const page = await items(harness, item.from === "reader" ? (readerChat ?? 0) : (leadChat ?? 0), { after });
					for (const said of page?.items ?? [])
						if (said.role === "assistant")
							for (const call of said.calls ?? []) if (call.name === "message_agent") calls.push(call.id);
					after = page?.next;
				}
				const made = item.call !== undefined && calls.includes(item.call);
				expect(made, `call ${item.call} is the sender's`).toBe(true);
			}
			// the same reversed: the pair in either order reads the same messages
			const reversed = await exchange(harness, core.directChat, "reader", "sancho", undefined, context);
			expect(reversed?.items).toEqual(whole.items);
			// paged small: the pages put together are the whole, in order, with no message twice or missing
			const pages: ExchangeMessage[][] = [];
			let before: string | undefined;
			for (let n = 0; n < 20; n++) {
				const page = await exchange(harness, core.directChat, "sancho", "reader", before, context, 2);
				if (page === undefined) throw new Error("the pair went missing");
				pages.push([...page.items]);
				before = page.next;
				if (before === undefined) break;
			}
			expect(before).toBeUndefined();
			expect(pages.length).toBeGreaterThan(1);
			const together = pages.reverse().flat();
			expect(together).toEqual(whole.items);
		} finally {
			await harness.close(context);
		}
	});
});

describe("GET /api/exchanges", () => {
	it("is the owner's: the token or nothing, two different agents of the band, a cursor a page gave", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const token = await ownerToken(home);
		const daemon = await startDaemon({ home, port: 0, models: scripted(), log: () => {}, box: hostBox(home) });
		const base = `http://127.0.0.1:${daemon.port}`;
		const raw = (path: string, init: RequestInit = {}, auth = true) =>
			fetch(`${base}/api${path}`, {
				...init,
				headers: {
					...(auth ? { authorization: `Bearer ${token}` } : {}),
					"content-type": "application/json",
					...init.headers,
				},
			});
		const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const response = await raw(path, init);
			if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
			return (await response.json()) as T;
		};
		try {
			await api("/agents/reader", { method: "PUT", body: JSON.stringify({ text: READER, base: null }) });
			expect((await raw("/exchanges/sancho/reader", {}, false)).status).toBe(401);
			expect((await raw("/exchanges/sancho/sancho")).status).toBe(400);
			expect((await raw("/exchanges/sancho/ghost")).status).toBe(404);
			expect((await raw("/exchanges/Sancho/reader")).status).toBe(400);
			expect((await raw("/exchanges/sancho/reader?before=abc")).status).toBe(400);
			expect(await api<ExchangeView>("/exchanges/sancho/reader")).toEqual({ agents: ["sancho", "reader"], items: [] });
			await api("/messages", {
				method: "POST",
				body: JSON.stringify({ id: randomUUID(), thread: "main", text: "tell reader: Hello, please reply" }),
			});
			const view = await until(async () => {
				const found = await api<ExchangeView>("/exchanges/reader/sancho");
				return found.items.length === 2 ? found : undefined;
			});
			expect(view.items.map((item) => [item.from, item.text])).toEqual([
				["sancho", "Hello, please reply"],
				["reader", "Reply: Hello, please reply"],
			]);
			expect(view.items.every((item) => typeof item.call === "string" && item.call !== "")).toBe(true);
			// an owner's words never cross: the chats hold them, the exchange does not
			const rows = await api<ChatRow[]>("/chats");
			expect(rows.length).toBe(2);
			expect(JSON.stringify(view)).not.toContain("tell reader");
			await until(
				async () =>
					rows.every((row) => row.state === "idle") ||
					(await api<ChatRow[]>("/chats")).every((row) => row.state === "idle"),
			);
		} finally {
			await daemon.close();
		}
	});
});
