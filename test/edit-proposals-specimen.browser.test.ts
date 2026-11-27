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
				name: "edit-proposals-specimen:no-daemon",
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

/** Set a field's value as typing does, so React hears it. */
const type = (field: string, value: string) =>
	`(() => { const el = ${field}; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`a pull request's title reads as the agent's, edits in place, says it is the owner's and undoes, at ${width}px`,
		async () => {
			await withPage(`${server.origin}/#/specimen?section=github&only=1`, { width, height: 1000 }, async (page) => {
				const shots = process.env.BANDA_EDIT_SHOTS;
				await page.until(`document.querySelector('#github [aria-label="Edit title"]')`);
				// the open draft's fields, held by an id: its Edit's own label changes once it is pressed
				await page.run(
					`document.querySelector('#github [aria-label="Edit title"]').closest('[data-slot="field-group"]').id = 'pr-fields'`,
				);
				const card = `document.getElementById('pr-fields')`;
				await page.run(`${card}.scrollIntoView({ block: 'center' })`);
				// the answered card beside it reads what ran: the owner's title, said to be theirs, with nothing to edit
				expect(
					await page.run(`document.getElementById('github').innerText.includes('Keep the open file across reloads')`),
				).toBe(true);
				expect(await page.run(`${card}.querySelector('input, textarea')`)).toBe(null);
				expect(await page.run(`${card}.innerText.includes('Edited by you')`)).toBe(false);
				if (shots !== undefined) {
					await mkdir(shots, { recursive: true });
					await page.shoot(`${shots}/pr-${width}-read.png`);
				}
				await page.run(`${card}.querySelector('[aria-label="Edit title"]').click()`);
				await page.until(`${card}.querySelector('input')`);
				await page.run(type(`${card}.querySelector('input')`, "Keep the open file when the panel reloads"));
				await page.until(`${card}.innerText.includes('Edited by you')`);
				expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
				if (shots !== undefined) await page.shoot(`${shots}/pr-${width}-editing.png`);
				await page.run(`${card}.querySelector('[aria-label="Done editing title"]').click()`);
				await page.until(`!${card}.querySelector('input')`);
				expect(await page.run(`${card}.innerText.includes('Keep the open file when the panel reloads')`)).toBe(true);
				if (shots !== undefined) await page.shoot(`${shots}/pr-${width}-edited.png`);
				await page.run(`[...${card}.querySelectorAll('button')].find((b) => b.innerText === 'Undo').click()`);
				await page.until(`!${card}.innerText.includes('Edited by you')`);
				expect(await page.run(`${card}.innerText.includes('Fix panel reload')`)).toBe(true);
				expect(page.errors()).toEqual([]);
			});
		},
		60_000,
	);

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`a proposed routine's schedule edits as one line, read back in words, and holds Set it up while it is no schedule, at ${width}px`,
		async () => {
			await withPage(
				`${server.origin}/#/specimen?section=routine-items&only=1`,
				{ width, height: 1000 },
				async (page) => {
					const shots = process.env.BANDA_EDIT_SHOTS;
					await page.until(`document.querySelector('#routine-items [aria-label="Edit when"]')`);
					// the card being edited: the section's first "Edit when" and the nearest element around it that holds its
					// own Set it up. Since #154 the section also holds cards whose last answer did not happen, each saying why
					// in an alert of its own, so the edited card's alert is looked for in that card alone.
					await page.run(
						// `true` only so the evaluation returns a value Chrome can serialize; the next check says what was found
						`(window.__edited = (() => { let el = document.querySelector('#routine-items [aria-label="Edit when"]'); while (el && el.id !== 'routine-items' && ![...el.querySelectorAll('button')].some((b) => b.innerText === 'Set it up')) el = el.parentElement; return el; })(), true)`,
					);
					const card = "window.__edited";
					expect(
						await page.run(
							`${card} !== null && ${card}.id !== 'routine-items' && ${card}.querySelectorAll('[aria-label="Edit when"]').length === 1`,
						),
					).toBe(true);
					// the specimen draws the section once per scheme (stage.tsx: a light and a dark frame, each `data-scheme`), so
					// each of #154's two cards with a problem is there twice. The edit is made in the light frame's first card;
					// the dark frame is only counted.
					expect(await page.run(`document.querySelectorAll('#routine-items [data-scheme]').length`)).toBe(2);
					expect(await page.run(`${card}.closest('[data-scheme]')?.dataset.scheme`)).toBe("light");
					const problems = `document.querySelectorAll('#routine-items [data-routine-problem]').length`;
					const ownProblems = `${card}.closest('[data-scheme]').querySelectorAll('[data-routine-problem]').length`;
					expect(await page.run(ownProblems)).toBe(2);
					expect(await page.run(problems)).toBe(4);
					const setUp = `[...${card}.querySelectorAll('button')].find((b) => b.innerText === 'Set it up')`;
					await page.run(`${card}.querySelector('[aria-label="Edit when"]').click()`);
					const field = `${card}.querySelector('input')`;
					await page.until(field);
					await page.run(type(field, "soon"));
					await page.until(`${card}.querySelector('[role="alert"]')`);
					expect(await page.run(`${setUp}.disabled`)).toBe(true);
					await page.run(type(field, "cron 30 9 * * 1-5"));
					await page.until(`!${card}.querySelector('[role="alert"]')`);
					expect(await page.run(`${setUp}.disabled`)).toBe(false);
					await page.run(`${card}.querySelector('[aria-label="Done editing when"]').click()`);
					await page.until(`!${field}`);
					expect(await page.run(`${card}.innerText.includes('09:30')`)).toBe(true);
					expect(await page.run(`${card}.innerText.includes('Edited by you')`)).toBe(true);
					// the other cards' problems are theirs, untouched by this edit, in its frame and in the other
					expect(await page.run(ownProblems)).toBe(2);
					expect(await page.run(problems)).toBe(4);
					expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
					if (shots !== undefined) {
						await mkdir(shots, { recursive: true });
						await page.run(
							`document.querySelector('#routine-items [aria-label="Edit when"]').scrollIntoView({ block: 'center' })`,
						);
						await page.shoot(`${shots}/routine-${width}-edited.png`);
					}
					expect(page.errors()).toEqual([]);
				},
			);
		},
		60_000,
	);
