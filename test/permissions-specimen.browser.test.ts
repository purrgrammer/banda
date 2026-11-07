import { mkdir } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { viteCacheDir } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

let server: ViteDevServer;
let listener: Server;
let url: string;
beforeAll(async () => {
	if (!hasChrome()) return;
	listener = createHttpServer((req, res) => server.middlewares(req, res));
	server = await createServer({
		configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
		cacheDir: await viteCacheDir(),
		server: { middlewareMode: true, hmr: { server: listener }, open: false },
		plugins: [
			{
				name: "permissions-specimen:no-daemon",
				configResolved(config) {
					delete config.server.proxy;
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

const section = `document.getElementById('permissions')`;

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`permissions by connection, and allowing without asking, say the daemon's sentence and fit ${width}px`,
		async () => {
			await withPage(url, { width, height: 900 }, async (page) => {
				await page.until(section, 30_000);
				await page.run(`${section}.scrollIntoView({ block: 'start' })`);
				const text = await page.run<string>(`${section}.textContent`);
				expect(text).toContain("Merge pull requests in purrgrammer/banda as @bandarra");
				expect(text).toContain("Always · Used 4 times · last Tue 14:02");
				expect(text).toContain("Not used lately");
				expect(text).toContain("Allow without asking");
				expect(text).toContain(
					"Mara may merge pull requests in purrgrammer/banda as @bandarra without asking, always.",
				);
				expect(text).toContain("Mara could merge pull requests anywhere @bandarra can, without asking.");
				expect(text).toContain("Write it as owner/repo.");
				// light and dark, side by side or one above the other
				expect(await page.run(`${section}.querySelectorAll('form').length`)).toBe(8);
				expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
				expect(
					await page.run(
						`[...${section}.querySelectorAll('form')].every((form) => form.scrollWidth <= form.clientWidth + 1)`,
					),
				).toBe(true);
				const directory = process.env.BANDA_PERMISSIONS_SPECIMEN_SHOTS;
				if (directory) {
					await mkdir(directory, { recursive: true });
					await page.shoot(`${directory}/${width}.png`);
					for (const n of [0, 2]) {
						await page.run(`${section}.querySelectorAll('form')[${n}].scrollIntoView({ block: 'start' })`);
						await page.shoot(`${directory}/${width}-form-${n}.png`);
					}
				}
				expect(page.errors()).toEqual([]);
			});
		},
		60_000,
	);
