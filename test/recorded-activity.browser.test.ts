import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixture } from "./fixtures/recorded-activity.ts";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";
import { chooseMessageAction } from "./smoke/message-actions.ts";

let server: WebServer;
let home: string;
let base: string;

beforeAll(async () => {
	if (!hasChrome()) return;
	home = await mkdtemp(join(tmpdir(), "banda-recorded-specimen-"));
	const path = join(home, "private.json");
	await writeFile(path, JSON.stringify(fixture), { mode: 0o600 });
	const before = process.env.BANDA_ACTIVITY_FIXTURE;
	process.env.BANDA_ACTIVITY_FIXTURE = path;
	try {
		server = await webServer();
	} finally {
		if (before === undefined) delete process.env.BANDA_ACTIVITY_FIXTURE;
		else process.env.BANDA_ACTIVITY_FIXTURE = before;
	}
	base = server.origin;
});
afterAll(async () => {
	await server?.close();
	if (home) await rm(home, { recursive: true, force: true });
});
async function click(page: Page, selector: string) {
	await page.run(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`recorded preview shows the full available toolset, not just called tools, at ${width}px`,
		async () => {
			await withPage(`${base}/#/specimen/activity/recorded`, { width, height: 900 }, async (page) => {
				await page.until(`document.querySelector('[data-recorded-chat]')`);
				expect(await page.run(`document.body.textContent.includes('The source is unavailable')`)).toBe(true);
				expect(
					await page.run(`document.querySelector('[data-recorded-chat]').textContent.includes('View activity')`),
				).toBe(false);
				const action = `document.querySelector('[data-recorded-chat] button[data-message-transcript]')`;
				const bubble = `${action}.closest('[class~="group/bubble"]')`;
				const height = await page.run<number>(`${bubble}.getBoundingClientRect().height`);
				await page.run(`${action}.focus()`);
				await page.until(`getComputedStyle(${action}).opacity === '1'`);
				expect(await page.run(`${bubble}.getBoundingClientRect().height`)).toBe(height);
				await chooseMessageAction(page, action, "Activity");
				await page.until(`document.querySelector('[role="dialog"] [data-step]')`);
				expect(await page.run(`document.querySelector('[role="dialog"]').textContent.includes('Failed')`)).toBe(true);
				// a tab opens as it takes focus
				await page.run(
					`document.querySelector('[role="dialog"] [aria-label="Depth"] [role="tab"]:last-child').focus()`,
				);
				await page.until(`document.querySelector('[aria-label="Tools"]')`);
				expect(
					await page.run(`document.querySelector('[aria-label="Tools"] button').getAttribute('aria-expanded')`),
				).toBe("false");
				await click(page, '[aria-label="Tools"] button');
				expect(
					await page.run(
						`document.querySelector('[aria-label="Tools"] [data-tool-icon="web_fetch"]').classList.contains('lucide-globe')`,
					),
				).toBe(true);
				expect(await page.run(`document.querySelector('[aria-label="Tools"] [data-tool-preview]').textContent`)).toBe(
					"Complete tool description 0",
				);
				expect(
					await page.run(
						`[...document.querySelectorAll('[data-raw-content] button')].filter(el=>!el.closest('[aria-label="Tools"]')).find(el=>el.querySelector('[data-raw-title]')?.textContent==='web_fetch').querySelector('[data-tool-preview]').textContent`,
					),
				).toBe("https://example.test/events");
				expect(
					await page.run(
						`[...document.querySelectorAll('[data-raw-content] [data-tool] button')].find(el=>el.querySelector('[data-raw-title]')?.textContent==='web_fetch').textContent.includes('Failed')`,
					),
				).toBe(true);
				expect(await page.run(`document.querySelector('[aria-label="Tools"]').querySelectorAll('button').length`)).toBe(
					23,
				);
				expect(
					await page.run(`document.querySelector('[role="dialog"]').textContent.includes('available_tool_21')`),
				).toBe(true);
				await page.run(
					`(()=>{const el=[...document.querySelectorAll('[aria-label="Tools"] button')].find(el=>el.querySelector('[data-raw-title]')?.textContent==='available_tool_21');el.scrollIntoView();el.click();})()`,
				);
				await page.until(
					`document.querySelector('[role="dialog"]').textContent.includes('Complete tool description 21')`,
				);
				await page.until(`document.querySelector('[data-code-block="json"] span[style*="--code-"]')`);
				await page.run(
					`(()=>{const el=[...document.querySelectorAll('[role="dialog"] button')].find(el=>el.textContent==='System prompt');el.scrollIntoView();el.click();})()`,
				);
				await page.until(
					`document.querySelector('[role="dialog"]').textContent.includes('Recorded system prompt, not regenerated.')`,
				);
				await page.run(
					`(()=>{const el=[...document.querySelectorAll('[data-raw-content] [data-tool] button')].find(el=>el.querySelector('[data-raw-title]')?.textContent==='web_fetch');el.scrollIntoView();el.click();})()`,
				);
				await page.until(`document.querySelector('[role="dialog"]').textContent.includes('Page unavailable')`);
				expect(await page.run(`document.querySelectorAll('[role="dialog"]').length`)).toBe(1);
				expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
				expect(
					await page.run(
						`[...document.querySelectorAll('[role="dialog"] pre')].every(el=>el.scrollWidth<=el.clientWidth)`,
					),
				).toBe(true);
				expect(page.errors()).toEqual([]);
			});
		},
	);
