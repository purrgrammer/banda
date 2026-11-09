/**
 * A connection's details through the app, against a throwaway daemon and a fake MCP server: the tool list in its groups,
 * each tool's kind and source, a setting changed in place, an agent switched, and a tool the server added since waiting
 * for the owner, told from one they switched off. At both widths, with no horizontal scroll.
 */
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
import { hasChrome, withPage } from "./smoke/chrome.ts";

const choice = (tool: string, setting: string) =>
	`[...document.querySelector('[data-tool="${tool}"]').querySelectorAll('[role="radio"]')].find(el => el.textContent.trim() === ${JSON.stringify(setting)})`;
const switchOf = (agent: string) =>
	`document.getElementById([...document.querySelectorAll('label')].find(el => el.textContent.trim() === ${JSON.stringify(agent)})?.htmlFor)`;

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`owner checks and changes a connection's details at ${width}`,
		async () => {
			const home = await tempHome();
			const fake = await startFakeMcp();
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const models = createModels();
			const faux = fauxProvider();
			models.setProvider(faux.provider);
			faux.setResponses(
				Array.from(
					{ length: 20 },
					() => () =>
						fauxAssistantMessage([
							fauxToolCall("message_user", { parts: [{ type: "text", text: "Ready." }] } as never),
						]),
				),
			);
			const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), log: () => {} });
			const base = `http://127.0.0.1:${daemon.port}`;
			const token = (await readDaemonFile(home))?.token as string;
			await skipShippedSkills(daemon.port, token);
			const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
			const added = (await (
				await fetch(`${base}/api/capabilities/mcp`, {
					method: "POST",
					headers,
					body: JSON.stringify({ url: fake.url, service: "Cal" }),
				})
			).json()) as { name: string };
			const view = async () => {
				const all = (await (await fetch(`${base}/api/capabilities`, { headers })).json()) as CapabilitiesView;
				return all.connections.find((each) => each.name === added.name) as CapabilitiesView["connections"][number];
			};
			let vite: Awaited<ReturnType<typeof createViteServer>>;
			const listener = createServer((req, res) => vite.middlewares(req, res));
			vite = await createViteServer({
				configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
				cacheDir: await viteCacheDir(),
				server: {
					middlewareMode: true,
					hmr: { server: listener },
					proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } },
				},
			});
			try {
				await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
				const address = listener.address();
				if (!address || typeof address === "string") throw new Error("No app port");
				const url = `http://127.0.0.1:${address.port}/#token=${token}`;
				await withPage(url, { width, height: 900 }, async (page) => {
					await page.until(`document.body.textContent.includes('Sancho')`);
					await page.run(`location.hash='#/connections?connection=${added.name}'`);
					await page.until(`document.querySelector('[data-connection-details="${added.name}"]')`);
					await page.until(`document.querySelector('[data-group="Events"]')`);
					expect(await page.run(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(
						true,
					);
					// each tool says its kind and who said so, once its group is open
					await page.run(`document.querySelector('[data-group="Events"] button').click()`);
					await page.until(`document.querySelector('[data-tool="list_events"]')`);
					expect(await page.run(`document.querySelector('[data-tool="list_events"]').textContent`)).toContain(
						"The server says · reads",
					);
					expect(await page.run(`document.querySelector('[data-tool="create_event"]').textContent`)).toContain(
						"Nobody said · unknown, so it asks",
					);
					// Allow on what the server only proposed: it is a read now, and the owner's
					await page.run(`${choice("list_events", "Allow")}.click()`);
					await page.until(`${choice("list_events", "Allow")}.getAttribute('aria-checked') === 'true'`);
					expect((await view()).tools.find((tool) => tool.title === "list_events")).toMatchObject({
						classed: { kind: "read", from: "you" },
						setting: "allow",
					});
					// Ask on it, at once
					await page.run(`${choice("list_events", "Ask")}.click()`);
					await page.until(`${choice("list_events", "Ask")}.getAttribute('aria-checked') === 'true'`);
					expect((await view()).tools.find((tool) => tool.title === "list_events")?.setting).toBe("ask");
					// an agent, switched here
					await page.until(switchOf("Sancho"));
					await page.run(`${switchOf("Sancho")}.click()`);
					await page.until(`${switchOf("Sancho")}.getAttribute('aria-checked') === 'true'`);
					expect((await view()).agents).toEqual(["sancho"]);
					// a tool the server adds later waits, and says so; it is not the owner's off
					fake.tools = [
						...fake.tools,
						{ name: "archive_events", description: "New.", inputSchema: { type: "object" } },
					];
					await fetch(`${base}/api/capabilities/connections/${added.name}/refresh`, {
						method: "POST",
						headers,
						body: "{}",
					});
					await page.until(
						`document.querySelector('[data-tool="archive_events"]')?.textContent.includes('Waiting for you')`,
					);
					await page.run(`${choice("archive_events", "Off")}.click()`);
					await page.until(
						`!document.querySelector('[data-tool="archive_events"]').textContent.includes('Waiting for you')`,
					);
					expect((await view()).tools.find((tool) => tool.title === "archive_events")?.waiting).toBeUndefined();
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await vite.close();
				await new Promise<void>((resolve) => listener.close(() => resolve()));
				await daemon.close();
				await fake.close();
			}
		},
		110000,
	);
