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
				name: "contacts-specimen:no-daemon",
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
	url = `${server.origin}/#/specimen?section=contacts&only=1`;
});

afterAll(async () => {
	await server?.close();
});

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`Contact cards fit ${width}px`,
		async () => {
			await withPage(url, { width, height: 900 }, async (page) => {
				const directory = process.env.BANDA_CONTACTS_SPECIMEN_SHOTS;
				const section = `document.getElementById('contacts')`;
				await page.until(section);
				await page.run(`${section}.scrollIntoView({block:'center'})`);
				const text = (words: string) => page.run(`${section}.innerText.includes(${JSON.stringify(words)})`);
				expect(await text("Ana García")).toBe(true);
				expect(await text("Head of Design · Northstar")).toBe(true);
				expect(await text("From people you've emailed")).toBe(true);
				expect(await text("Open in Google Contacts")).toBe(true);
				expect(await text("Add “Bo Lindqvist” to your contacts")).toBe(true);
				expect(await text("Delete this contact from your contacts")).toBe(true);
				expect(await page.run(`${section}.querySelector('[aria-label="Contact draft"]') !== null`)).toBe(true);
				expect(
					await page.run(
						`${section}.querySelector('[aria-label="Contact draft"] textarea, [aria-label="Contact draft"] input') === null`,
					),
				).toBe(true);
				expect(await page.run(`${section}.querySelector('a[href="mailto:ana@northstar.example"]') !== null`)).toBe(
					true,
				);
				expect(await page.run(`${section}.querySelector('a[href="tel:+34600123456"]') !== null`)).toBe(true);
				expect(await page.run(`${section}.querySelector('[data-contact-other]') !== null`)).toBe(true);
				expect(
					await page.run(
						`${section}.querySelector('[data-object-inline] a[href^="https://contacts.google.com/"]') !== null`,
					),
				).toBe(true);
				expect(await page.run(`${section}.innerText.includes("AG")`)).toBe(true);
				expect(
					await page.run(
						`[...${section}.querySelectorAll('[data-scheme]')].every((frame) => frame.scrollWidth <= frame.clientWidth)`,
					),
				).toBe(true);
				expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
				if (directory !== undefined) {
					await mkdir(directory, { recursive: true });
					await page.shoot(`${directory}/${width}.png`);
				}
			});
		},
		60_000,
	);
