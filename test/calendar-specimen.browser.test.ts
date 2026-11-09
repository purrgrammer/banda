import { mkdir } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { hasChrome, withPage } from "./smoke/chrome.ts";

let server: ViteDevServer;
let listener: Server;
let url: string;

beforeAll(async () => {
	if (!hasChrome()) return;
	listener = createHttpServer((req, res) => server.middlewares(req, res));
	server = await createServer({
		configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
		server: { middlewareMode: true, hmr: { server: listener }, open: false },
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
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("No specimen port");
	url = `http://127.0.0.1:${address.port}/#/specimen`;
});

afterAll(async () => {
	await server?.close();
	if (listener)
		await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
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
