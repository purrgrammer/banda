/**
 * Opening what two agents said to each other (DESIGN.md "Agents and groups"), through the app against a running
 * daemon: the recipient's "X sent a message" line and the sender's "Messaged X" line each open the exchange at that
 * message, scrolled to and marked; the exchange holds both directions in order and nothing else; it has no composer;
 * back returns to the chat it came from. At desktop and phone width; screenshots when `BANDA_EXCHANGE_SHOTS` names a
 * folder.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { ownerToken } from "../src/home.ts";
import type { ChatRow, ExchangeView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

const asText = (content: ModelContext["messages"][number]["content"]): string =>
	typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

const READER = "---\nname: Reader\ndescription: Reads things\n---\nYou are Reader.\n";
const FIRST = "Please reply: are Friday mornings clear?";
const REPLY = `Reply: ${FIRST}`;
const SECOND = "Thanks, holding the 9:15.";

it.skipIf(!hasChrome())(
	"both lines open the exchange at their message, read only, and back returns to the chat",
	async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const token = await ownerToken(home);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(
			Array.from({ length: 100 }, () => (request: ModelContext) => {
				const last = request.messages.at(-1);
				const said = last?.role === "user" ? asText(last.content) : "";
				const told = /^tell (\S+): (.+)$/s.exec(said);
				if (told !== null)
					return fauxAssistantMessage([fauxToolCall("message_agent", { agent: told[1], text: told[2] })], {
						stopReason: "toolUse",
					});
				const from = /<agent-message from="([^"]+)">\n"(.*)"\n<\/agent-message>/s.exec(said);
				if (from !== null && from[2]?.startsWith("Please reply") === true)
					return fauxAssistantMessage([fauxToolCall("message_agent", { agent: from[1], text: `Reply: ${from[2]}` })], {
						stopReason: "toolUse",
					});
				return fauxAssistantMessage("Noted.");
			}) as never,
		);
		const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home) });
		const base = `http://127.0.0.1:${daemon.port}`;
		const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const response = await fetch(`${base}/api${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
			});
			if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
			return (await response.json()) as T;
		};
		try {
			await skipShippedSkills(daemon.port, token);
			await api("/agents/reader", { method: "PUT", body: JSON.stringify({ text: READER, base: null }) });
			const idle = async () => (await api<ChatRow[]>("/chats")).every((row) => row.state === "idle");
			for (const text of [FIRST, SECOND]) {
				await api("/messages", {
					method: "POST",
					body: JSON.stringify({ id: randomUUID(), thread: "main", text: `tell reader: ${text}` }),
				});
				await until(idle);
			}
			const view = await until(async () => {
				const found = await api<ExchangeView>("/exchanges/sancho/reader");
				return found.items.length === 3 && (await idle()) ? found : undefined;
			});
			expect(view.items.map((item) => [item.from, item.text])).toEqual([
				["sancho", FIRST],
				["reader", REPLY],
				["sancho", SECOND],
			]);
			const [first, reply] = view.items;
			if (first?.call === undefined || reply?.call === undefined) throw new Error("messages without their calls");
			const firstCall: string = first.call;
			const replyCall: string = reply.call;
			const server = await webServer({
				server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
			});
			try {
				for (const width of [1440, 390])
					await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
						const shots = process.env.BANDA_EXCHANGE_SHOTS;
						if (shots !== undefined) await mkdir(shots, { recursive: true });
						const shoot = async (name: string) => {
							if (shots !== undefined) await page.shoot(join(shots, `${width}-${name}.png`));
						};
						const line = (direction: "in" | "out", call: string) =>
							`document.querySelector('a[data-agent-message="${direction}"][href$="call=${encodeURIComponent(call)}"]')`;
						const focused = (call: string) => `document.querySelector('[data-found][data-call="${call}"]')`;
						await page.until("document.body.innerText.includes('Sancho')");

						// the recipient's chat: "Sancho sent a message", twice; the first opens the exchange at the first
						await page.run("location.hash = '#/a/reader'");
						await page.until(`${line("in", firstCall)} !== null && ${line("in", replyCall)} === null`);
						expect(await page.run(`document.querySelectorAll('a[data-agent-message="in"]').length`)).toBe(2);
						expect(await page.run(`${line("in", firstCall)}.innerText.replace(/\\s+/g, ' ').trim()`)).toBe(
							"Sancho sent a message",
						);
						// the recipient's chat shows the message as a line, never its words
						expect(await page.run(`document.body.innerText.includes(${JSON.stringify(FIRST)})`)).toBe(false);
						await shoot("recipient-chat");
						await page.click(line("in", firstCall));
						await page.until(`location.hash === '#/x/reader/sancho?call=${encodeURIComponent(firstCall)}'`);
						await page.until(`${focused(firstCall)} !== null`);
						// marked: its background is the mark's, once the fade in is over
						await page.run(
							`new Promise(done => { const el = ${focused(firstCall)}; el.addEventListener('transitionend', done, { once: true }); setTimeout(done, 900); })`,
						);
						expect(await page.run(`getComputedStyle(${focused(firstCall)}).backgroundColor`)).not.toBe(
							"rgba(0, 0, 0, 0)",
						);
						await shoot("exchange-from-recipient");
						// the whole exchange, in order, with the one it opened at in view and marked
						const texts = await page.run<string[]>(
							`[...document.querySelectorAll('[data-call] [data-message-bubble]')].map(el => el.innerText.trim())`,
						);
						expect(texts).toEqual([FIRST, REPLY, SECOND]);
						expect(
							await page.run(
								`(() => { const r = ${focused(firstCall)}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`,
							),
						).toBe(true);
						expect(await page.run("document.body.innerText.includes('Reader and Sancho')")).toBe(true);
						expect(await page.run("document.body.innerText.includes('Only they write here')")).toBe(true);
						// read only: no composer, no field to type in
						expect(await page.run("document.querySelectorAll('textarea, [contenteditable=\"true\"]').length")).toBe(0);
						// nothing of the chats but the pair's messages: the owner's words stay in the chats
						expect(await page.run("document.body.innerText.includes('tell reader')")).toBe(false);
						expect(await page.run("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
						// the mark fades, and only the one message carried it
						await page.until(`${focused(firstCall)} === null`, 5000);
						expect(await page.run("document.querySelectorAll('[data-found]').length")).toBe(0);
						// back: the chat it came from
						if (width < 768) await page.click(`document.querySelector('button[aria-label="Back to the chat"]')`);
						else await page.run("history.back()");
						await page.until(`location.hash === '#/a/reader'`);
						await page.until(`${line("in", firstCall)} !== null`);

						// the sender's chat: "Messaged Reader" twice and "Reader sent a message" once; each opens at its own
						await page.run("location.hash = '#/a/sancho'");
						await page.until(`${line("out", firstCall)} !== null && ${line("in", replyCall)} !== null`);
						expect(await page.run(`${line("out", firstCall)}.innerText.replace(/\\s+/g, ' ').trim()`)).toBe(
							"Messaged Reader",
						);
						expect(await page.run(`document.querySelectorAll('a[data-agent-message="out"]').length`)).toBe(2);
						await shoot("sender-chat");
						await page.click(line("in", replyCall));
						await page.until(`location.hash === '#/x/sancho/reader?call=${encodeURIComponent(replyCall)}'`);
						await page.until(`${focused(replyCall)} !== null`);
						expect(await page.run("document.body.innerText.includes('Sancho and Reader')")).toBe(true);
						await page.run(
							`new Promise(done => { const el = ${focused(replyCall)}; el.addEventListener('transitionend', done, { once: true }); setTimeout(done, 900); })`,
						);
						await shoot("exchange-from-sender");
						await page.run("history.back()");
						await page.until(`location.hash === '#/a/sancho'`);
						await page.until(`${line("out", firstCall)} !== null`);
						await page.click(line("out", firstCall));
						await page.until(`${focused(firstCall)} !== null`);
						expect(await page.run("location.hash")).toBe(`#/x/sancho/reader?call=${encodeURIComponent(firstCall)}`);

						// a pair with a stranger is no exchange
						await page.run("location.hash = '#/x/sancho/ghost'");
						await page.until('document.body.innerText.includes("This conversation isn\'t in your band.")');
						expect(page.errors()).toEqual([]);
					});
			} finally {
				await server.close();
			}
		} finally {
			await daemon.close();
		}
	},
	120_000,
);
