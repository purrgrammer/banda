import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

/**
 * Settled asks and one-line work, on a phone and a desktop: each card says how its ask ended (answered in the chat, no
 * answer in time, stopped) and no text leaves it, however long; a path keeps its file name and a chain its last step
 * when the line runs out of room. `BANDA_SETTLED_SHOTS=<dir>` keeps a screenshot of each section at each width.
 */
let server: WebServer;
let base = "";

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
		plugins: [
			{
				name: "settled-narrow:no-daemon",
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
	base = server.origin;
});

afterAll(async () => {
	await server?.close();
});

/**
 * Every piece of text in `section` that leaves its card or row: a line of it reaching past the frame it sits in, with
 * nothing between that clips it (a line cut with "…" is clipped, and stays inside).
 */
const spills = (section: string) => `(() => {
	const out = [];
	const walk = document.createTreeWalker(${section}, NodeFilter.SHOW_TEXT);
	for (let text = walk.nextNode(); text !== null; text = walk.nextNode()) {
		if (text.textContent.trim() === '') continue;
		const frame = text.parentElement.closest('[data-done], [data-tile]');
		if (frame === null) continue;
		let clipped = false;
		for (let el = text.parentElement; el !== frame && el !== null; el = el.parentElement)
			if (getComputedStyle(el).overflowX !== 'visible') clipped = true;
		if (clipped) continue;
		const box = frame.getBoundingClientRect();
		const range = document.createRange();
		range.selectNodeContents(text);
		if ([...range.getClientRects()].some((line) => line.right > box.right + 1 || line.left < box.left - 1))
			out.push(text.textContent.slice(0, 80));
	}
	return out;
})()`;

/** Every kept end in `section` that is cut or hidden: one that does not show whole. */
const cutEnds = (section: string) => `[...${section}.querySelectorAll('[data-keep-end]')].filter((line) => {
	const end = line.lastElementChild;
	return end === null || end.clientWidth === 0 || end.scrollWidth > end.clientWidth + 1;
}).map((line) => line.title)`;

const SECTIONS: Record<string, readonly string[]> = {
	cards: ["You answered in the chat", "No answer in time", "Stopped before an answer", "text-overflow"],
	approvals: ["No answer in time; it did not run", "Stopped before your answer was used"],
	done: ["Answered in the chat", "No answer in time", "Stopped before it ran: comment on purrgrammer/banda #34"],
	"harness-headlines": ["QuietHoursEditor.tsx", "&& git push origin main"],
};

for (const width of [390, 1440])
	for (const [id, words] of Object.entries(SECTIONS))
		it.skipIf(!hasChrome())(
			`the ${id} section's settled lines say what happened and fit ${width}px`,
			async () => {
				await withPage(
					`${base}/#/specimen?section=${id}&only=1`,
					{ width, height: process.env.BANDA_SETTLED_SHOTS === undefined ? 1000 : 3200 },
					async (page) => {
						const section = `document.getElementById(${JSON.stringify(id)})`;
						await page.until(`${section}?.innerText.includes(${JSON.stringify(words[0])})`);
						await page.run(`${section}.scrollIntoView({block:'start'})`);
						const directory = process.env.BANDA_SETTLED_SHOTS;
						if (directory !== undefined) {
							await mkdir(directory, { recursive: true });
							await page.shoot(`${directory}/${id}-${width}.png`);
						}
						for (const said of words)
							expect(await page.run(`${section}.innerText.includes(${JSON.stringify(said)})`), said).toBe(true);
						expect(await page.run<string[]>(spills(section))).toEqual([]);
						expect(await page.run<string[]>(cutEnds(section))).toEqual([]);
						expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
						expect(page.errors()).toEqual([]);
					},
				);
			},
			60_000,
		);
