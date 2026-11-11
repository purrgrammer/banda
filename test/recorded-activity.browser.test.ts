import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { RecordedActivity } from "../web/src/specimen/agent/recorded-types.ts";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

let server: WebServer;
let home: string;
let base: string;
const fixture: RecordedActivity = {
	agent: { name: "Sancho" },
	capturedAt: 123,
	runs: [
		{
			id: 1,
			input: "Find an event",
			at: 123,
			kind: "user",
			prompt: {
				system: "Recorded system prompt, not regenerated.",
				tools: Array.from({ length: 22 }, (_, i) => ({
					name: i === 0 ? "web_fetch" : `available_tool_${i}`,
					description: `Complete tool description ${i}`,
					parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
				})),
			},
			items: [
				{ id: 1, role: "user", text: "Find an event", at: 123 },
				{
					id: 2,
					role: "assistant",
					text: "",
					at: 124,
					model: "faux/test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
					calls: [{ id: "fetch", name: "web_fetch", args: { url: "https://example.test/events" } }],
				},
				{ id: 3, role: "tool", call: "fetch", name: "web_fetch", text: "Page unavailable", error: true, at: 125 },
				{
					id: 4,
					role: "assistant",
					text: "",
					at: 126,
					model: "faux/test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
					calls: [
						{
							id: "reply",
							name: "message_user",
							args: { text: "The source is unavailable; I could not verify an event." },
						},
					],
				},
				{ id: 5, role: "tool", call: "reply", name: "message_user", text: "Sent.", error: false, at: 127 },
			],
		},
	],
};

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
				const action = `document.querySelector('[data-recorded-chat] button[aria-label="View activity"]')`;
				const bubble = `${action}.closest('[class~="group/bubble"]')`;
				const height = await page.run<number>(`${bubble}.getBoundingClientRect().height`);
				expect(await page.run(`${bubble}.querySelector('button[aria-label="Copy the message"]') !== null`)).toBe(true);
				await page.run(`${action}.focus()`);
				await page.until(`getComputedStyle(${action}).opacity === '1'`);
				await page.until(
					`getComputedStyle(${bubble}.querySelector('[aria-label="Copy the message"]')).opacity === '1'`,
				);
				expect(await page.run(`${bubble}.getBoundingClientRect().height`)).toBe(height);
				await page.run(
					`document.activeElement.blur(); ${bubble}.dispatchEvent(new PointerEvent('pointerdown', {pointerType:'touch',bubbles:true}))`,
				);
				await page.until(`${action}.classList.contains('opacity-100')`);
				await page.run(`${bubble}.dispatchEvent(new PointerEvent('pointerup', {pointerType:'touch',bubbles:true}))`);
				expect(await page.run(`${bubble}.getBoundingClientRect().height`)).toBe(height);
				await click(page, '[data-recorded-chat] button[aria-label="View activity"]');
				await page.until(`document.querySelector('[aria-label="Inspect Reading a page"]')`);
				expect(await page.run(`document.querySelector('[role="dialog"]').textContent.includes('Failed')`)).toBe(true);
				await click(page, '[aria-label="Inspect Reading a page"]');
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
						`[...document.querySelectorAll('[data-raw-content] button')].find(el=>el.querySelector('[data-raw-title]')?.textContent==='web_fetch result').textContent.includes('Failed')`,
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
					`(()=>{const el=[...document.querySelectorAll('[data-raw-content] button')].find(el=>el.querySelector('[data-raw-title]')?.textContent==='web_fetch result');el.scrollIntoView();el.click();})()`,
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
it.skipIf(!hasChrome())("private data is same-origin, no-store, and inaccessible to another origin", async () => {
	const response = await fetch(`${base}/__specimen/activity`);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
	expect(((await response.json()) as RecordedActivity).runs[0]?.prompt.tools).toHaveLength(22);
	expect((await fetch(`${base}/__specimen/activity`, { headers: { origin: "https://example.test" } })).status).toBe(
		403,
	);
	expect((await fetch(`${base}/__specimen/activity`, { method: "POST" })).status).toBe(404);
});
