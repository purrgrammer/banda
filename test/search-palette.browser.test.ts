import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freePort, viteCacheDir } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

/**
 * Search (Cmd/Ctrl+K) and the "+" sheet in a real browser: the arrows move the active row and Enter opens it, the
 * local sections (agents, skills, pages) match at once, a chat hit opens its chat at the message, the previous hits
 * stay while a new search runs, the phone shows a Cancel, Esc returns focus to what opened it, axe finds nothing
 * serious in the open dialog, and a half-written agent survives Esc but not Cancel.
 */
const fixturePath = fileURLToPath(new URL("../web/search-palette-fixture.tsx", import.meta.url));

const HIT = {
	kind: "chat",
	chat: 1,
	agent: "mara",
	entry: 7,
	by: "agent",
	text: "Three flights to Lisbon under €300, all mornings",
	at: 1730000000000,
};

let server: ViteDevServer;
let base = "";

function json(res: ServerResponse, body: unknown) {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await createServer({
		configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
		cacheDir: await viteCacheDir(),
		server: { port: await freePort(), strictPort: true, host: "127.0.0.1", open: false },
		plugins: [
			{
				name: "search-palette-fixture",
				resolveId(id) {
					if (id === "/search-palette-fixture.tsx") return fixturePath;
				},
				load(id) {
					if (id !== fixturePath) return;
					return `import React, { StrictMode, useState } from 'react';
					import { createRoot } from 'react-dom/client';
					import axe from 'axe-core';
					import { SearchDialog } from '/src/app/SearchDialog.tsx';
					import { NewSheet } from '/src/app/NewSheet.tsx';
					import { whoOf } from '/src/app/band.ts';
					import '/src/styles/globals.css';
					window.axe = axe;
					const AGENTS = [
					 { id: 'mara', name: 'Mara', face: whoOf([], 'mara').face },
					 { id: 'sancho', name: 'Sancho', face: whoOf([], 'sancho').face },
					];
					const ROWS = [
					 { id: 'a:mara', name: 'Mara', faces: [AGENTS[0]], excerpt: 'Found three under €300.', time: '10:42', at: 2, to: { name: 'agent', id: 'mara' } },
					 { id: 'a:sancho', name: 'Sancho', faces: [AGENTS[1]], excerpt: 'Thanks, that is all.', by: 'You', time: 'Yesterday', at: 1, to: { name: 'agent', id: 'sancho' } },
					];
					const SKILLS = [
					 { name: 'pdf', description: 'Read any PDF aloud' },
					 { name: 'xlsx', description: 'Spreadsheets, summed up' },
					];
					function Fixture() {
					 const [searching, setSearching] = useState(false);
					 const [making, setMaking] = useState(false);
					 const [went, setWent] = useState('');
					 const go = (where) => setWent(JSON.stringify(where));
					 return <main style={{padding:16}}>
					  <button onClick={() => setSearching(true)}>Open search</button>
					  <button onClick={() => setMaking(true)}>Open new</button>
					  <output data-went=''>{went}</output>
					  <SearchDialog open={searching} onOpenChange={setSearching} phone={innerWidth < 768}
					   rows={ROWS} agents={AGENTS} skills={SKILLS}
					   whoOf={(id) => whoOf(AGENTS, id)} groupName={() => 'Trip'} onGo={go} />
					  <NewSheet open={making} onOpenChange={setMaking} agents={AGENTS} onGo={go} />
					 </main>;
					}
					createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);`;
				},
				configureServer(vite) {
					vite.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
						const path = (req.url ?? "").split("?")[0] ?? "";
						if (path === "/search-palette-fixture") {
							void vite
								.transformIndexHtml(
									req.url ?? "",
									'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/search-palette-fixture.tsx"></script></body></html>',
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
							return;
						}
						if (path === "/api/search") {
							const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("q") ?? "";
							// a slow daemon, so the kept-hits state is visible
							setTimeout(() => json(res, /lisbon/i.test(q) ? [HIT] : []), 250);
							return;
						}
						json(res, {});
					});
				},
			},
		],
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (address === null || typeof address !== "object" || address === undefined)
		throw new Error("fixture did not listen");
	base = `http://127.0.0.1:${address.port}/search-palette-fixture#token=palette-test`;
});
afterAll(async () => {
	await server?.close();
});

