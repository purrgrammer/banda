import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

let web: WebServer | undefined;
beforeAll(async () => {
	if (!hasChrome()) return;
	web = await webServer({ configFile: fileURLToPath(new URL("../site/vite.config.ts", import.meta.url)) });
});
afterAll(async () => {
	await web?.close();
});

const SHOWCASES = ["app", "computer", "routine", "github", "slack", "calendar", "mcp", "watch", "coding-agent"];

for (const width of [390, 1440]) {
	it.skipIf(!hasChrome())(`draws every showcase chat within the page at ${width}px`, async () => {
		await withPage("about:blank", { width, height: 900 }, async (page) => {
			await page.input("Network.enable", {});
			await page.input("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
			await page.goto(`${web?.origin}/site/`);
			await page.until(`document.querySelector('[data-showcase]')`);
			await page.run(`document.querySelector('#acp').scrollIntoView()`);
			await page.until(
				`${JSON.stringify(SHOWCASES)}.every((name) => document.querySelector(\`[data-showcase="\${name}"]\`)?.shadowRoot?.firstElementChild?.childElementCount > 0)`,
			);
			// what overflows its chat, by name, so a failure says which one
			const overflowing = await page.run<string[]>(
				`${JSON.stringify(SHOWCASES)}.filter((name) => { const chat = document.querySelector(\`[data-showcase="\${name}"]\`).shadowRoot.firstElementChild; return chat.scrollWidth > chat.clientWidth + 1; })`,
			);
			expect(overflowing).toEqual([]);
			expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
			expect(page.errors()).toEqual([]);
		});
	});
}
