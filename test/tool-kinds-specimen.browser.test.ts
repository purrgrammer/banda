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
				name: "tool-kinds-specimen:no-daemon",
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

const section = `document.getElementById('tool-kinds')`;

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`what a connection's tools may do shows every state and fits ${width}px`,
		async () => {
			await withPage(url, { width, height: 900 }, async (page) => {
				await page.until(section, 30_000);
				await page.run(`${section}.scrollIntoView({ block: 'start' })`);
				const text = await page.run<string>(`${section}.textContent`);
				// collapsed, a group is its count and one control; expanded, each tool says who said what it does
				expect(text).toContain("Issues6");
				expect(text).toContain("Mixed");
				expect(text).toContain("Linear says · reads");
				expect(text).toContain("banda's guess · changes something");
				expect(text).toContain("banda's guess · changes an account");
				expect(text).toContain("You said · moves money");
				expect(text).toContain("Nobody said, so it asks · changes something");
				expect(text).toContain("Sorting Linear's tools");
				expect(text).toContain("banda couldn't sort some of them, so they ask first.");
				expect(text).toContain("New");
				expect(text).toContain("6 read and run freely · 4 change something and ask first · 3 always ask");
				// light and dark
				expect(await page.run(`${section}.querySelectorAll('[data-state="expanded"]').length`)).toBe(2);
				expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
				expect(
					await page.run(
						`[...${section}.querySelectorAll('[data-tool-list]')].every((list) => list.scrollWidth <= list.clientWidth + 1)`,
					),
				).toBe(true);
				// a group's control sets each of its tools: Always ask on a read is Ask
				const expanded = `${section}.querySelector('[data-state="expanded"]')`;
				await page.run(
					`[...${expanded}.querySelector('[data-group="Issues"]').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Always ask').click()`,
				);
				await page.until(
					`${expanded}.querySelector('[data-tool="list_issues"] [data-state="on"]')?.textContent.trim() === 'Ask'`,
				);
				expect(
					await page.run(
						`${expanded}.querySelector('[data-tool="delete_issue"] [data-state="on"]')?.textContent.trim()`,
					),
				).toBe("Always ask");
				// the review itself: a dialog on the desktop, a sheet on the phone, inside the screen
				await page.run(`${section}.querySelector('[data-open-review]').click()`);
				await page.until(`document.querySelector('[role="dialog"] [data-tool-review]')?.closest('[role="dialog"]')`);
				const dialog = `document.querySelector('[role="dialog"] [data-tool-review]').closest('[role="dialog"]')`;
				expect(await page.run<string>(`${dialog}.textContent`)).toContain("Linear's tools");
				expect(await page.run(`${dialog}.getBoundingClientRect().right <= innerWidth + 1`)).toBe(true);
				expect(await page.run(`${dialog}.scrollWidth <= ${dialog}.clientWidth + 1`)).toBe(true);
				const directory = process.env.BANDA_TOOL_KINDS_SPECIMEN_SHOTS;
				if (directory) {
					await mkdir(directory, { recursive: true });
					await page.shoot(`${directory}/${width}-review.png`);
				}
				expect(page.errors()).toEqual([]);
			});
		},
		60_000,
	);
