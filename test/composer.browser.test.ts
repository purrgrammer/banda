import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

let server: WebServer;
let url: string;
beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer();
	url = `${server.origin}/#/specimen?section=composer&scheme=light&only=1`;
});
afterAll(async () => {
	await server?.close();
});

// one frame: a composer in each of light and dark would keep the same draft, and the empty one overwrite it
const root = `document.querySelector('#composer-steer')`;
const at = (selector: string) => (selector === "" ? root : `${root}?.querySelector('${selector}')`);
const field = at(`textarea[name="message"]`);
const sent = `[...(${root}?.querySelectorAll('[data-sent] li') ?? [])].map(li => li.textContent)`;
const attached = `[...(${root}?.querySelectorAll('[data-attachment]') ?? [])].map(el => el.dataset.attachment)`;

/** How many files the draft keeps in IndexedDB, once saved. */
const keptFiles = `new Promise((resolve) => { const db = indexedDB.open('banda-drafts', 1); db.onsuccess = () => { try { const got = db.result.transaction('files').objectStore('files').get('specimen:steer:light'); got.onsuccess = () => { resolve((got.result ?? []).length); db.result.close(); }; } catch { resolve(-1); } }; db.onerror = () => resolve(-1); })`;

/** Wait until the draft keeps `count` files. */
const keeps = (page: Page, count: number) => page.until(`(${keptFiles}).then((kept) => kept === ${count})`);

async function open(page: Page) {
	await page.until(field);
	await page.run(`${at("")}.scrollIntoView({block:'center'})`);
}

async function type(page: Page, text: string) {
	// at the end of what is there, as a person carries on writing
	await page.run(
		`(() => { const at = ${field}; at.focus(); at.setSelectionRange(at.value.length, at.value.length); })()`,
	);
	await page.input("Input.insertText", { text });
}

async function attach(page: Page, name: string, body: string) {
	await page.run(`(() => {
		const input = ${at(`input[type="file"]`)};
		const files = new DataTransfer();
		files.items.add(new File([${JSON.stringify(body)}], ${JSON.stringify(name)}, { type: "text/plain" }));
		input.files = files.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
	})()`);
}

for (const width of [390, 1440]) {
	it.skipIf(!hasChrome())(
		`the composer always offers Send and never Stop; the draft survives at ${width}px`,
		async () => {
			await withPage(url, { width, height: 900 }, async (page) => {
				await open(page);
				// empty while working: Send, and no Stop
				expect(await page.run(`!!${at(`button[aria-label="Send"]`)} && !${at(`button[aria-label="Stop"]`)}`)).toBe(
					true,
				);

				await type(page, "Take the 10:40");
				await attach(page, "notes.txt", "seat 12A");
				await page.until(`${attached}.some(text => text.includes('notes.txt'))`);

				// a reload keeps the words and the file
				await keeps(page, 1);
				await page.goto(url.replace("#", "?reload=1#"));
				await open(page);
				await page.until(`${field}.value === 'Take the 10:40'`);
				await page.until(`${attached}.some(text => text.includes('notes.txt'))`, 5000);

				// sent, it goes; words written while it is on its way stay in the composer
				await page.run(`${at(`button[aria-label="Send"]`)}.click()`);
				await type(page, " and the bags");
				await page.until(`${sent}.includes('Sent: Take the 10:40 + notes.txt')`);
				await page.until(`${field}.value === 'and the bags'`);
				expect(await page.run(`${attached}.length`)).toBe(0);

				// emptied, still Send and no Stop; a reload brings no file back
				await page.run(
					`(() => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(${field}, ''); ${field}.dispatchEvent(new Event('input', { bubbles: true })); })()`,
				);
				await page.until(`!!${at(`button[aria-label="Send"]`)} && !${at(`button[aria-label="Stop"]`)}`);
				await keeps(page, 0);
				await page.goto(url.replace("#", "?reload=2#"));
				await open(page);
				await new Promise((resolve) => setTimeout(resolve, 500));
				expect(await page.run(`${field}.value`)).toBe("");
				expect(await page.run(`${attached}.length`)).toBe(0);
				expect(page.errors()).toEqual([]);
			});
		},
		60_000,
	);

	it.skipIf(!hasChrome())(
		`Send is off with nothing to send: blanks, Enter and a second tap send nothing more, a file alone goes, at ${width}px`,
		async () => {
			await withPage(url, { width, height: 900 }, async (page) => {
				await open(page);
				const send = at(`button[aria-label="Send"]`);
				const form = `${field}.closest('form')`;
				const enter = async () => {
					await page.run(`${field}.focus()`);
					const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
					await page.input("Input.dispatchKeyEvent", { type: "keyDown", ...key });
					await page.input("Input.dispatchKeyEvent", { type: "keyUp", ...key });
				};
				// longer than a send takes here (600ms), so a message that went would be listed
				const settle = () => new Promise((resolve) => setTimeout(resolve, 1200));

				// empty, and only blanks: Send is off, and neither Enter nor the form itself sends
				expect(await page.run(`${send}.disabled`)).toBe(true);
				await type(page, "   \n  ");
				expect(await page.run(`${send}.disabled`)).toBe(true);
				await enter();
				await page.run(`${form}.requestSubmit()`);
				await settle();
				expect(await page.run(sent)).toEqual([]);

				// words: Send is on; tapped twice at once, one message goes, and the emptied composer sends nothing more
				await page.run(
					`(() => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(${field}, ''); ${field}.dispatchEvent(new Event('input', { bubbles: true })); })()`,
				);
				await type(page, "Window seat, please");
				await page.until(`${send}.disabled === false`);
				await page.run(`(() => { const button = ${send}; button.click(); button.click(); })()`);
				await page.until(`${sent}.includes('Sent: Window seat, please')`);
				await page.until(`${field}.value === '' && ${send}.disabled`);
				await page.run(`${send}.click()`);
				await enter();
				await page.run(`${form}.requestSubmit()`);
				await settle();
				expect(await page.run(sent)).toEqual(["Sent: Window seat, please"]);

				// a file and no words is something to send
				await attach(page, "ticket.txt", "coach 4");
				await page.until(`${attached}.some(text => text.includes('ticket.txt'))`);
				await page.until(`${send}.disabled === false`);
				await page.run(`${send}.click()`);
				await page.until(`${sent}.includes('Sent: ticket.txt')`);
				await page.until(`${attached}.length === 0 && ${send}.disabled`);
				expect(await page.run(sent)).toEqual(["Sent: Window seat, please", "Sent: ticket.txt"]);
				expect(page.errors()).toEqual([]);
			});
		},
		60_000,
	);
}
