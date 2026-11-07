/** Real owner controls against a throwaway daemon: scope, persistence, and recoverable stale edits. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { MAX_MEMORY_BYTES } from "../src/core/memory.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { MemoryView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { freePort, skipShippedSkills, tempHome, viteCacheDir } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const button = (text: string) =>
	`[...document.querySelectorAll('button')].find(el => el.getClientRects().length > 0 && el.textContent.trim() === ${JSON.stringify(text)})`;
const input = (label: string) => `document.querySelector('input[aria-label="${label}"]')`;
async function click(page: Page, selector: string) {
	await page.until(selector);
	await page.run(
		`(() => {const el=${selector}; el.scrollIntoView({block:'nearest'}); el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); el.click();})()`,
	);
}
async function fill(page: Page, label: string, value: string) {
	await page.until(input(label));
	await page.run(
		`(() => {const el=${input(label)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
	);
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`memory scopes and errors work through the app at ${width}px`,
		async () => {
			const home = await tempHome();
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const models = createModels();
			models.setProvider(fauxProvider().provider);
			const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), log: () => {} });
			const base = `http://127.0.0.1:${daemon.port}`;
			const token = (await readDaemonFile(home))!.token!;
			await skipShippedSkills(daemon.port, token);
			const api = async <T>(path: string, method = "GET", body?: object): Promise<T> => {
				const response = await fetch(`${base}/api${path}`, {
					method,
					headers: { authorization: `Bearer ${token}` },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
				if (!response.ok) throw new Error(await response.text());
				return response.json() as Promise<T>;
			};
			const server = await createServer({
				configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
				cacheDir: await viteCacheDir(),
				server: {
					host: "127.0.0.1",
					port: await freePort(),
					strictPort: true,
					open: false,
					proxy: {
						"/api": { target: base, changeOrigin: true, headers: { origin: base } },
						"^/(?:icon(?:-maskable)?\\.svg|icon-(?:192|512|maskable-512)\\.png|apple-touch-icon\\.png|manifest\\.webmanifest)$":
							{ target: base, changeOrigin: true },
					},
				},
			});
			try {
				for (const id of ["mara", "atlas"])
					await api(`/agents/${id}`, "PUT", {
						base: null,
						text: `---\nname: ${id === "mara" ? "Mara" : "Atlas"}\ndescription: Memory test\n---\nBe brief.\n`,
					});
				await server.listen();
				const address = server.httpServer!.address();
				if (!address || typeof address === "string") throw new Error("No app port");
				await withPage(`http://127.0.0.1:${address.port}/#token=${token}`, { width, height: 900 }, async (page) => {
					await page.until(`document.body.textContent.includes('Mara')`);
					await page.run(`location.hash='#/a/mara'`);
					if (width < 768) await click(page, `document.querySelector('[aria-label="Mara: open its panel"]')`);
					await click(page, button("Memory"));
					await fill(page, "New agent fact", "Compare direct trains first");
					await click(page, button("Shared with the band"));
					await click(page, button("This agent"));
					expect(await page.run(`${input("New agent fact")}.value`)).toBe("Compare direct trains first");
					await click(page, button("Remember"));
					await page.until(`document.body.textContent.includes('Compare direct trains first')`);
					await click(page, button("Shared with the band"));
					await fill(page, "New shared fact", "Use metric units");
					await click(page, button("Remember"));
					await page.until(`document.body.textContent.includes('Use metric units')`);
					await page.run(`location.hash='#/a/atlas'`);
					await click(page, button("Memory"));
					await page.until(input("New agent fact"));
					expect(await page.run(`document.body.textContent.includes('Compare direct trains first')`)).toBe(false);
					await click(page, button("Shared with the band"));
					await page.until(`document.body.textContent.includes('Use metric units')`);
					await page.run(`location.hash='#/settings'`);
					await page.until(input("New shared fact"));
					expect(await page.run(`document.body.textContent.includes('Compare direct trains first')`)).toBe(false);
					await click(page, `document.querySelector('[aria-label="Edit: Use metric units"]')`);
					await fill(page, "The fact", "Use kilometres");
					await fill(page, "New shared fact", "Keep this unsaved draft");
					const file = join(home, "workspace", "memory", "global.md");
					const saved = await readFile(file, "utf8");
					await writeFile(file, "x".repeat(MAX_MEMORY_BYTES + 1));
					await page.until(`document.body.textContent.includes("Can't read memory")`);
					await writeFile(file, saved);
					await page.until(`!document.body.textContent.includes("Can't read memory")`);
					expect(await page.run(`${input("The fact")}?.value`)).toBe("Use kilometres");
					expect(await page.run(`${input("New shared fact")}?.value`)).toBe("Keep this unsaved draft");
					const shared = (await api<MemoryView>("/memory")).facts.find((fact) => fact.scope === "global")!;
					await api(`/memory/${shared.id}`, "PUT", { text: "Use metres" });
					await page.until(`document.body.textContent.includes('Use metres')`);
					await click(page, button("Save"));
					await page.until(`document.querySelector('[role="alert"]')?.textContent.includes('changed or was removed')`);
					expect(await page.run(`${input("The fact")}.value`)).toBe("Use kilometres");
					await click(page, button("Cancel"));
					await click(page, `document.querySelector('[aria-label="Edit: Use metres"]')`);
					await fill(page, "The fact", "Use kilometres");
					await click(page, button("Save"));
					await page.until(`document.body.textContent.includes('Use kilometres')`);
					await click(page, `document.querySelector('[aria-label="Forget: Use kilometres"]')`);
					await page.until(`document.querySelector('[role="alertdialog"]')`);
					expect(
						await page.run(
							`document.querySelector('[role="alertdialog"]').textContent.includes('What was said in chats stays')`,
						),
					).toBe(true);
					await click(page, button("Forget"));
					await page.until(`!document.body.textContent.includes('Use kilometres')`);
					expect((await api<MemoryView>("/memory")).facts).toEqual([
						expect.objectContaining({ text: "Compare direct trains first", scope: "agent", agent: "mara" }),
					]);
					expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await server.close();
				await daemon.close();
			}
		},
		90000,
	);
