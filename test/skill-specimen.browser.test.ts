import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freePort, viteCacheDir } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

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
	url = `http://127.0.0.1:${address.port}/#/specimen?section=skills`;
});
afterAll(async () => {
	await server?.close();
});

for (const width of [390, 1440]) {
	it.skipIf(!hasChrome())(`skill composer, loaded card and catalogue at ${width}px`, async () => {
		await withPage(url, { width, height: 900 }, async (page) => {
			await page.until(`document.querySelector('#skills textarea[name="message"]')`);
			await page.run(
				`[...document.querySelectorAll('header button')].find(button => button.textContent === ${width === 390 ? "'Dark'" : "'Light'"})?.click()`,
			);
			expect(await page.run(`document.querySelector('#skills [data-scheme]')?.getAttribute('data-scheme')`)).toBe(
				width === 390 ? "dark" : "light",
			);
			await page.run(
				`(() => {document.querySelector('#skills').scrollIntoView({block:'start'}); document.querySelector('#skills textarea[name="message"]').focus();})()`,
			);
			await page.input("Input.insertText", { text: "/res" });
			await page.until(`document.querySelector('#skills [role="listbox"][aria-label="Choose a skill"]')`);
			expect(
				await page.run(
					`(() => {const r=document.querySelector('#skills [role="listbox"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;})()`,
				),
			).toBe(true);
			expect(
				await page.run(`document.querySelector('#skills [role="option"]')?.textContent.includes('/research')`),
			).toBe(true);
			if (width === 390) await page.run(`document.querySelector('#skills [role="option"]')?.click()`);
			else {
				await page.input("Input.dispatchKeyEvent", {
					type: "keyDown",
					key: "Enter",
					code: "Enter",
					windowsVirtualKeyCode: 13,
				});
				await page.input("Input.dispatchKeyEvent", {
					type: "keyUp",
					key: "Enter",
					code: "Enter",
					windowsVirtualKeyCode: 13,
				});
			}
			await page.until(`document.querySelector('#skills textarea[name="message"]')?.value === '/research '`);
			await page.input("Input.insertText", { text: "Compare trains to Lisbon." });
			await page.run(`document.querySelector('#skills button[aria-label="Send"]')?.click()`);
			await page.until(`document.querySelectorAll('#skills [role="log"] a[href*="/skills/"]').length === 3`);
			expect(
				await page.run(`document.querySelector('#skills [role="log"]')?.textContent.includes('Check at least two')`),
			).toBe(false);
			await page.run(`document.querySelector('#skills textarea[name="message"]').focus()`);
			await page.input("Input.insertText", { text: "Show `/review` but use /trip-planner for dates." });
			await page.run(`document.querySelector('#skills button[aria-label="Send"]')?.click()`);
			await page.until(`document.querySelectorAll('#skills [role="log"] a[href*="/skills/"]').length === 4`);
			expect(await page.run(`document.querySelectorAll('#skills [role="log"] a[href$="/review"]').length`)).toBe(1);
			await page.run(`document.querySelector('#skill-activity [data-slot="collapsible-trigger"]')?.click()`);
			await page.until(
				`document.querySelector('#skill-activity [data-skill-tool-preview]')?.getBoundingClientRect().height > 0`,
			);
			expect(
				await page.run(
					`document.querySelector('#skill-activity')?.textContent.includes('Check at least two independent sources.')`,
				),
			).toBe(true);
			expect(await page.run(`document.querySelector('#skill-activity')?.textContent.includes('checklist.md')`)).toBe(
				true,
			);
			await page.run(`document.querySelector('#skills [role="log"] a[href$="/trip-planner"]')?.click()`);
			await page.until(`location.hash === '#/specimen/skills/trip-planner'`);
			expect(
				await page.run(
					`document.querySelector('[data-skill-detail-page]')?.textContent.includes('skills/trip-planner/routes.md')`,
				),
			).toBe(true);
			await page.run(`document.querySelector('[data-skill-detail-page] header a')?.click()`);
			await page.until(`document.querySelector('#skills-about [data-slot="collapsible-trigger"]')`);
			await page.run(`document.querySelector('#skills-about [data-slot="collapsible-trigger"]')?.click()`);
			await page.until(`document.querySelector('#skills-about li a[href$="/research"]')`);
			await page.run(`document.querySelector('#skills-about li a[href$="/research"]')?.click()`);
			await page.until(`location.hash === '#/specimen/skills/research'`);
			expect(
				await page.run(
					`document.querySelector('[data-skill-detail]')?.textContent.includes('Compare sources, check their dates')`,
				),
			).toBe(true);
			expect(
				await page.run(
					`document.querySelector('[data-skill-detail]')?.textContent.includes('skills/research/checklist.md')`,
				),
			).toBe(true);
			expect(page.errors()).toEqual([]);
		});
	});
}
