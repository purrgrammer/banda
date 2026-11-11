import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

let server: WebServer;
let url: string;

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
		plugins: [
			{
				name: "gmail-specimen:no-daemon",
				configResolved(config) {
					delete config.server.proxy;
				},
				configureServer(server) {
					server.middlewares.use("/icon.svg", (_req, res) => {
						res.writeHead(204);
						res.end();
					});
				},
			},
		],
	});
	url = `${server.origin}/#/specimen?section=gmail&only=1`;
});

afterAll(async () => {
	await server?.close();
});

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`Gmail email cards and send preview fit ${width}px`,
		async () => {
			await withPage(url, { width, height: 900 }, async (page) => {
				const directory = process.env.BANDA_MAIL_SPECIMEN_SHOTS;
				await page.until(`document.getElementById('gmail')`);
				await page.run(`document.getElementById('gmail').scrollIntoView({block:'center'})`);
				expect(await page.run(`document.getElementById('gmail').innerText.includes('The launch checklist')`)).toBe(
					true,
				);
				expect(
					await page.run(`document.getElementById('gmail').innerText.includes('Three things before Friday')`),
				).toBe(true);
				expect(await page.run(`document.querySelector('#gmail [aria-label="Unread"]') !== null`)).toBe(true);
				expect(await page.run(`document.getElementById('gmail').innerText.includes('Google access')`)).toBe(true);
				expect(await page.run(`document.getElementById('gmail').innerText.includes('Email draft')`)).toBe(true);
				expect(await page.run(`document.getElementById('gmail').innerText.includes('planning-notes.pdf')`)).toBe(true);
				expect(await page.run(`document.querySelector('#gmail [aria-label="Email recipient"]') !== null`)).toBe(true);
				// the access to grant is the connect dialog's first step, opened from the card
				await page.run(
					`[...document.querySelectorAll('#gmail button')].find((b) => b.innerText.includes('Connect Gmail')).click()`,
				);
				const dialog = `document.querySelector('[role="dialog"][data-connect-step="permissions"]')`;
				await page.until(dialog);
				expect(await page.run(`${dialog}.innerText.includes('Gmail access')`)).toBe(true);
				expect(await page.run(`${dialog}.innerText.includes('Send email')`)).toBe(true);
				expect(await page.run(`${dialog}.getBoundingClientRect().right <= innerWidth`)).toBe(true);
				await page.run(`${dialog}.querySelector('[data-slot="dialog-close"]').click()`);
				await page.until(`${dialog} === null`);
				expect(await page.run(`document.getElementById('gmail').innerText.includes('Search messages')`)).toBe(false);
				expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
				if (directory !== undefined) {
					await mkdir(directory, { recursive: true });
					await page.shoot(`${directory}/${width}.png`);
				}
			});
		},
		60_000,
	);
