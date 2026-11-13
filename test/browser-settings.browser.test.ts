import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { BrowserPreparation, PreparedBrowser } from "../src/box/browser-preparation.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, skipShippedSkills, tempHome, type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const text = "document.body.innerText";
const button = (label: string) =>
	`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
async function click(page: Page, label: string) {
	await page.until(`${button(label)} && !${button(label)}.disabled`);
	await page.run(`${button(label)}.scrollIntoView({block:'center'})`);
	const point = await page.run<{ x: number; y: number }>(
		`(() => { const r = ${button(label)}.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
	);
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

for (const width of [390, 1440]) {
	it.skipIf(!hasChrome())(`General observes lazy browser preparation, failure and retry at ${width}px`, async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		let state: BrowserPreparation = { state: "idle" };
		const listeners = new Set<() => void>();
		const publish = (next: BrowserPreparation) => {
			state = next;
			for (const listener of listeners) listener();
		};
		let calls = 0;
		const browser: PreparedBrowser = {
			forAgent: () => {
				throw new Error("General must not open an agent browser");
			},
			prepare: async () => {
				calls++;
				publish({ state: "preparing", phase: "checking" });
			},
			state: () => state,
			watch: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const daemon = await startDaemon({
			home,
			port: 0,
			models: echoModels().models,
			log: () => {},
			box: { ...hostBox(home), kind: "microvm", browser },
		});
		let web: WebServer | undefined;
		try {
			const token = (await readDaemonFile(home))?.token;
			if (token === undefined) throw new Error("The test daemon did not publish its token");
			await skipShippedSkills(daemon.port, token);
			const base = `http://127.0.0.1:${daemon.port}`;
			web = await webServer({
				server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
			});
			const proof = process.env.BANDA_BROWSER_STATUS_PROOF;
			if (proof !== undefined) await mkdir(proof, { recursive: true });
			await withPage(`${web.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
				await page.until("localStorage.getItem('banda.token')");
				await page.run("location.hash = '#/settings'");
				await page.until(`${text}.includes('Prepared on first use') && ${button("Prepare browser")}`);
				expect(calls).toBe(0);
				expect(await page.run(`${text}.includes('Ready to browse')`)).toBe(false);
				await click(page, "Prepare browser");
				await page.until(`${text}.includes('Checking browser files…')`);
				expect(calls).toBe(1);
				expect(await page.run("document.querySelector('progress[aria-label=\"Browser download\"]')")).toBeNull();
				publish({ state: "preparing", phase: "downloading", received: 24_000_000, total: 80_000_000 });
				await page.until("document.querySelector('progress[aria-label=\"Browser download\"]')?.value === 24000000");
				expect(await page.run("document.querySelector('progress').max")).toBe(80_000_000);
				await page.until(`${text}.includes('24.0 of 80.0 MB')`);
				expect(await page.run("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
				if (proof !== undefined) await page.shoot(join(proof, `browser-download-${width}.png`));
				publish({ state: "preparing", phase: "starting" });
				await page.until(`${text}.includes('Starting the browser…') && !document.querySelector('progress')`);
				for (const [problem, words] of [
					["download-unavailable", "The browser download is unavailable."],
					["download-failed", "The browser download could not finish."],
					["integrity", "The browser download could not be verified."],
					["startup", "The browser could not start."],
				] satisfies readonly (readonly [Extract<BrowserPreparation, { state: "failed" }>["problem"], string])[]) {
					publish({ state: "failed", problem });
					await page.until(
						`${button("Retry")} && ${text}.includes(${JSON.stringify(words)}) && !document.querySelector('progress')`,
					);
					expect(await page.run(`${text}.includes('https://') || ${text}.includes('sha256')`)).toBe(false);
					if (proof !== undefined && problem === "download-unavailable")
						await page.shoot(join(proof, `browser-failed-${width}.png`));
					await click(page, "Retry");
					await page.until(`${text}.includes('Checking browser files…')`);
				}
				expect(calls).toBe(5);
				publish({ state: "ready" });
				await page.until(`${text}.includes('Available when needed.') && ${text}.includes('No browser pages running.')`);
				expect(await page.run(`Boolean(${button("Prepare browser")}) || Boolean(${button("Retry")})`)).toBe(false);
				if (proof !== undefined) await page.shoot(join(proof, `browser-ready-${width}.png`));
				publish({ state: "unavailable" });
				await page.until(`${text}.includes('Not available on this computer.')`);
				expect(await page.run(`Boolean(${button("Prepare browser")}) || Boolean(${button("Retry")})`)).toBe(false);
				expect(calls).toBe(5);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			await web?.close();
			await daemon.close();
		}
	});
}
