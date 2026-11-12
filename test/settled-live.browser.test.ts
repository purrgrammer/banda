/**
 * Settled asks in the actual app against a temporary daemon with a scripted faux model (#79): a question with choices
 * too long for a line, answered on its card; one answered by typing in the chat; one whose run was stopped; an approval
 * with a long scope, declined on its card; one whose run was stopped; and a long chained command in Activity. At phone
 * width (320 and 390) and desktop, light and dark: no text leaves its card or row, nothing scrolls sideways, each row
 * and card says how its ask ended with its own mark, and the command keeps its last step, which a screen reader hears.
 * Demo effects only log; nothing leaves the machine.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentMainThread } from "../src/core/gateway.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ChatRow, Posted } from "../src/server/api.ts";
import { demoEffects } from "./fixtures/effects.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until, type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const LONG_URL =
	"https://docs.example.test/releases/2026/november/very-long-path-segment-without-breaks/aVeryLongTokenWithoutAnySpaces_0123456789abcdefghijklmnopqrstuvwxyz?ref=pull-request-review";
const TOKEN = "opaque-ref-aVeryLongOpaqueTokenWithoutAnySpacesThatWouldOverflowTheCard_0123456789abcdefghijklmnop";
const ADDRESS = "someone.with.a.really.long.address.that.does.not.fit@subdomain.of.an.example-organisation.test";
const CHAIN =
	"mkdir -p settled-live && cd settled-live && printf 'one two three four five six seven eight' > words.txt && wc -w words.txt && echo pushed-to-origin-main";

let daemon: Daemon;
let web: WebServer;
let base = "";
let token = "";
let chat = 0;
let api: <T>(path: string, body?: unknown, method?: string) => Promise<T>;

const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));
const state = async () => (await api<ChatRow[]>("/chats")).find((row) => row.chat === chat)?.state;
/** Post as the owner, then wait for the run to reach `then`: waiting on an ask, or done. */
const post = async (value: string, then: "waiting" | "idle" = "waiting") => {
	const posted = await api<Extract<Posted, { turn: number }>>("/messages", {
		id: randomUUID(),
		thread: agentMainThread("sancho"),
		text: value,
	});
	chat = posted.chat;
	await until(async () => (await state()) === then);
};

