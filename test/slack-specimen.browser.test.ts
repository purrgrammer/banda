import { mkdir, writeFile } from "node:fs/promises";
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
					"14 members",
					"No messages match yet",
					"@bob · Engineer",
					"On call · America/New_York",
					"From another team",
					"Reply in thread in #general",
					"Post in #deploys",
					"Notifies @here (everyone active in the channel), @bob",
					"@here notes are final. @bob I'll look at #deploys after lunch.",
					"Direct messages and search",
					"Send messages as you",
					"React as you",
					"Read files you can see",
					"React :white_check_mark: to a message in #general",
					"deploy-41-migrations.log",
					"2.3 MB",
					"Slack is busy, back at 09:41",
					"Direct message",
					"1 earlier in Slack",
					":white_check_mark:",
					"Notifies only the message's author",
				])
					expect(await text(words), words).toBe(true);
				// a post is on the floor: no permission is offered on its card; a reaction's offers its channel for the task
				expect(await text("in #deploys as @ana at Acme without asking")).toBe(false);
				expect(await text("Reply in thread in #general as @ana at Acme without asking")).toBe(false);
				expect(await text("React to messages in #general as @ana at Acme without asking until this task is done")).toBe(
					true,
				);
				// a search with no matches says so once, never "About 0 matches"; a reaction's draft shows no raw arguments
				expect(await text("About 0 matches")).toBe(false);
				expect(await text("1700000300.000400")).toBe(false);
				// a thread opens with its first message, and reads down the card as a conversation does, the latest last
				expect(
					await page.run<string[]>(
						`[...${section}.querySelector('[data-slack-card="thread"]').querySelectorAll('[data-slack-bubble]')].map((bubble) => bubble.innerText.split("\\n").find((line) => line.startsWith("@")) ?? "")`,
					),
				).toEqual(["@bob", "@ana", "@bob", "@olga (outside)", "@deploybot [bot]"]);
				// a card's actions sit on its title's line, and a thread's replies hang under its first message
				for (const card of ["thread", "channel"]) {
					const off = await page.run<number>(
						`(() => { const card = ${section}.querySelector('[data-slack-card="${card}"]'); const middle = (el) => { const box = el.getBoundingClientRect(); return box.top + box.height / 2; }; return Math.abs(middle(card.querySelector('h3')) - middle(card.querySelector('[aria-label^="Actions for"] svg'))); })()`,
					);
					expect(off, card).toBeLessThanOrEqual(1.5);
				}
				expect(
					await page.run<number>(
						`${section}.querySelector('[data-slack-replies]').querySelectorAll('[data-slack-bubble]').length`,
					),
				).toBe(4);
				// a file in a message is named with its size
				expect(await page.run(`${section}.querySelector('[data-slack-file="F0LOG"]') !== null`)).toBe(true);
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
					// each scheme's frame whole, in pieces a screen tall, at twice the pixels whatever the device: each piece is
					// scrolled to the top of the viewport (the specimen scrolls inside its own pane) and shot there
					const scale = 2 / (width < 768 ? 3 : 1);
					const count = await page.run<number>(`${section}.querySelectorAll('[data-scheme]').length`);
					for (let index = 0; index < count; index++) {
						const frame = `${section}.querySelectorAll('[data-scheme]')[${index}]`;
						const scheme = await page.run<string>(`${frame}.dataset.scheme`);
						const tall = await page.run<number>(`${frame}.getBoundingClientRect().height`);
						for (let top = 0, piece = 1; top < tall; top += 800, piece++) {
							await page.run(
								`(() => { const frame = ${frame}; let pane = frame.parentElement; while (pane && !(pane.scrollHeight > pane.clientHeight && /auto|scroll/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement; pane = pane ?? document.scrollingElement; const offset = frame.getBoundingClientRect().top - pane.getBoundingClientRect().top; pane.scrollTo({ top: pane.scrollTop + offset + ${top} - 16, behavior: "instant" }); })()`,
							);
							await new Promise((resolve) => setTimeout(resolve, 150));
							const box = await page.run<{ x: number; y: number; width: number }>(
								`(() => { const box = ${frame}.getBoundingClientRect(); return { x: box.x, y: box.y + ${top}, width: box.width }; })()`,
							);
							const { data } = (await page.input("Page.captureScreenshot", {
								format: "png",
								clip: { x: box.x, y: box.y, width: box.width, height: Math.min(800, tall - top), scale },
							})) as { data: string };
							await writeFile(`${directory}/${width}-${scheme}-${piece}.png`, Buffer.from(data, "base64"));
						}
					}
				}
			});
		},
		60_000,
	);