const button = (text: string) =>
	`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const INPUT = `document.querySelector('[cmdk-input]')`;
const SELECTED = `document.querySelector('[cmdk-item][aria-selected="true"]')`;

/**
 * Open the search dialog from its button, focusing it first so Esc has somewhere to return; any closing dialog goes
 * first, so its focus return never steals from the one being opened.
 */
async function openSearch(page: Page) {
	await page.until(`!${INPUT} && !!(${button("Open search")})`);
	await page.run(`(() => { const b = ${button("Open search")}; b.focus(); b.click(); })()`);
	await page.until(`${INPUT} && document.activeElement === ${INPUT}`);
}

/** Type into the focused field as a person would: through the browser's input pipeline. */
const type = (page: Page, text: string) => page.input("Input.insertText", { text });

async function press(page: Page, key: string, code: string, keyCode: number) {
	const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
	await page.input("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
	await page.input("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

const enter = (page: Page) => press(page, "Enter", "Enter", 13);
const esc = (page: Page) => press(page, "Escape", "Escape", 27);

it.skipIf(!hasChrome())("search offers the band with nothing typed, and the keyboard drives it", async () => {
	await withPage(base, { width: 1280, height: 900 }, async (page) => {
		await openSearch(page);
		// the band's rows, in the band's order; the first is active
		await page.until(`document.querySelectorAll('[cmdk-item]').length === 2`);
		expect(await page.run<string>(`${SELECTED}.textContent`)).toContain("Mara");
		expect(await page.run(`!!${button("Cancel")}`)).toBe(false);
		// ArrowDown moves, Enter opens the active row
		await press(page, "ArrowDown", "ArrowDown", 40);
		await page.until(`${SELECTED}.textContent.includes('Sancho')`);
		await enter(page);
		await page.until(`document.querySelector('[data-went]').textContent !== ''`);
		expect(await page.run<string>(`document.querySelector('[data-went]').textContent`)).toBe(
			JSON.stringify({ name: "agent", id: "sancho" }),
		);
		// closed, the focus is back on what opened it
		await page.until(`document.activeElement === ${button("Open search")}`);
		expect(page.errors()).toEqual([]);
	});
});

it.skipIf(!hasChrome())("a query finds an agent, a skill and a page, and Esc returns focus", async () => {
	await withPage(base, { width: 1280, height: 900 }, async (page) => {
		await openSearch(page);
		await type(page, "san");
		await page.until(`${SELECTED} && ${SELECTED}.textContent.includes('Sancho')`);
		await enter(page);
		await page.until(
			`document.querySelector('[data-went]').textContent === '${JSON.stringify({ name: "agent", id: "sancho" })}'`,
		);
		await openSearch(page);
		await type(page, "pdf");
		await page.until(`${SELECTED} && ${SELECTED}.textContent.includes('Read any PDF aloud')`);
		await enter(page);
		await page.until(
			`document.querySelector('[data-went]').textContent === '${JSON.stringify({ name: "skill", id: "pdf" })}'`,
		);
		await openSearch(page);
		await type(page, "sett");
		await page.until(`${SELECTED} && ${SELECTED}.textContent.includes('Settings')`);
		await enter(page);
		await page.until(`document.querySelector('[data-went]').textContent === '${JSON.stringify({ name: "settings" })}'`);
		// Esc closes with nothing picked, and the opener holds focus again
		await openSearch(page);
		await esc(page);
		await page.until(`!document.querySelector('[cmdk-input]')`);
		await page.until(`document.activeElement === ${button("Open search")}`);
		expect(page.errors()).toEqual([]);
	});
});

it.skipIf(!hasChrome())("a chat hit opens its chat at the message, and hits stay while a new search runs", async () => {
	await withPage(base, { width: 1280, height: 900 }, async (page) => {
		await openSearch(page);
		await type(page, "lisbon");
		await page.until(`document.body.textContent.includes('Searching…')`);
		await page.until(`${SELECTED} && ${SELECTED}.textContent.includes('Lisbon')`);
		// more typed: the previous hits stay, dimmed, and no "Searching…" line replaces them
		await type(page, " under");
		expect(await page.run(`${SELECTED}.textContent.includes('Lisbon')`)).toBe(true);
		expect(await page.run(`document.body.textContent.includes('Searching…')`)).toBe(false);
		await page.until(`!document.querySelector('[cmdk-list] .opacity-60')`);
		await enter(page);
		await page.until(`document.querySelector('[data-went]').textContent !== ''`);
		expect(await page.run<string>(`document.querySelector('[data-went]').textContent`)).toBe(
			JSON.stringify({ name: "agent", id: "mara", at: 7 }),
		);
		// nothing found says so, with the query
		await openSearch(page);
		await type(page, "zzz");
		await page.until(`document.body.textContent.includes('Nothing matches “zzz”.')`);
		expect(page.errors()).toEqual([]);
	});
});

it.skipIf(!hasChrome())("the open dialog passes axe, and announces a listbox", async () => {
	await withPage(base, { width: 1280, height: 900 }, async (page) => {
		await openSearch(page);
		await page.until(`document.querySelectorAll('[cmdk-item]').length === 2`);
		expect(await page.run(`!!document.querySelector('[role="dialog"] [role="listbox"]')`)).toBe(true);
		// a move announces the active row: the input points at it (cmdk leaves the first auto-selection unannounced)
		await press(page, "ArrowDown", "ArrowDown", 40);
		await page.until(`${INPUT}.getAttribute('aria-activedescendant') === ${SELECTED}.id`);
		// axe misreads the palette's oklch() tokens (it saw #747474 for oklch(0.2 0 0)); `npm run web:contrast` audits
		// the palette's contrast, so that one rule stays off here
		const violations = await page.run<string[]>(
			`window.axe.run(document.querySelector('[role="dialog"]'), { rules: { 'color-contrast': { enabled: false } } })
				.then(r => r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => JSON.stringify([v.id, v.nodes.map(n => n.html)])))`,
		);
		expect(violations).toEqual([]);
	});
});

it.skipIf(!hasChrome())("the phone shows Cancel, and it closes the search", async () => {
	await withPage(base, { width: 390, height: 700 }, async (page) => {
		await openSearch(page);
		await page.until(`!!${button("Cancel")}`);
		expect(await page.run(`document.body.textContent.includes('esc')`)).toBe(false);
		await page.run(`${button("Cancel")}.click()`);
		await page.until(`!document.querySelector('[cmdk-input]')`);
		expect(page.errors()).toEqual([]);
	});
});

it.skipIf(!hasChrome())("the + sheet keeps a draft through Esc, arrows switch the tabs, Cancel resets", async () => {
	await withPage(base, { width: 1280, height: 900 }, async (page) => {
		await page.until(button("Open new"));
		const name = `document.querySelector('input[placeholder="Name your agent"]')`;
		const words = `document.querySelector('textarea[aria-label="Personality"]')`;
		const set = (selector: string, kind: string, value: string) =>
			page.run(`(() => {
				const el = ${selector};
				Object.getOwnPropertyDescriptor(window.HTML${kind}Element.prototype, 'value').set.call(el, ${JSON.stringify(value)});
				el.dispatchEvent(new Event('input', { bubbles: true }));
			})()`);
		await page.run(`${button("Open new")}.click()`);
		await page.until(name);
		await set(name, "Input", "Teresa");
		await set(words, "TextArea", "Warm and brief.");
		await esc(page);
		await page.until(`!${name}`);
		// Esc kept the draft
		await page.run(`${button("Open new")}.click()`);
		await page.until(`${name} && ${name}.value === 'Teresa'`);
		expect(await page.run<string>(`${words}.value`)).toBe("Warm and brief.");
		// the arrow keys move between Agent and Group
		await page.run(`document.querySelector('[role="tab"][aria-selected="true"]').focus()`);
		await press(page, "ArrowRight", "ArrowRight", 39);
		await page.until(`document.querySelector('[role="tab"][aria-selected="true"]').textContent === 'Group'`);
		await page.until(`document.body.textContent.includes("Who's in it")`);
		await press(page, "ArrowLeft", "ArrowLeft", 37);
		await page.until(`document.querySelector('[role="tab"][aria-selected="true"]').textContent === 'Agent'`);
		// Cancel lets the draft go
		await page.run(`${button("Cancel")}.click()`);
		await page.until(`!${name}`);
		await page.run(`${button("Open new")}.click()`);
		await page.until(`${name} && ${name}.value === ''`);
		expect(await page.run<string>(`${words}.value`)).toBe("");
		expect(page.errors()).toEqual([]);
	});
});