/** The model: a few words, each an ask or a piece of work; effects load through tool search first, as in the app. */
function scripted() {
	const faux = fauxProvider({ tokensPerSecond: 4000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const respond = (context: { messages: readonly { role: string; content: unknown }[] }) => {
		const last = context.messages.filter((message) => message.role !== "system").at(-1);
		const tool = (name: string, args: object) =>
			fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
		const say = (args: object) => tool("message_user", args);
		const asked = text(context.messages.filter((message) => message.role === "user").at(-1)?.content);
		if (last?.role === "toolResult") {
			const result = text(last.content);
			if (/Loaded|No matching tools/.test(result) && asked.includes("ASK_SEND"))
				return tool("send_message", { to: ADDRESS, text: `The link: ${LONG_URL}` });
			if (/^\[?\{?"?type"?:?"?text"?/.test(result) && result.includes("Sent.")) return fauxAssistantMessage("Done.");
			return fauxAssistantMessage("Done.");
		}
		if (last?.role !== "user") return fauxAssistantMessage("Done.");
		const said = text(last.content);
		if (said.includes("without answering the owner")) return say({ text: "Done." });
		if (said.includes("ASK_LONG"))
			return say({ question: `Which notes? The draft: ${LONG_URL}`, options: [LONG_URL, TOKEN] });
		if (said.includes("ASK_CHAT")) return say({ question: "Which branch should I push to?", options: ["main", "dev"] });
		if (said.includes("ASK_STOP"))
			return say({ question: "Should I keep watching the build?", options: ["Yes", "No"] });
		if (said.includes("ASK_SEND")) return tool("tool_search", { query: "send_message" });
		if (said.includes("RUN_CHAIN")) return tool("bash", { command: CHAIN });
		return say({ text: "ok" });
	};
	faux.setResponses(Array.from({ length: 500 }, () => respond as never));
	return models;
}

const field = `document.querySelector('textarea[name="message"]')`;
const button = (words: string) =>
	`[...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === ${JSON.stringify(words)}).at(-1)`;

/** Text that leaves its card or row, unless something clips it, and anything that scrolls sideways. */
const audit = `(() => {
	const spills = [];
	const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let node = walk.nextNode(); node !== null; node = walk.nextNode()) {
		if (node.textContent.trim() === '') continue;
		const frame = node.parentElement.closest('[data-done], [data-tile]');
		if (frame === null) continue;
		let clipped = false;
		for (let el = node.parentElement; el !== frame && el !== null; el = el.parentElement)
			if (getComputedStyle(el).overflowX !== 'visible') clipped = true;
		if (clipped) continue;
		const box = frame.getBoundingClientRect();
		const range = document.createRange();
		range.selectNodeContents(node);
		if ([...range.getClientRects()].some((l) => l.right > box.right + 1 || l.left < box.left - 1)) spills.push(node.textContent.slice(0, 60));
	}
	const sideways = [...document.querySelectorAll('*')]
		.filter((e) => ['auto', 'scroll'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
		.map((e) => String(e.className).slice(0, 40));
	if (document.documentElement.scrollWidth > innerWidth) sideways.push('page');
	return { spills, sideways };
})()`;

/** The audit once the feed has settled (a card that just arrived may still be moving in): clean within 3 s. */
async function settledAudit(page: Page) {
	await page
		.until(`(() => { const a = ${audit}; return a.spills.length === 0 && a.sideways.length === 0; })()`, 3_000)
		.catch(() => {});
	return page.run(audit);
}

/** The page on the agent's chat, in a theme; every earlier message loaded. */
async function onChat<T>(width: number, theme: "light" | "dark", use: (page: Page) => Promise<T>) {
	return withPage(`${base}/#token=${token}`, { width, height: width < 768 ? 844 : 900 }, async (page) => {
		await page.run(`localStorage.setItem('banda.theme', ${JSON.stringify(theme)})`);
		await page.goto(`${base}/#/a/sancho`);
		await page.run("location.reload()");
		await page.until(`!!${field}`);
		for (let i = 0; i < 5; i++) {
			const more = await page.run<boolean>(
				`(() => { const b = ${button("Earlier messages")}; b?.click(); return !!b; })()`,
			);
			if (!more) break;
			await new Promise((resolve) => setTimeout(resolve, 600));
		}
		return use(page);
	});
}

beforeAll(async () => {
	if (!hasChrome()) return;
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	daemon = await startDaemon({
		home,
		port: 0,
		models: scripted(),
		box: hostBox(home),
		effects: demoEffects(() => {}),
		log: () => {},
	});
	token = (await readDaemonFile(home))?.token ?? "";
	await skipShippedSkills(daemon.port, token);
	api = async <T>(path: string, body?: unknown, method?: string): Promise<T> => {
		const res = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
			method: method ?? (body === undefined ? "GET" : "POST"),
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
		return (await res.json()) as T;
	};
	await api("/companion", { name: "Sancho", personality: "Brief." }, "PUT");
	web = await webServer({
		server: {
			proxy: {
				"/api": {
					target: `http://127.0.0.1:${daemon.port}`,
					changeOrigin: true,
					headers: { origin: `http://127.0.0.1:${daemon.port}` },
				},
			},
		},
	});
	base = web.origin;

	// each ask opened by the model and ended as the owner would end it, in the app where the owner can
	await post("ASK_LONG");
	await onChat(320, "light", async (page) => {
		// open, at the narrowest phone: the long choices wrap in their buttons
		await page.until(`!!${button(TOKEN)}`);
		expect(await settledAudit(page)).toEqual({ spills: [], sideways: [] });
		await page.run(`${button(LONG_URL)}.click()`);
		await until(async () => (await state()) === "idle");
	});
	await post("ASK_CHAT");
	await onChat(1440, "light", async (page) => {
		await page.run(`${field}.focus()`);
		await page.input("Input.insertText", { text: "dev, please" });
		await page.run(`document.querySelector('button[aria-label="Send"]').click()`);
		await until(async () => (await state()) === "idle");
	});
	await post("ASK_STOP");
	await api(`/chats/${chat}/stop`, {});
	await until(async () => (await state()) === "idle");
	await post("ASK_SEND");
	await onChat(320, "light", async (page) => {
		// open, at the narrowest phone: the long address in what it asks and in its one scope wraps inside the card
		await page.until(`!!${button("Don't allow")}`);
		expect(await settledAudit(page)).toEqual({ spills: [], sideways: [] });
		await page.run(`${button("Don't allow")}.click()`);
		await until(async () => (await state()) === "idle");
	});
	await post("ASK_SEND");
	await api(`/chats/${chat}/stop`, {});
	await until(async () => (await state()) === "idle");
	await post("RUN_CHAIN", "idle");
}, 180_000);

afterAll(async () => {
	await web?.close();
	await daemon?.close();
});

/** Each settled row: its kind, its words, and what its card says once opened. */
const settled = `(() => [...document.querySelectorAll('[data-done]')].map((row) => {
	const icon = row.querySelector('svg');
	return { kind: row.dataset.done, mark: [...(icon?.classList ?? [])].find((c) => c.startsWith('lucide-') && c !== 'lucide-icon') ?? '', text: row.innerText.replace(/\\s+/g, ' ').trim() };
}))()`;

for (const theme of ["light", "dark"] as const)
	for (const width of [320, 390, 1440])
		it.skipIf(!hasChrome())(
			`each settled ask says how it ended, with its own mark, and fits ${width}px, ${theme}`,
			async () => {
				await onChat(width, theme, async (page) => {
					await page.until(`document.querySelectorAll('[data-done]').length >= 5`).catch(async (error: Error) => {
						throw new Error(
							`${error.message}\nrows: ${JSON.stringify(await page.run(settled))}\nfeed: ${await page.run("document.querySelector('.feed-scroll')?.innerText.slice(-1500)")}`,
						);
					});
					const rows = await page.run<{ kind: string; mark: string; text: string }[]>(settled);
					const row = (words: string) => rows.find((each) => each.text.includes(words));
					expect(row("Which notes?") ?? row("Answered https://docs"), "answered on the card").toMatchObject({
						kind: "answer",
					});
					expect(row("Answered in the chat"), "answered in the chat").toMatchObject({ kind: "answer" });
					expect(row("Stopped before an answer"), "a stopped question").toMatchObject({
						kind: "stopped",
						mark: "lucide-circle-slash",
					});
					expect(row("Didn't send"), "a declined approval").toMatchObject({ kind: "declined", mark: "lucide-x" });
					expect(row("Stopped before it ran"), "a stopped approval").toMatchObject({
						kind: "stopped",
						mark: "lucide-circle-slash",
					});
					expect(rows.some((each) => each.text.includes("Answered below"))).toBe(false);
					expect(rows.filter((each) => each.kind === "declined")).toHaveLength(1);
					// opened, each card says the same, and still nothing leaves it
					await page.run(
						`[...document.querySelectorAll('[data-done] button[aria-label="Show details"]')].forEach((b) => b.click())`,
					);
					await page.until(`document.querySelectorAll('[data-done] [data-tile]').length >= 5`);
					const cards = await page.run<string>(`document.querySelector('.feed-scroll').innerText`);
					for (const words of ["You answered in the chat", "Stopped before an answer", "You said no", LONG_URL])
						expect(cards.replace(/\s+/g, ""), words).toContain(words.replace(/\s+/g, ""));
					expect(await page.run(`document.documentElement.classList.contains('dark')`)).toBe(theme === "dark");
					expect(await settledAudit(page)).toEqual({ spills: [], sideways: [] });
					const shots = process.env.BANDA_SETTLED_SHOTS;
					if (shots !== undefined) {
						await mkdir(shots, { recursive: true });
						await page.shoot(`${shots}/live-${width}-${theme}.png`);
					}
					expect(page.errors()).toEqual([]);
				});
			},
			90_000,
		);

for (const width of [320, 1440])
	it.skipIf(!hasChrome())(
		`a long chained command keeps its last step in Activity, and a screen reader hears it, at ${width}px`,
		async () => {
			await onChat(width, "light", async (page) => {
				// the run's activity: open the last message's
				await page.until(`document.querySelectorAll('button[aria-label="View activity"]').length > 0`);
				await page.run(`[...document.querySelectorAll('button[aria-label="View activity"]')].at(-1).click()`);
				const preview = `[...document.querySelectorAll('[data-tool-preview]')].find((p) => p.textContent.includes('pushed-to-origin-main'))`;
				await page.until(`!!${preview}`);
				const kept = await page.run<{ end: string; whole: boolean; describes: boolean }>(`(() => {
					const shown = ${preview};
					const end = shown.querySelector('[data-keep-end]').lastElementChild;
					const inspect = shown.closest('button');
					const described = (inspect.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
					return { end: end.textContent, whole: end.clientWidth > 0 && end.scrollWidth <= end.clientWidth + 1, describes: described.includes('pushed-to-origin-main') };
				})()`);
				expect(kept).toEqual({ end: "&& echo pushed-to-origin-main", whole: true, describes: true });
				const shots = process.env.BANDA_SETTLED_SHOTS;
				if (shots !== undefined) {
					await mkdir(shots, { recursive: true });
					await page.shoot(`${shots}/live-activity-${width}.png`);
				}
				expect(page.errors()).toEqual([]);
			});
		},
		60_000,
	);
