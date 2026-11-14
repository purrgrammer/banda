/**
 * The size of what the daemon sends a client (AGENTS.md principle 14): the shell stream's first push, which every page
 * and every phone over Iroh takes whole each time it connects, and a page of a transcript, which opening a chat reads.
 * A real daemon, on pi-ai's faux provider and the host box, is given a small fixed band: the owner's chat with the lead
 * (`TURNS` messages, each answered through `message_user`), a second agent, and a routine of that agent's run `RUNS`
 * times, which fills a chat no owner ever wrote in. Each shell event (its `data:` line) and each page (the body of
 * `GET /api/chats/:id/items`) is measured in UTF-8 bytes, as sent.
 *
 * These are caps, not the equality test/prompt-budget.test.ts holds a prompt to: what is measured carries entry ids,
 * times, durations and token counts, whose digits differ from run to run, and the point is that a projection does not
 * grow unnoticed; one that shrinks needs no one's word. Each cap is what was measured when it was set plus about a
 * tenth. To raise one on purpose: run this file with `BANDA_STREAM_BUDGET=print`, which prints what it measured,
 * change the cap here, and say the measured size and why in the commit message.
 *
 * A page back in time aims at `PAGE_MESSAGES` messages, read `PAGE` entries a step, and gives up after `PAGE_SCAN`
 * entries. Only the owner's messages and an answer's own text count as messages; a routine's wake and words said
 * through a speaking tool do not. So a chat fed by routines never reaches the target, and its page is every entry it
 * has, up to `PAGE_SCAN`: the last test here states the bound such a page should keep and is marked as failing until
 * it does.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAIN_THREAD } from "../src/core/gateway.ts";
import { MESSAGE_USER } from "../src/core/toolsets.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ChatRow, Item, ItemPage, ShellEvent } from "../src/server/api.ts";
import { PAGE, PAGE_MESSAGES, PAGE_SCAN } from "../src/server/transcript.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { until } from "./helpers.ts";

/** The owner's messages in the lead's chat: more than a page holds, so its page is one of several. */
const TURNS = 24;
/**
 * The routine's runs: two entries each in the chat (its line, what it said), so several steps of `PAGE` entries and far
 * fewer than `PAGE_SCAN`.
 */
const RUNS = 60;

const ASKED = "What needs me this morning? What needs me this morning? What needs me this morning?";
const SAID = "The build is green and two pull requests wait for a review. ".repeat(4).trim();
const HELPER = "---\nname: Helper\ndescription: Looks things up for the owner.\n---\nHELPER INSTRUCTIONS.\n";

/** The most bytes each event of the shell's first push may be, by its type; an event with no cap here fails. */
const SHELL_CAPS: Record<string, number> = {
	chats: 1_000,
	computer: 100,
	control: 5_550,
	companion: 510,
	agents: 2_450,
	memory: 60,
	watches: 40,
	artifacts: 40,
	groups: 80,
	band: 70,
	devices: 100,
	capabilities: 9_450,
};
/**
 * Sent, and not capped: `harnesses` lists the coding agents this computer has installed and how to install the rest, so
 * its size is the machine's, not the code's.
 */
const SHELL_UNCAPPED: ReadonlySet<string> = new Set(["harnesses"]);
/** The most bytes the capped events of the first push may be together: what a client is sent before anything changes. */
const SHELL_CAP = 19_400;
/** The most bytes the newest page of the owner's chat may be. */
const PAGE_CAP = 14_500;
/** The most bytes the newest page of the routine's chat may be, after `RUNS` runs: today, the whole chat. */
const FED_PAGE_CAP = 32_800;

const PRINT = process.env.BANDA_STREAM_BUDGET === "print";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** How many of `items` the page's target counts, as `items` in src/server/transcript.ts does. */
const messages = (items: readonly Item[]) =>
	items.filter((item) => item.role === "user" || (item.role === "assistant" && item.text.trim() !== "")).length;

type Sized<T> = { readonly bytes: number; readonly value: T };

