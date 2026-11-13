import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

let web: WebServer | undefined;
let base: string;
beforeAll(async () => {
	if (!hasChrome()) return;
	web = await webServer({
		root: fileURLToPath(new URL("../site", import.meta.url)),
		configFile: false,
	});
	base = web.origin;
});
afterAll(async () => {
	await web?.close();
});

for (const width of [390, 1440]) {
	it.skipIf(!hasChrome())(`offers direct downloads with GitHub API blocked at ${width}px`, async () => {
		await withPage("about:blank", { width, height: 900 }, async (page) => {
			await page.input("Network.enable", {});
			await page.input("Network.setBlockedURLs", {
				urls: ["*api.github.com*", "*fonts.googleapis.com*", "*fonts.gstatic.com*"],
			});
			await page.input("Network.setUserAgentOverride", {
				userAgent:
					width === 390
						? "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36"
						: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
				platform: width === 390 ? "Linux armv8l" : "Win32",
			});
			await page.goto(base);
			await page.until(`document.querySelector('#download').href.includes('/releases/download/')`);
			expect(
				await page.run(`document.querySelector('#download').href.endsWith('${width === 390 ? ".apk" : ".exe"}')`),
			).toBe(true);
			// every file once in the list; the hero's shortcuts repeat some, and are checked like the rest below
			expect(
				await page.run(`new Set([...document.querySelectorAll('a[data-file]')].map((a) => a.dataset.file)).size`),
			).toBe(13);
			expect(
				await page.run(
					`[...document.querySelectorAll('a[data-file]')].every(a => a.href.includes('/releases/download/') && a.getBoundingClientRect().height > 0)`,
				),
			).toBe(true);
			expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
		});
	});
}
