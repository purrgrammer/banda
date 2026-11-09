import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { until, type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

/**
 * The thinking selector in a real page, on the shell's real store and stream, against a daemon the test plays: a pick
 * shows at once and says it is saving; a refused one goes back with a notice; a saved one is what the selector shows
 * when it opens again; and neither a pick nor the stream's echo of it renders the screen that holds the shell.
 */
const fixture = fileURLToPath(new URL("../web/thinking-tiers-fixture.tsx", import.meta.url));
let server: WebServer | undefined;
let base = "";

/** The page's open stream and the tier saves it sent, each waiting for the test to answer it. */
let stream: ServerResponse | undefined;
let saves: { tier: string; answer: (status: number) => void }[] = [];

const row = (tier: string, excerpt = "Hello") => ({
	chat: 1,
	origin: { kind: "agent", agent: "sancho", main: true },
	agent: "sancho",
	title: "A chat",
	state: "idle",
	unanswered: 0,
	unread: 0,
	read: 0,
	excerpt,
	tier,
});
const tell = (rows: object[]) => stream?.write(`data: ${JSON.stringify({ type: "chats", rows })}\n\n`);

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
		plugins: [
			{
				name: "thinking-tiers-fixture",
				resolveId(id) {
					if (id === "/thinking-tiers-fixture.tsx") return fixture;
				},
				load(id) {
					if (id !== fixture) return;
					return `import React, { useState } from 'react';
					import { createRoot } from 'react-dom/client';
					import { Toaster } from '/src/components/ui/sonner.tsx';
					import { ChatThinking } from '/src/app/ChatThinking.tsx';
					import { useShell } from '/src/lib/shell.ts';
					import '/src/styles/globals.css';
					window.screens = 0;
					function Screen() {
						const shell = useShell();
						const [open, setOpen] = useState(true);
						window.screens++;
						window.setOpen = setOpen;
						return <main>
							<p id="excerpt">{shell.rows[0]?.excerpt}</p>
							{open ? <ChatThinking chat={shell.rows[0]?.chat} /> : null}
							<Toaster />
						</main>;
					}
					createRoot(document.getElementById('root')).render(<Screen />);`;
				},
				configureServer(vite) {
					vite.middlewares.use((req, res, next) => {
						const path = (req.url ?? "").split("?")[0] ?? "";
						if (path === "/thinking-tiers-fixture") {
							void vite
								.transformIndexHtml(
									req.url ?? "",
									'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/thinking-tiers-fixture.tsx"></script></body></html>',
								)
								.then((html) => {
									res.setHeader("content-type", "text/html");
									res.end(html);
								});
							return;
						}
						if (!path.startsWith("/api/")) return next();
						if (path === "/api/events") {
							res.setHeader("content-type", "text/event-stream");
							res.write(": fixture\n\n");
							stream = res;
							tell([row("balanced")]);
							return;
						}
						if (path === "/api/chats/1/tier" && req.method === "POST") {
							let body = "";
							req.on("data", (chunk) => {
								body += String(chunk);
							});
							req.on("end", () => {
								const { tier } = JSON.parse(body) as { tier: string };
								saves.push({
									tier,
									answer: (status) => {
										res.statusCode = status;
										res.setHeader("content-type", "application/json");
										res.end(JSON.stringify(status === 200 ? { tier } : { error: "the store is busy" }));
									},
								});
							});
							return;
						}
						res.setHeader("content-type", "application/json");
						res.end("{}");
					});
				},
			},
		],
	});
	base = server.origin;
});

afterAll(async () => {
	await server?.close();
});

const radio = (name: string) =>
	`[...document.querySelectorAll('[role=radio]')].find((one) => one.textContent === '${name}')`;
const group = `document.querySelector('[role=radiogroup]')`;
const checked = (page: Page) =>
	page.run<string[]>(`[...document.querySelectorAll('[role=radio][aria-checked=true]')].map((one) => one.textContent)`);
const busy = (page: Page) => page.run<string | null>(`${group}.getAttribute('aria-busy')`);
const screens = (page: Page) => page.run<number>("window.screens");
/** Until the daemon the test plays holds `count` saves: the page's request has reached it. */
const saved = async (count: number) => {
	await until(() => saves.length >= count);
	expect(saves.length).toBe(count);
};

it.runIf(hasChrome()).each([
	["desktop", 1280],
	["phone", 390],
])("a pick shows at once, saves, goes back when refused and stays when saved, at %s", async (_label, width) => {
	saves = [];
	stream = undefined;
	await withPage(`${base}/thinking-tiers-fixture#token=tier-test`, { width, height: 800 }, async (page) => {
		await page.until(`${group} !== null && ${radio("Balanced")}?.getAttribute('aria-checked') === 'true'`);
		await page.until(`${radio("Deep")}.disabled === false`);
		const before = await screens(page);

		// optimistic: the daemon has not answered, and the owner already sees the pick, and that it is saving
		await page.run(`${radio("Deep")}.click()`);
		expect(await checked(page)).toEqual(["Deep"]);
		expect(await busy(page)).toBe("true");
		expect(await page.run(`!!document.querySelector('[data-slot=spinner]')`)).toBe(true);
		expect(await page.run(`${radio("Quick")}.disabled`)).toBe(false);
		await saved(1);
		expect(saves[0]?.tier).toBe("deep");

		// refused: back to what the store holds, with a notice
		saves[0]?.answer(500);
		await page.until(`${group}.getAttribute('aria-busy') === 'false'`);
		expect(await checked(page)).toEqual(["Balanced"]);
		expect(await page.run(`!!document.querySelector('[data-slot=spinner]')`)).toBe(false);
		await page.until(`document.body.textContent.includes("Couldn't change how hard it thinks")`);

		// Try again goes through the same pick: shown at once again
		await page.run(`[...document.querySelectorAll('button')].find((one) => one.textContent === 'Try again').click()`);
		expect(await checked(page)).toEqual(["Deep"]);
		await saved(2);
		saves[1]?.answer(200);
		await page.until(`${group}.getAttribute('aria-busy') === 'false'`);
		// answered, the stream has not said so yet: it holds rather than flashing the old tier
		expect(await checked(page)).toEqual(["Deep"]);

		// the stream's echo reaches the selector and not the screen that holds the shell: the next change of a row that
		// is not its tier renders the screen once, so the echo, the pick and the refusal before it rendered it never
		tell([row("deep")]);
		tell([row("deep", "Newer words")]);
		await page.until(`document.getElementById('excerpt').textContent === 'Newer words'`);
		expect(await screens(page)).toBe(before + 1);
		expect(await checked(page)).toEqual(["Deep"]);

		// the sidebar closed and reopened shows the saved tier, from the store
		await page.run(`window.setOpen(false)`);
		await page.until(`${group} === null`);
		await page.run(`window.setOpen(true)`);
		await page.until(`${group} !== null`);
		expect(await checked(page)).toEqual(["Deep"]);
		expect(page.errors().filter((error) => !error.includes("500"))).toEqual([]);
	});
});
