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
