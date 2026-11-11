import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

/**
 * Dialogs opened from state, with no Radix trigger, give focus back to their opener on close (the same fault the
 * search and the "+" sheet had): the shortcuts dialog, the harness dialog and an agent's "Add a connection", each
 * opened from a real button, closed with Esc, and the active element is that button again, never BODY.
 */
const fixturePath = fileURLToPath(new URL("../web/return-focus-fixture.tsx", import.meta.url));

let server: WebServer;
let base = "";

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
		plugins: [
			{
				name: "return-focus-fixture",
				resolveId(id) {
					if (id === "/return-focus-fixture.tsx") return fixturePath;
				},
				load(id) {
					if (id !== fixturePath) return;
					return `import React, { StrictMode, useState } from 'react';
					import { createRoot } from 'react-dom/client';
					import { ShortcutsDialog } from '/src/app/Shortcuts.tsx';
					import { HarnessDialog } from '/src/app/HarnessDialog.tsx';
					import { AccessTab } from '/src/app/Access.tsx';
					import '/src/styles/globals.css';
					function Fixture() {
					 const [shortcuts, setShortcuts] = useState(false);
					 const [harness, setHarness] = useState(false);
					 return <main style={{padding:16}}>
					  <button onClick={() => setShortcuts(true)}>Open shortcuts</button>
					  <button onClick={() => setHarness(true)}>Open harness</button>
					  <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
					  <HarnessDialog open={harness} onOpenChange={setHarness} />
					  <AccessTab agent={{ id: 'mara', name: 'Mara' }} capabilities={undefined} control={undefined} />
					 </main>;
					}
					createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);`;
				},
				configureServer(vite) {
					vite.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
						const path = (req.url ?? "").split("?")[0] ?? "";
						if (path === "/return-focus-fixture") {
							void vite
								.transformIndexHtml(
									req.url ?? "",
									'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/return-focus-fixture.tsx"></script></body></html>',
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
						res.setHeader("content-type", "application/json");
						res.end("{}");
					});
				},
			},
		],
	});
	base = `${server.origin}/return-focus-fixture#token=return-focus-test`;
});
afterAll(async () => {
	await server?.close();
});

const button = (text: string) =>
	`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;

async function esc(page: Page) {
	const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
	await page.input("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
	await page.input("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

/** Open the dialog from its button (focused first, as a keyboard user leaves it), Esc, and focus is back on it. */
async function opensAndReturns(page: Page, opener: string, inside: string) {
	await page.until(`!!(${button(opener)})`);
	await page.run(`(() => { const b = ${button(opener)}; b.focus(); b.click(); })()`);
	await page.until(
		`!!document.querySelector('[role="dialog"]') && document.body.textContent.includes(${JSON.stringify(inside)})`,
	);
	await esc(page);
	await page.until(`!document.querySelector('[role="dialog"]')`);
	await page.until(`document.activeElement === ${button(opener)}`);
	expect(await page.run(`document.activeElement !== document.body`)).toBe(true);
}

it.skipIf(!hasChrome())("the shortcuts dialog returns focus to its opener", async () => {
	await withPage(base, { width: 1280, height: 900 }, async (page) => {
		await opensAndReturns(page, "Open shortcuts", "Keyboard shortcuts");
		expect(page.errors()).toEqual([]);
	});
});

it.skipIf(!hasChrome())("the harness dialog returns focus to its opener", async () => {
	await withPage(base, { width: 1280, height: 900 }, async (page) => {
		await opensAndReturns(page, "Open harness", "Add a harness");
		expect(page.errors()).toEqual([]);
	});
});

it.skipIf(!hasChrome())("an agent's Add a connection returns focus to the Add button", async () => {
	await withPage(base, { width: 1280, height: 900 }, async (page) => {
		await opensAndReturns(page, "Add", "Add a connection");
		expect(page.errors()).toEqual([]);
	});
});
