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
				name: "calendar-specimen:no-daemon",
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
	url = `${server.origin}/#/specimen?section=calendar&only=1`;
});

afterAll(async () => {
	await server?.close();
});

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`Calendar event cards fit ${width}px`,
		async () => {
			await withPage(url, { width, height: 900 }, async (page) => {
				const directory = process.env.BANDA_CALENDAR_SPECIMEN_SHOTS;
				const section = `document.getElementById('calendar')`;
				await page.until(section);
				await page.run(`${section}.scrollIntoView({block:'center'})`);
				const text = (words: string) => page.run(`${section}.innerText.includes(${JSON.stringify(words)})`);
				expect(await text("Quarterly planning with Northstar")).toBe(true);
				expect(await text("All day")).toBe(true);
				expect(await text("Cancelled")).toBe(true);
				expect(await text("Declined")).toBe(true);
				expect(await text("Open in Google Calendar")).toBe(true);
				expect(await text("Join on acme.zoom.us")).toBe(true);
				expect(await page.run(`${section}.querySelector('[data-event-response="declined"]') !== null`)).toBe(true);
				expect(await page.run(`${section}.querySelector('h3.line-through') !== null`)).toBe(true);
				expect(await page.run(`${section}.querySelector('[data-object-inline]') !== null`)).toBe(true);
				expect(await text("Bring last quarter's numbers.")).toBe(false);
				await page.run(
					`[...${section}.querySelectorAll('button')].find((b) => b.innerText.includes('Description')).click()`,
				);
				await page.until(`${section}.innerText.includes("Bring last quarter's numbers.")`);
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