describe("what the daemon sends a client", () => {
	let home = "";
	let close: (() => Promise<void>) | undefined;
	/** The shell's first push: each event's size, by its type. */
	const shell = new Map<string, number>();
	let owned: Sized<ItemPage> | undefined;
	let fed: Sized<ItemPage> | undefined;
	/** Every item of the routine's chat, oldest first. */
	let fedChat: readonly Item[] = [];

	beforeAll(async () => {
		// its own folder, not `tempHome`'s: that one goes after the first test, and every test here reads this daemon
		home = await mkdtemp(join(tmpdir(), "banda-test-"));
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const web = join(home, "web");
		await mkdir(web, { recursive: true });
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// every run says one thing with its chat's speaking tool, then ends with nothing more, as a provider's empty
		// final answer after a tool call does (src/core/empty-replies.ts)
		faux.setResponses(
			Array.from(
				{ length: 4 * (TURNS + RUNS) },
				() => (context: Context) =>
					context.messages.at(-1)?.role === "toolResult"
						? fauxAssistantMessage("")
						: fauxAssistantMessage([fauxToolCall(MESSAGE_USER, { text: SAID })], { stopReason: "toolUse" }),
			),
		);
		const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
		close = () => daemon.close();
		const token = (await readDaemonFile(home))!.token!;
		const base = `http://127.0.0.1:${daemon.port}/api`;
		const headers = { authorization: `Bearer ${token}` };
		const text = async (path: string) => {
			const response = await fetch(`${base}${path}`, { headers });
			if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
			return response.text();
		};
		const get = async <T>(path: string) => JSON.parse(await text(path)) as T;
		const send = async <T>(path: string, body: object, method = "POST"): Promise<T> => {
			const response = await fetch(`${base}${path}`, { method, headers, body: JSON.stringify(body) });
			if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
			return (await response.json()) as T;
		};
		/** Every item of `chat`, read forward a step at a time. */
		const all = async (chat: number) => {
			const found: Item[] = [];
			for (let after = 0; ; ) {
				const page = await get<ItemPage>(`/chats/${chat}/items?after=${after}`);
				found.push(...page.items);
				if (page.next === undefined) return found;
				after = page.next;
			}
		};
		/** `chat` once its `n`th run (each begun by an item of `role`) has ended and nothing runs in it. */
		const settled = (chat: number, role: Item["role"], n: number) =>
			until(async () => {
				const row = (await get<ChatRow[]>("/chats")).find((each) => each.chat === chat);
				if (row?.state !== "idle") return false;
				const items = await all(chat);
				const last = items.at(-1);
				return (
					items.filter((item) => item.role === role).length === n &&
					last?.role === "assistant" &&
					last.stop === "stop" &&
					items
				);
			});
		const page = async (chat: number): Promise<Sized<ItemPage>> => {
			const body = await text(`/chats/${chat}/items`);
			return { bytes: bytes(body), value: JSON.parse(body) as ItemPage };
		};
		await until(async () => existsSync(join(home, "workspace", "agents", "sancho.md")));

		// the owner's chat with the lead
		let lead: number | undefined;
		for (let n = 1; n <= TURNS; n++) {
			await send("/messages", { id: randomUUID(), text: `${n}. ${ASKED}`, thread: MAIN_THREAD });
			lead ??= await until(async () => (await get<ChatRow[]>("/chats"))[0]?.chat);
			await settled(lead, "user", n);
		}
		// a second agent and its routine, run by hand: each run goes to the agent's own chat, which no one else writes in
		await send("/agents/helper", { text: HELPER, base: null }, "PUT");
		const { name } = await send<{ name: string }>("/routines", {
			agent: "helper",
			description: "Morning check",
			when: "cron 0 8 * * *",
			// named, or the control room would spell out this machine's zone
			zone: "UTC",
			ask: "Check the build and the open pull requests, and tell the owner what needs them.",
		});
		let routine: number | undefined;
		for (let n = 1; n <= RUNS; n++) {
			await send(`/routines/${name}/run`, { key: `run-${n}` });
			routine ??= await until(async () => (await get<ChatRow[]>("/chats")).find((row) => row.agent === "helper")?.chat);
			// a run is apart from the chat (DESIGN.md "Routines"): it leaves its line and, after it, what it said
			const chat = routine;
			fedChat = await until(async () => {
				const items = await all(chat);
				const said = items.filter((item) => item.role === "assistant" && (item.calls?.length ?? 0) > 0).length;
				return items.filter((item) => item.role === "wake").length === n && said === n && items;
			});
		}
		owned = await page(lead as number);
		fed = await page(routine as number);

		// the shell's first push, once everything is still: read until every event with a cap came
		const stop = new AbortController();
		const response = await fetch(`${base}/events`, { headers, signal: stop.signal });
		const reader = (response.body as NonNullable<typeof response.body>).getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let leaked = false;
		const reading = (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
					const data = buffer.slice(0, end).replace(/^data: /, "");
					buffer = buffer.slice(end + 2);
					// written again when it changed: the newest of each type is what the client holds
					shell.set((JSON.parse(data) as ShellEvent).type, bytes(data));
					leaked ||= data.includes(home);
				}
			}
		})().catch(() => {
			// aborted below
		});
		await until(() => Object.keys(SHELL_CAPS).every((type) => shell.has(type)));
		stop.abort();
		await reading;
		// no path of this run's temp home is in what was measured, so the sizes are the same on every machine
		expect(leaked).toBe(false);
		for (const each of [owned, fed]) expect(JSON.stringify(each.value)).not.toContain(home);

		if (PRINT)
			console.log(
				JSON.stringify(
					{
						shell: Object.fromEntries(shell),
						shellCapped: [...shell].reduce((sum, [type, size]) => sum + (SHELL_UNCAPPED.has(type) ? 0 : size), 0),
						page: { bytes: owned.bytes, items: owned.value.items.length, messages: messages(owned.value.items) },
						fedPage: { bytes: fed.bytes, items: fed.value.items.length, messages: messages(fed.value.items) },
					},
					null,
					"\t",
				),
			);
	});

	afterAll(async () => {
		await close?.();
		await rm(home, { recursive: true, force: true });
	});

	it("the shell's first push stays under its caps, event by event and whole", () => {
		const grew = "the shell stream grew past its cap: if on purpose, raise the cap in test/stream-budget.test.ts";
		const capped = [...shell].filter(([type]) => !SHELL_UNCAPPED.has(type));
		for (const [type, size] of capped) {
			expect(SHELL_CAPS[type], `the shell's ${type} event has no cap in test/stream-budget.test.ts`).toBeDefined();
			expect(size, `${type}: ${grew}`).toBeLessThanOrEqual(SHELL_CAPS[type] as number);
		}
		const total = capped.reduce((sum, [, size]) => sum + size, 0);
		expect(total, grew).toBeLessThanOrEqual(SHELL_CAP);
	});

	it("a page of the owner's chat reaches its target in one step and stays under its cap", () => {
		const { bytes: size, value } = owned as Sized<ItemPage>;
		// the newest page of several: it reached its messages within the first step of entries
		expect(value.next).toBeDefined();
		expect(messages(value.items)).toBeGreaterThanOrEqual(PAGE_MESSAGES);
		expect(value.items.length).toBeLessThanOrEqual(PAGE);
		expect(
			size,
			"a transcript page grew past its cap: if on purpose, raise PAGE_CAP in test/stream-budget.test.ts",
		).toBeLessThanOrEqual(PAGE_CAP);
	});

	it("a page of a chat fed by routines stays under the cap of what it holds today", () => {
		const { bytes: size, value } = fed as Sized<ItemPage>;
		// the chat is what the runs left, each apart from it: its line, then what it said
		expect(fedChat.filter((item) => item.role === "wake")).toHaveLength(RUNS);
		expect(fedChat.length).toBeLessThan(PAGE_SCAN);
		expect(value.items.length).toBeLessThanOrEqual(fedChat.length);
		expect(
			size,
			"a routine-fed transcript page grew past its cap: if on purpose, raise FED_PAGE_CAP in test/stream-budget.test.ts",
		).toBeLessThanOrEqual(FED_PAGE_CAP);
	});

	// Issue #92's finding. Nothing a routine's run leaves counts toward `PAGE_MESSAGES`, so the scan runs to the chat's
	// first entry (or `PAGE_SCAN` entries) and the page is the whole chat. When paging bounds it, this fails: make it a
	// plain `it` and drop `FED_PAGE_CAP` for `PAGE_CAP` above.
	it.fails("a page of a chat fed by routines is no larger than a page of the owner's chat", () => {
		const { bytes: size, value } = fed as Sized<ItemPage>;
		expect(value.next).toBeDefined();
		expect(size).toBeLessThanOrEqual(PAGE_CAP);
	});
});
