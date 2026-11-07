import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freePort, viteCacheDir } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

let server: ViteDevServer;
let url: string;
beforeAll(async () => {
	if (!hasChrome()) return;
	server = await createServer({
		configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
		cacheDir: await viteCacheDir(),
		server: { port: await freePort(), strictPort: true, host: "127.0.0.1", open: false },
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("No specimen port");
	url = `http://127.0.0.1:${address.port}/#/specimen/activity`;
});
afterAll(async () => {
	await server?.close();
});

async function press(page: Page, selector: string) {
	await page.run(`(() => {
		const el = ${selector};
		if (!el) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
		el.scrollIntoView({block:'nearest'});
		el.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, button:0, pointerType:'mouse'}));
		el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0}));
		el.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, button:0, pointerType:'mouse'}));
		el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, button:0}));
		el.click();
	})()`);
}
const labelled = (label: string) => `document.querySelector('[aria-label="${label}"]')`;
const button = (text: string) =>
	`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const tab = (text: string) =>
	`[...document.querySelectorAll('[role="tab"]')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const dialogText = `document.querySelector('[role="dialog"]')?.textContent`;

for (const width of [320, 390, 1440]) {
	it.skipIf(!hasChrome())(`activity has three local depths, completion and failure at ${width}px`, async () => {
		await withPage(url, { width, height: 900 }, async (page) => {
			await page.until(labelled("View current activity"));
			expect(await page.run(`document.body.textContent.includes('browser_navigate')`)).toBe(false);
			await press(page, tab("Dark"));
			await press(page, labelled("View current activity"));
			await page.until(`${dialogText}?.includes('What’s happening')`);
			expect(await page.run(`getComputedStyle(document.querySelector('[role="dialog"]')).colorScheme`)).toBe("dark");
			expect(await page.run(`${dialogText}.includes('browser_navigate')`)).toBe(false);
			expect(await page.run(`${button("Full transcript")} === undefined`)).toBe(true);
			// A tap on the source badge also opens the transcript: the entire step content is the target.
			await press(page, `${labelled("Inspect reading departures and fares")}.querySelector('[data-slot="badge"]')`);
			await page.until(`${dialogText}?.includes('browser_navigate')`);
			expect(await page.run(`document.querySelectorAll('[role="dialog"]').length`)).toBe(1);
			expect(await page.run(`${dialogText}.includes('08:00')`)).toBe(true);
			expect(await page.run(`${dialogText}.includes('renfe.com')`)).toBe(true);
			await page.until(`document.activeElement?.textContent === 'Full transcript'`);
			await page.until(`document.querySelector('[data-code-block="json"] span[style*="--code-"]')`);
			expect(
				await page.run(`document.querySelector('[data-code-block="json"] pre').innerText.includes('  "url"')`),
			).toBe(true);
			expect(
				await page.run(
					`(() => {const el=document.querySelector('[role="dialog"]'); return el.scrollWidth <= el.clientWidth;})()`,
				),
			).toBe(true);
			await press(page, button("Activity"));
			await page.until(`${dialogText}?.includes('What’s happening')`);
			await press(page, button("Close"));
			await page.until(`!document.querySelector('[role="dialog"]')`);
			await page.until(`document.activeElement?.getAttribute('aria-label') === 'View current activity'`);

			await press(page, tab("Failure"));
			await press(page, labelled("View current activity"));
			await page.until(`${dialogText}?.includes('Failed · view error')`);
			await press(page, labelled("Inspect comparing the options"));
			await page.until(`${dialogText}?.includes('ERR_CONNECTION_RESET')`);
			await press(page, button("Close"));
			await page.until(`!document.querySelector('[role="dialog"]')`);

			await press(page, tab("Finished"));
			await page.until(`document.querySelector('[aria-label="View activity"]')`);
			await press(page, `[...document.querySelectorAll('[aria-label="View activity"]')].at(-1)`);
			await page.until(`${dialogText}?.includes('How the work was done')`);
			await press(page, labelled("Inspect looking up direct trains"));
			await page.until(`document.querySelector('[aria-label="Tools"]')`);
			expect(await page.run(`${dialogText}.includes('Thinking is shown only')`)).toBe(false);
			expect(
				await page.run(
					`(() => {const content=document.querySelector('[data-raw-content]'); return [...content.children].slice(0,3).map(el=>el.querySelector('button,h3')?.textContent.trim());})()`,
				),
			).toEqual(["System prompt", "Tools3", "Your message10:41:58"]);
			expect(await page.run(`${button("System prompt")}.getAttribute('aria-expanded')`)).toBe("false");
			expect(await page.run(`${button("Tools3")}.getAttribute('aria-expanded')`)).toBe("false");
			await press(page, button("Tools3"));
			expect(await page.run(`document.querySelector('[aria-label="Tools"]').querySelectorAll('button').length`)).toBe(
				4,
			);
			await press(page, button("System prompt"));
			await page.until(`${dialogText}?.includes('You are Mara')`);
			await press(page, button("System prompt"));
			expect(await page.run(`${dialogText}.includes('browser_navigate')`)).toBe(true);
			expect(await page.run(`${dialogText}.includes('message_user')`)).toBe(true);
			await page.until(`document.querySelector('[data-terminal] code span[style*="--code-"]')`);
			expect(
				await page.run(
					`document.querySelector('[data-terminal-output]').textContent.includes('2 trains arrive before noon')`,
				),
			).toBe(true);
			expect(
				await page.run(
					`[...document.querySelectorAll('[role="dialog"] pre')].every(el => el.scrollWidth <= el.clientWidth)`,
				),
			).toBe(true);
			expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
			expect(page.errors()).toEqual([]);
		});
	});
}

it.skipIf(!hasChrome())("streaming preserves inspection and keeps the sheet open when work completes", async () => {
	await withPage(url, { width: 390, height: 740 }, async (page) => {
		await page.until(labelled("View current activity"));
		await press(page, labelled("View current activity"));
		await page.until(labelled("Inspect comparing the options"));
		await press(page, labelled("Inspect comparing the options"));
		await page.until(`document.querySelector('[data-thinking]')`);
		// Fonts and async highlighting can resize the transcript after the sheet first opens.
		await page.run(
			`document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`,
		);
		await page.until(`document.querySelector('[data-code-block="json"] span[style*="--code-"]')`);
		await page.until(
			`(() => {const el=document.querySelector('[data-raw-content]').parentElement; return el.scrollHeight - el.clientHeight - el.scrollTop < 5;})()`,
		);
		await page.run(
			`(() => {const el=document.querySelector('[data-raw-content]').parentElement; el.dispatchEvent(new WheelEvent('wheel', {deltaY:-800,bubbles:true})); el.scrollTop=0;})()`,
		);
		await page.until(`[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Latest')`);
		const before = await page.run<number>(`document.querySelector('[data-thinking]').textContent.length`);
		await press(page, button("Play"));
		await page.until(`document.querySelector('[data-thinking]').textContent.length > ${before}`);
		expect(await page.run(`document.querySelector('[data-raw-content]').parentElement.scrollTop`)).toBe(0);
		await page.until(`${dialogText}?.includes('Finished · 32s')`);
		expect(await page.run(`document.querySelectorAll('[role="dialog"]').length`)).toBe(1);
		expect(await page.run(`document.querySelector('[data-raw-content]').parentElement.scrollTop`)).toBe(0);
		await press(page, button("Latest"));
		await page.until(
			`(() => { const el=document.querySelector('[data-raw-content]').parentElement; return el.scrollHeight - el.clientHeight - el.scrollTop < 5; })()`,
		);
		expect(page.errors()).toEqual([]);
	});
});
