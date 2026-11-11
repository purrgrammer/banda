import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

/**
 * The specimen mounts a section's contents when it comes near the view: every section is there to link and jump to, the
 * ones far below cost nothing, and one jumped to shows and stays where it landed.
 */
let server: WebServer;
let base: string;

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer();
	base = server.origin;
});

afterAll(async () => {
	await server?.close();
});

const headers = `document.querySelectorAll('main section[id]').length`;
const mounted = `document.querySelectorAll('main section[id]:has([data-scheme])').length`;

it.skipIf(!hasChrome())("opens with every section listed and only those near the view mounted", async () => {
	await withPage(`${base}/#/specimen`, { width: 1440, height: 900 }, async (page) => {
		await page.until(`${mounted} > 0`);
		const all = await page.run<number>(headers);
		expect(all).toBeGreaterThan(40);
		expect(await page.run<number>(mounted)).toBeLessThan(all / 4);
	});
});

it.skipIf(!hasChrome())("mounts a section jumped to from the contents, and it stays where it landed", async () => {
	await withPage(`${base}/#/specimen`, { width: 1440, height: 900 }, async (page) => {
		await page.until(`${mounted} > 0`);
		await page.run(`document.querySelector('[data-section="drive"]').click()`);
		await page.until(`document.querySelector('#drive [data-scheme]')`);
		await page.until(
			`Math.abs(document.getElementById('drive').getBoundingClientRect().top - document.querySelector('main').getBoundingClientRect().top - 16) < 2`,
		);
		expect(await page.run<number>(mounted)).toBeLessThan((await page.run<number>(headers)) / 4);
	});
});

it.skipIf(!hasChrome())("mounts a linked section at phone width", async () => {
	await withPage(`${base}/#/specimen?section=contacts&width=phone`, { width: 390, height: 844 }, async (page) => {
		await page.until(`document.querySelector('#contacts [data-scheme]')`);
	});
});
