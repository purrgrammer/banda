/**
 * What an agent made or changed in the band, as the chat draws it (#58): in the specimen, at phone and desktop width, a
 * new agent, a new group and an update are rows that link to what they made, each opening into a card that informs and
 * asks nothing. `BANDA_BAND_SHOTS=<dir>` keeps screenshots.
 */
import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

let server: WebServer;

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
		plugins: [
			{
				name: "band-change-specimen:no-daemon",
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
});

afterAll(async () => {
	await server?.close();
});

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`a new agent, a group and an update are rows linking to them, opening into cards with nothing to answer, at ${width}px`,
		async () => {
			await withPage(
				`${server.origin}/#/specimen?section=agent-meta-tools&only=1`,
				{ width, height: 1100 },
				async (page) => {
					const shots = process.env.BANDA_BAND_SHOTS;
					const section = `document.getElementById('agent-meta-tools')`;
					await page.until(`${section} && [...${section}.querySelectorAll('[data-done]')].length >= 3`);
					const rows = await page.run<string[]>(
						`[...${section}.querySelectorAll('[data-done]')].map(row => row.getAttribute('data-done') + ' | ' + row.innerText.replace(/\\s+/g, ' ').trim())`,
					);
					// the specimen draws the chat at each width it shows: the rows repeat, three a copy
					expect(rows.length % 3).toBe(0);
					expect(rows.slice(0, 3).map((row) => row.split(" | ")[0])).toEqual(["agent", "group", "change"]);
					expect(rows[0]).toMatch(/Created\s+Researcher/);
					expect(rows[1]).toMatch(/Created the group\s+Lisbon research/);
					expect(rows[2]).toMatch(/Updated\s+Atlas/);
					// each row links to what it made
					const links = await page.run<string[]>(
						`[...${section}.querySelectorAll('[data-done] a')].map(a => a.getAttribute('href'))`,
					);
					expect(links).toEqual(expect.arrayContaining(["#/a/researcher", "#/g/12", "#/a/atlas"]));
					// the update's card is open: what was, what is, and a link; no button answers anything
					const card = `${section}.querySelector('[data-band-change][aria-label="Updated agent"]')`;
					await page.until(card);
					const text = await page.run<string>(`${card}.innerText`);
					expect(text).toContain("Tracks dates.");
					expect(text).toContain("Checks travel dates and fares.");
					expect(text).toContain("didn’t change");
					expect(await page.run(`${card}.querySelector('button')`)).toBe(null);
					expect(await page.run(`${card}.querySelector('a[href="#/a/atlas"]').innerText`)).toBe("Open Atlas");
					if (shots !== undefined) {
						await mkdir(shots, { recursive: true });
						await page.run(`${section}.scrollIntoView({ block: 'start' })`);
						await page.shoot(`${shots}/band-${width}.png`);
					}
					// the created agent's row (the first copy, in view) opens into its card, which says what is the owner's to give
					await page.run(`${section}.querySelector('[data-done="agent"] button').click()`);
					const made = `${section}.querySelector('[data-band-change][aria-label="New agent"]')`;
					await page.until(made);
					expect(await page.run<string>(`${made}.innerText`)).toContain("yours to give");
					if (shots !== undefined) {
						await page.run(`${made}.scrollIntoView({ block: 'center' })`);
						await page.run("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
						// the card is in the viewport, so the picture shows it
						const seen = await page.run<boolean>(
							`(() => { const r = ${made}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()`,
						);
						expect(seen).toBe(true);
						await page.shoot(`${shots}/band-${width}-agent-card.png`);
					}
					expect(page.errors().filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
				},
			);
		},
	);
