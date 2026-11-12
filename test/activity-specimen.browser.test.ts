import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

let server: WebServer;
let url: string;
beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer();
	url = `${server.origin}/#/specimen/activity`;
});
afterAll(async () => {
	await server?.close();
});

async function press(page: Page, selector: string) {
	await page.run(`(() => {
		const el = ${selector};
		if (!el) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
		el.scrollIntoView({block:'nearest'});
		if (typeof el.focus === 'function') el.focus();
		el.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, button:0, pointerType:'mouse'}));
		el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0}));
		el.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, button:0, pointerType:'mouse'}));
		el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, button:0}));
		el.click();
	})()`);
}
/** A message's activity control, as the app has it: the first message's, or the newest's. */
const first = `document.querySelector('[aria-label="View activity"]')`;
const newest = `[...document.querySelectorAll('[aria-label="View activity"]')].at(-1)`;
/** The nth step of the timeline that reads `title`, or the one whose state reads `state`. */
const step = (title: string, n = 0) =>
	`[...document.querySelectorAll('[role="dialog"] [aria-label="Inspect ${title}"]')][${n}]`;
const stepWith = (text: string) =>
	`[...document.querySelectorAll('[role="dialog"] [aria-label^="Inspect"]')].find(el => el.textContent.includes(${JSON.stringify(text)}))`;
/** A row of the full transcript by its title: closed rows hold nothing, so a test opens one before reading it. */
const row = (title: string, n = 0) =>
	`[...document.querySelectorAll('[data-raw-content] [data-raw-title]')].filter(el => el.textContent === ${JSON.stringify(title)})[${n}]?.closest('button')`;
const button = (text: string) =>
	`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const tab = (text: string) =>
	`[...document.querySelectorAll('[role="tab"]')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const dialogText = `document.querySelector('[role="dialog"]')?.textContent`;

for (const width of [320, 390, 1440]) {
	it.skipIf(!hasChrome())(`activity has three local depths, completion and failure at ${width}px`, async () => {
		await withPage(url, { width, height: 900 }, async (page) => {
			await page.until(first);
			expect(await page.run(`document.body.textContent.includes('browser_navigate')`)).toBe(false);
			await press(page, tab("Dark"));
			await press(page, first);
			await page.until(`${dialogText}?.includes('Working')`);
			expect(await page.run(`getComputedStyle(document.querySelector('[role="dialog"]')).colorScheme`)).toBe("dark");
			expect(await page.run(`${dialogText}.includes('browser_navigate')`)).toBe(false);
			expect(await page.run(`${button("Full transcript")} === undefined`)).toBe(true);
			// the step's whole row opens the transcript
			await press(page, step("Opening a page", 1));
			await page.until(`${dialogText}?.includes('browser_navigate')`);
			expect(await page.run(`document.querySelectorAll('[role="dialog"]').length`)).toBe(1);
			expect(await page.run(`${dialogText}.includes('renfe.com')`)).toBe(true);
			await page.until(`document.activeElement?.textContent === 'Full transcript'`);
			await press(page, row("browser_navigate result", 1));
			await page.until(`${dialogText}?.includes('08:00')`);
			await press(page, row("browser_navigate", 1));
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
			await page.until(`${dialogText}?.includes('Working')`);
			await press(page, button("Close"));
			await page.until(`!document.querySelector('[role="dialog"]')`);
			await page.until(`document.activeElement?.getAttribute('aria-label') === 'View activity'`);

			await press(page, tab("Failure"));
			await page.until(`document.querySelectorAll('[aria-label="View activity"]').length === 2`);
			await press(page, newest);
			await page.until(`${dialogText}?.includes('Failed')`);
			await press(page, stepWith("Failed"));
			await page.until(row("browser_navigate result", 2));
			await press(page, row("browser_navigate result", 2));
			await page.until(`${dialogText}?.includes('ERR_CONNECTION_RESET')`);
			await press(page, button("Close"));
			await page.until(`!document.querySelector('[role="dialog"]')`);

			await press(page, tab("Finished"));
			await page.until(`document.querySelector('[aria-label="View activity"]')`);
			await press(page, `[...document.querySelectorAll('[aria-label="View activity"]')].at(-1)`);
			await page.until(`${dialogText}?.includes('How the work was done')`);
			await press(page, step("Opening a page"));
			await page.until(`document.querySelector('[aria-label="Tools"]')`);
			expect(
				await page.run(
					`(() => {const content=document.querySelector('[data-raw-content]'); return [...content.children].slice(0,3).map(el=>el.querySelector('button,h3')?.textContent.trim());})()`,
				),
			).toEqual(["System prompt", "Tools3", "Your message"]);
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
			await press(page, row("bash result"));
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
		await page.until(first);
		await press(page, first);
		await page.until(step("Thinking"));
		await press(page, step("Thinking"));
		await page.until(`document.querySelector('[data-thinking]')`);
		await press(page, row("browser_navigate"));
		// Fonts and async highlighting can resize the transcript after the sheet first opens.
		await page.run(
			`document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`,
		);
		await page.until(`document.querySelector('[data-code-block="json"] span[style*="--code-"]')`);
		// the transcript opens at its start and stays where the reader is while the run streams on
		await page.until(`[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Latest')`);
		expect(await page.run(`document.querySelector('[data-raw-content]').parentElement.scrollTop`)).toBe(0);
		const before = await page.run<number>(`document.querySelector('[data-thinking]').textContent.length`);
		// the control sits in the chat behind the sheet: a pointer there would dismiss it, a click alone does not
		await page.run(`${button("Play stream")}.click()`);
		await page.until(`document.querySelector('[data-thinking]').textContent.length > ${before}`);
		expect(await page.run(`document.querySelector('[data-raw-content]').parentElement.scrollTop`)).toBe(0);
		// the run ends: the transcript is the recorded one, in the same open sheet
		await page.until(`${dialogText}?.includes('Request details') && !${dialogText}?.includes('Streaming')`, 30_000);
		expect(await page.run(`document.querySelectorAll('[role="dialog"]').length`)).toBe(1);
		expect(await page.run(`document.querySelector('[data-raw-content]').parentElement.scrollTop`)).toBe(0);
		await press(page, button("Latest"));
		await page.until(
			`(() => { const el=document.querySelector('[data-raw-content]').parentElement; return el.scrollHeight - el.clientHeight - el.scrollTop < 5; })()`,
		);
		expect(page.errors()).toEqual([]);
	});
});
