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
				name: "drive-specimen:no-daemon",
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
	url = `${server.origin}/#/specimen?section=drive&only=1`;
});

afterAll(async () => {
	await server?.close();
});

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`Drive file cards fit ${width}px`,
		async () => {
			await withPage(url, { width, height: 900 }, async (page) => {
				const directory = process.env.BANDA_DRIVE_SPECIMEN_SHOTS;
				const section = `document.getElementById('drive')`;
				await page.until(section);
				await page.run(`${section}.scrollIntoView({block:'center'})`);
				const text = (words: string) => page.run(`${section}.innerText.includes(${JSON.stringify(words)})`);
				expect(await text("Q1 rollout plan")).toBe(true);
				expect(await text("Open in Google Docs")).toBe(true);
				expect(await text("Open in Google Sheets")).toBe(true);
				expect(await text("Open in Google Drive")).toBe(true);
				expect(await text("2.3 MB")).toBe(true);
				expect(await text("application/zip")).toBe(true);
				// the drafts of changes: read-only previews of exactly what was drafted
				expect(await text("Create the Doc “Q1 plan”")).toBe(true);
				expect(await text("Move this file to the trash")).toBe(true);
				expect(await page.run(`${section}.querySelectorAll('[aria-label="File draft"]').length >= 5`)).toBe(true);
				expect(
					await page.run(
						`${section}.querySelectorAll('[aria-label="File draft"] textarea, [aria-label="File draft"] input').length === 0`,
					),
				).toBe(true);
				for (const kind of ["doc", "sheet", "slides", "pdf", "folder", "file"])
					expect(await page.run(`${section}.querySelector('[data-file-kind="${kind}"]') !== null`)).toBe(true);
				expect(
					await page.run(
						`${section}.querySelector('[data-object-inline] a[href^="https://docs.google.com/"]') !== null`,
					),
				).toBe(true);
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
