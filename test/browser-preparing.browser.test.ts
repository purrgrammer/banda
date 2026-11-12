/** The app's first browser use while its optional preparation waits, against an isolated daemon and faux model. */
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { freePort, skipShippedSkills, tempHome, viteCacheDir } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

for (const width of [390, 1440]) {
	it.skipIf(!hasChrome())(`shows browser preparation without a blank page at ${width}px`, async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		let release = () => {};
		const preparing = new Promise<void>((resolve) => {
			release = resolve;
		});
		const faux = fauxProvider({ tokensPerSecond: 10_000 });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(
			Array.from({ length: 20 }, () => (request) => {
				const last = request.messages.at(-1);
				if (last?.role === "toolResult" && last.toolName === "message_user") return fauxAssistantMessage("Done.");
				if (last?.role === "toolResult" && last.toolName === "browser_navigate")
					return fauxAssistantMessage(
						[fauxToolCall("message_user", { text: "The browser download was unavailable." })],
						{ stopReason: "toolUse" },
					);
				if (!getCurrentTools(request.messages).some((tool) => tool.name === "browser_navigate"))
					return fauxAssistantMessage([fauxToolCall("tool_search", { query: "browser_navigate", limit: 1 })], {
						stopReason: "toolUse",
					});
				return fauxAssistantMessage([fauxToolCall("browser_navigate", { url: "https://example.com/" })], {
					stopReason: "toolUse",
				});
			}),
		);
		const daemon = await startDaemon({
			home,
			port: 0,
			models,
			log: () => {},
			box: {
				...hostBox(home),
				browser: () => ({
					command: async () => {
						await preparing;
						throw new Error("The browser download was unavailable.");
					},
					login: { username: "test", password: "test" },
				}),
			},
		});
		let web: ViteDevServer | undefined;
		try {
			const token = (await readDaemonFile(home))?.token;
			if (token === undefined) throw new Error("The test daemon did not publish its token");
			await skipShippedSkills(daemon.port, token);
			const named = await fetch(`http://127.0.0.1:${daemon.port}/api/companion`, {
				method: "PUT",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ name: "Sancho", personality: "Brief." }),
			});
			if (!named.ok) throw new Error(`Naming the test companion: ${named.status}`);
			web = await createServer({
				configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
				cacheDir: await viteCacheDir(),
				server: {
					host: "127.0.0.1",
					fs: {
						allow: [
							await realpath(new URL("..", import.meta.url)),
							await realpath(new URL("../node_modules", import.meta.url)),
						],
					},
					port: await freePort(),
					strictPort: true,
					open: false,
					proxy: {
						"/api": {
							target: `http://127.0.0.1:${daemon.port}`,
							changeOrigin: true,
							headers: { origin: `http://127.0.0.1:${daemon.port}` },
						},
					},
				},
			});
			await web.listen();
			const address = web.httpServer?.address();
			if (!address || typeof address === "string") throw new Error("The test web server did not listen");
			await withPage(`http://127.0.0.1:${address.port}/#token=${token}`, { width, height: 900 }, async (page) => {
				await page.until("localStorage.getItem('banda.token')");
				await page.run("location.hash = '#/a/sancho'");
				await page.until("document.querySelector('textarea[name=message]')", 15_000);
				await page.run("document.querySelector('textarea[name=message]').focus()");
				await page.input("Input.insertText", { text: "Open the example page." });
				await page.run("document.querySelector('button[aria-label=Send]').click()");
				await page.until("document.querySelector('progress[aria-label=\"Preparing browser\"]')", 8_000);
				expect(await page.run("document.body.textContent.includes('Preparing browser…')")).toBe(true);
				const takeOver =
					"[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Take over')";
				expect(await page.run(`${takeOver}?.disabled`)).toBe(true);
				await page.run(
					"[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Open').click()",
				);
				await page.until("document.querySelector('[role=dialog] progress[aria-label=\"Preparing browser\"]')", 8_000);
				expect(await page.run("document.querySelector('[role=dialog]').textContent.includes('is using it')")).toBe(
					false,
				);
				expect(await page.run("document.querySelector('[role=dialog]').scrollWidth <= innerWidth")).toBe(true);
				await page.run("document.querySelector('[role=dialog] button[aria-label=Close]').click()");
				release();
				await page.until("!document.querySelector('progress[aria-label=\"Preparing browser\"]')", 8_000);
				await page.until("document.body.textContent.includes('The browser download was unavailable.')", 8_000);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			release();
			await web?.close();
			await daemon.close();
		}
	});
}
