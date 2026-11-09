/** The owner flow against a real throwaway daemon and a local OAuth/MCP service. No live provider or credentials. */
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createServer as createViteServer } from "vite";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { CapabilitiesView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { startFakeMcp } from "./fixtures/mcp-server.ts";
import { skipShippedSkills, tempHome, viteCacheDir } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const button = (text: string) =>
	`[...document.querySelectorAll('button')].find(el => el.getClientRects().length && el.textContent.trim() === ${JSON.stringify(text)})`;
const labelled = (text: string) =>
	`document.getElementById([...document.querySelectorAll('label')].find(el => el.textContent.trim() === ${JSON.stringify(text)})?.htmlFor)`;
async function click(page: Page, expression: string) {
	// OAuth opens another tab. A person returns to this tab before interacting; CDP input alone does not focus it.
	await page.input("Page.bringToFront", {});
	await page.until(expression);
	await page.run(`(${expression}).scrollIntoView({block:'center'})`);
	await page.until(
		`(() => {const el=${expression}; const dialog=el.closest('[role="alertdialog"]'); return !dialog || dialog.getAnimations({subtree:true}).every(animation => animation.playState !== 'running');})()`,
	);
	const point = await page.run<{ x: number; y: number }>(
		`(() => {const el=${expression}; const r=el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if(!el.contains(document.elementFromPoint(x,y))) throw new Error('Control is not hit-testable'); return {x,y};})()`,
	);
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
async function fill(page: Page, label: string, value: string) {
	await page.until(labelled(label));
	await page.run(
		`(() => {const el=${labelled(label)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
	);
}
const phase = (page: Page, value: string) => page.until(`document.querySelector('[data-mcp-phase="${value}"]')`);

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`owner connects OAuth MCP and controls access through the app at ${width}`,
		async () => {
			const home = await tempHome();
			const fake = await startFakeMcp({ auth: "oauth", issuerParameter: true });
			fake.instructions = "Ernesto test introduction. Use fs_read to read files.";
			fake.tools = [
				{
					name: "fs_read",
					description: "Read a file",
					inputSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
					readOnlyHint: true,
				},
				{
					name: "execute",
					description: "Run a route, which may write",
					inputSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
				},
			];
			fake.onCall = async () => ({ text: "A disposable MCP response" });
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const models = createModels();
			const faux = fauxProvider();
			models.setProvider(faux.provider);
			faux.setResponses(
				Array.from(
					{ length: 100 },
					() => () =>
						fauxAssistantMessage([
							fauxToolCall("message_user", { parts: [{ type: "text", text: "Ready." }] } as never),
						]),
				),
			);
			let daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), log: () => {} });
			const base = `http://127.0.0.1:${daemon.port}`;
			const token = (await readDaemonFile(home))!.token!;
			await skipShippedSkills(daemon.port, token);
			const view = async () =>
				(await (
					await fetch(`${base}/api/capabilities`, { headers: { authorization: `Bearer ${token}` } })
				).json()) as CapabilitiesView;
			let vite: Awaited<ReturnType<typeof createViteServer>>;
			const listener = createServer((req, res) => vite.middlewares(req, res));
			vite = await createViteServer({
				configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
				cacheDir: await viteCacheDir(),
				server: {
					middlewareMode: true,
					hmr: { server: listener },
					proxy: {
						"/api": { target: base, changeOrigin: true, headers: { origin: base } },
						"^/(?:icon(?:-maskable)?\\.svg|icon-(?:192|512|maskable-512)\\.png|apple-touch-icon\\.png|manifest\\.webmanifest)$":
							{ target: base, changeOrigin: true },
					},
				},
			});
			try {
				await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
				const address = listener.address();
				if (!address || typeof address === "string") throw new Error("No app port");
				await withPage(`http://127.0.0.1:${address.port}/#token=${token}`, { width, height: 900 }, async (page) => {
					await page.until(`document.body.textContent.includes('Sancho')`);
					await page.run(`location.hash='#/connections'`);
					// at desktop width Connections is the agent's Access, which shows only what it has: the rest is behind "Show more"
					await page.until(
						`${button("Add MCP server")} || [...document.querySelectorAll('button')].some(el => /^Show \\d+ more$/.test(el.textContent.trim()))`,
					);
					if (!(await page.run<boolean>(`Boolean(${button("Add MCP server")})`)))
						await click(
							page,
							`[...document.querySelectorAll('button')].find(el => /^Show \\d+ more$/.test(el.textContent.trim()))`,
						);
					await click(page, button("Add MCP server"));
					await phase(page, "setup");
					await fill(page, "Server address", fake.url);
					await fill(page, "Name", "Ernesto test");
					await click(page, button("Check server"));
					await phase(page, "auth");
					expect((await view()).connections.filter((each) => each.name === "ernesto-test").length).toBe(1);
					const currentHash = await page.run<string>("location.hash");
					await page.goto(`http://127.0.0.1:${address.port}/?reload=1${currentHash}`);
					await phase(page, "auth");
					await click(page, button("Continue to sign in"));
					await phase(page, "review");
					await page.until(`${labelled("Account")}?.textContent.includes('Unnamed account')`);
					expect(await page.run(`/account \\d/.test(document.body.textContent)`)).toBe(false);
					expect(await page.run(`${button("Save access")}.disabled`)).toBe(true);
					await fill(page, "Name this account", "Work");
					const connection = (await view()).connections.find((each) => each.name === "ernesto-test")!;
					expect(connection.accounts).toEqual([expect.objectContaining({ id: "account 1", agents: [] })]);
					expect(connection.tools.every((tool) => tool.kind === "write")).toBe(true);
					expect(fake.calls).toEqual([]);
					await click(
						page,
						`[...document.querySelectorAll('summary')].find(el => el.textContent === 'Introduction from the server')`,
					);
					expect(await page.run(`document.body.textContent.includes('Ernesto test introduction.')`)).toBe(true);
					await click(
						page,
						`[...document.querySelectorAll('summary')].find(el => el.textContent === 'Read without asking')`,
					);
					await click(page, labelled("fs_read"));
					await click(page, labelled("Sancho"));
					await click(page, button("Save access"));
					await phase(page, "done");
					let connected = (await view()).connections.find((each) => each.name === connection.name)!;
					expect(connected.accounts?.[0]?.agents).toEqual(["sancho"]);
					expect(connected.tools.find((tool) => tool.title === "fs_read")?.kind).toBe("read");
					expect(connected.tools.find((tool) => tool.title === "execute")?.kind).toBe("write");
					// Same-home restart keeps only the access the owner actually granted.
					const port = daemon.port;
					await daemon.close();
					daemon = await startDaemon({ home, port, models, box: hostBox(home), log: () => {} });
					await page.goto(`http://127.0.0.1:${address.port}/?reload=2${currentHash}`);
					await phase(page, "review");
					await page.until(`${labelled("Sancho")}?.getAttribute('aria-checked') === 'true'`);
					await click(page, labelled("Sancho"));
					await click(page, button("Save access"));
					await phase(page, "done");
					connected = (await view()).connections.find((each) => each.name === connection.name)!;
					expect(connected.accounts?.[0]?.agents).toEqual([]);
					await click(page, button("Sign out"));
					await click(
						page,
						`[...document.querySelectorAll('[role="alertdialog"] button')].find(el => el.textContent.trim() === 'Sign out')`,
					);
					try {
						await phase(page, "auth");
					} catch (error) {
						console.log(
							"signout diagnostic",
							JSON.stringify({
								accounts: (await view()).connections.find((each) => each.name === connection.name)?.accounts?.length,
								ui: await page.run(
									"({phase:document.querySelector('[data-mcp-phase]')?.getAttribute('data-mcp-phase'), alert:document.querySelector('[role=alert]')?.textContent, dialog:document.querySelector('[role=alertdialog]')?.textContent})",
								),
							}),
						);
						await page.shoot("/tmp/banda-mcp-signout-failed.png");
						throw error;
					}
					expect((await view()).connections.find((each) => each.name === connection.name)?.accounts).toEqual([]);
					expect(await page.run("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await vite.close();
				await new Promise<void>((resolve) => listener.close(() => resolve()));
				await daemon.close();
				await fake.close();
			}
		},
		90000,
	);
