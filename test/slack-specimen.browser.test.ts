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
				name: "slack-specimen:no-daemon",
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
		`Slack's cards and drafts fit ${width}px`,
		async () => {
			await withPage(url, { width, height: 900 }, async (page) => {
				const section = `document.getElementById('slack')`;
				await page.until(section);
				await page.run(`${section}.scrollIntoView({block:'center'})`);
				const text = (words: string) => page.run(`${section}.innerText.includes(${JSON.stringify(words)})`);
				for (const words of [
					"Thread in #general",
					"Release notes draft for Thursday",
					"About 23 matches",
					"6 messages",
					"@deploybot [bot]",
					"@olga (outside)",
					"Every deploy, green or red. Ping #oncall when red.",
					"14 members",
					"No messages match yet",
					"@bob · Engineer",
					"On call · America/New_York",
					"From another team",
					"Open in Slack",
					"Reply in thread in #general",
					"Post in #deploys",
					"Notifies @here (everyone active in the channel), @bob",
					"@here notes are final. @bob I'll look at #deploys after lunch.",
					"Direct messages and search",
					"Send messages as you",
				])
					expect(await text(words), words).toBe(true);
				// a post is on the floor: no permission is offered on its card
				expect(await text("Don't ask again")).toBe(false);
				expect(await page.run(`${section}.querySelector('[aria-label="Slack message"]') !== null`)).toBe(true);
				// a link to a reply reads as the reply, in its author's and its words; a link to the thread's first message as
				// the thread, led by who started it
				expect(await page.run<string>(`${section}.querySelector('[data-slack-reply]')?.innerText ?? ""`)).toContain(
					"@bob: @ana can you check #deploys before we ship?",
				);
				expect(
					await page.run<string>(
						`${section}.querySelector('[data-object-inline]:not([data-slack-reply]) a[href*="/archives/"]')?.innerText ?? ""`,
					),
				).toContain("@bob: Release notes draft for Thursday");
				// faces on Slack's image host that are not there fall back to the author's initial, and a person's to the icon
				await page.until(
					`[...${section}.querySelectorAll('[data-slack-card="thread"] [data-slot="avatar-fallback"]')].some((el) => el.innerText === "O")`,
				);
				expect(
					await page.run(
						`[...${section}.querySelectorAll('[data-slot="avatar-image"]')].every((img) => img.alt === "" && img.referrerPolicy === "no-referrer")`,
					),
				).toBe(true);
				await page.until(`${section}.querySelector('[data-slack-face] [data-slot="avatar-fallback"] svg') !== null`);
				expect(
					await page.run(
						`${section}.querySelector('[data-object-inline] a[href^="https://acme.slack.com/"]') !== null`,
					),
				).toBe(true);
				expect(
					await page.run(
						`[...${section}.querySelectorAll('[data-scheme]')].every((frame) => frame.scrollWidth <= frame.clientWidth)`,
					),
				).toBe(true);
				expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
				const directory = process.env.BANDA_SLACK_SPECIMEN_SHOTS;
				if (directory !== undefined) {
					await mkdir(directory, { recursive: true });
					await page.shoot(`${directory}/${width}.png`);
				}
			});
		},
		60_000,
	);
