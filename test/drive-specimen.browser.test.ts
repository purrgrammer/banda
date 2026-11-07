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
