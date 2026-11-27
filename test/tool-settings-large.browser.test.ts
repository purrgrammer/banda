/**
 * A connection with a long tool list, as a big MCP server gives (its reads only proposed, its writes asking every time),
 * set through the app the way an owner does: a group's control offers what changes something, sets its tools at once
 * and says where they are; each tool's own control follows; and what the app shows is what the daemon holds.
 */
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createServer as createViteServer } from "vite";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { CapabilitiesView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { type FakeTool, startFakeMcp } from "./fixtures/mcp-server.ts";
import { tempHome, viteCacheDir } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const schema = {
	type: "object",
	properties: { team: { type: "string", description: "The team it belongs to. ".repeat(8) }, id: { type: "string" } },
};
const tool = (name: string, reads: boolean): FakeTool => ({
	name,
	description: `${name}: ${"what it does, at length. ".repeat(20)}`,
	inputSchema: schema,
	...(reads ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true }),
});
const TOOLS: FakeTool[] = [
	...Array.from({ length: 150 }, (_, i) => tool(`${i % 4 === 0 ? "update" : "get"}_zq${i}`, i % 4 !== 0)),
	tool("list_drains", true),
	tool("get_drain", true),
	tool("create_drain", false),
	tool("delete_drain", false),
	...Array.from({ length: 14 }, (_, i) =>
		tool(
			`${["list", "get", "find", "search", "fetch", "read", "query", "describe", "show", "view", "list_all", "get_my", "find_by", "show_the"][i]}_checks`,
			true,
		),
	),
];

const selectOf = (label: string) => `document.querySelector('[role="combobox"][aria-label=${JSON.stringify(label)}]')`;
const toolSelect = (name: string) => `document.querySelector('[data-tool="${name}"] [role="combobox"]')`;

async function click(page: Page, selector: string) {
	const point = `(() => {
		const element = ${selector};
		if (!element || element.disabled) return null;
		const { x, y, width, height } = element.getBoundingClientRect();
		const center = { x: x + width / 2, y: y + height / 2 };
		return element.contains(document.elementFromPoint(center.x, center.y)) ? center : null;
	})()`;
	await page.until(`Boolean(${point})`);
	const center = await page.run<{ x: number; y: number }>(point);
	await page.input("Input.dispatchMouseEvent", { type: "mouseMoved", ...center });
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...center });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...center });
}

/** Pick `setting` on the select `trigger`; gives what the list offered and what the control shows once it answers again. */
async function pick(page: Page, trigger: string, setting: string) {
	await page.until(`${trigger} && !${trigger}.disabled && !document.querySelector('[role="listbox"]')`);
	await page.run(`${trigger}.scrollIntoView({ block: 'center' })`);
	await click(page, trigger);
	await page.until(`document.querySelector('[role="option"]')`);
	const offered = await page.run<string[]>(
		`[...document.querySelectorAll('[role="option"]')].map(el => el.textContent.trim())`,
	);
	await click(
		page,
		`[...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === ${JSON.stringify(setting)})`,
	);
	await page.until(`${trigger}.getAttribute('aria-expanded') === 'false' && !${trigger}.disabled`);
	return { offered, shows: await page.run<string>(`${trigger}.textContent.trim()`) };
}

it.skipIf(!hasChrome())(
	"owner sets a long tool list by its groups and tool by tool",
	async () => {
		const home = await tempHome();
		const fake = await startFakeMcp();
		fake.tools = TOOLS;
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const models = createModels();
		models.setProvider(fauxProvider().provider);
		const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), log: () => {} });
		const base = `http://127.0.0.1:${daemon.port}`;
		const token = (await readDaemonFile(home))?.token as string;
		const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
		const added = (await (
			await fetch(`${base}/api/capabilities/mcp`, {
				method: "POST",
				headers,
				body: JSON.stringify({ url: fake.url, service: "Big" }),
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
			await withPage(url, { width: 1440, height: 900 }, async (page) => {
				await page.until(`document.body.textContent.includes('Sancho')`);
				await page.run(`location.hash='#/connections?connection=${added.name}'`);
				await page.until(`document.querySelector('[data-connection-details="${added.name}"]')`);
				const first = await view();
				expect(first.groups).toEqual(["Drains", "Checks", "Other"]);
				const words: Record<string, string> = { allow: "Allow", ask: "Ask", always: "Always ask", off: "Off" };
				const group = (name: string) => selectOf(`Every tool in ${name}`);
				const counts = async (name: string) => {
					const found: Record<string, number> = {};
					for (const each of (await view()).tools.filter((tool) => tool.group === name)) {
						const key = `${each.classed?.kind}:${each.setting}`;
						found[key] = (found[key] ?? 0) + 1;
					}
					return found;
				};
				/** Every row of `name`, once open, shows what the daemon holds. */
				const rowsAgree = async (name: string) => {
					const held = (await view()).tools.filter((tool) => tool.group === name);
					const shown = await page.run<Record<string, string>>(
						`Object.fromEntries([...document.querySelectorAll('[data-group=${JSON.stringify(name)}] [data-tool]')].map(el => [el.dataset.tool, el.querySelector('[role="combobox"]').textContent.trim()]))`,
					);
					expect(
						held.filter((tool) => shown[tool.title] !== words[tool.setting ?? ""]).map((tool) => tool.title),
					).toEqual([]);
				};
				expect(await page.run(`${group("Checks")}.textContent.trim()`)).toBe("Ask");
				// reads alone: Allow, Ask or Off, and no second Ask that would change nothing
				const checks = await pick(page, group("Checks"), "Allow");
				expect(checks.offered).toEqual(["Allow", "Ask", "Off"]);
				expect(checks.shows).toBe("Allow");
				expect(await counts("Checks")).toEqual({ "read:allow": 14 });
				// reads with writes that only ask every time: Allow takes the reads, and says so once nothing more can be allowed
				const drains = await pick(page, group("Drains"), "Allow");
				expect(drains.offered).toEqual(["Allow", "Ask", "Off"]);
				expect(drains.shows).toBe("Allow");
				expect(await counts("Drains")).toEqual({ "read:allow": 2, "write:always": 2 });
				expect((await pick(page, group("Drains"), "Off")).shows).toBe("Off");
				expect(await counts("Drains")).toEqual({ "read:off": 2, "write:off": 2 });
				expect((await pick(page, group("Drains"), "Ask")).shows).toBe("Ask");
				expect(await counts("Drains")).toEqual({ "read:ask": 2, "write:always": 2 });
				// the long group, whole, in one change
				expect((await pick(page, group("Other"), "Allow")).shows).toBe("Allow");
				expect(await counts("Other")).toEqual({ "read:allow": 112, "write:always": 38 });
				// then tools of it one after another, each at its own control; the group follows them
				await page.run(`document.querySelector('[data-group="Other"] button').click()`);
				await page.until(`document.querySelector('[data-tool="get_zq1"]')`);
				for (const name of ["get_zq1", "get_zq2", "get_zq3", "get_zq5", "get_zq6", "get_zq7"])
					expect((await pick(page, toolSelect(name), "Ask")).shows).toBe("Ask");
				expect((await pick(page, toolSelect("update_zq0"), "Off")).shows).toBe("Off");
				expect(await page.run(`${group("Other")}.textContent.trim()`)).toBe("Mixed");
				expect(await counts("Other")).toEqual({ "read:allow": 106, "read:ask": 6, "write:always": 37, "write:off": 1 });
				for (const name of ["get_zq1", "get_zq2", "get_zq3", "get_zq5", "get_zq6", "get_zq7"])
					expect((await pick(page, toolSelect(name), "Allow")).shows).toBe("Allow");
				expect((await pick(page, toolSelect("update_zq0"), "Always ask")).shows).toBe("Always ask");
				expect(await page.run(`${group("Other")}.textContent.trim()`)).toBe("Allow");
				// nothing the stream says afterwards takes any of it back
				await new Promise((resolve) => setTimeout(resolve, 1000));
				await rowsAgree("Other");
				expect(await page.run(`${group("Other")}.textContent.trim()`)).toBe("Allow");
				expect(await page.run(`document.querySelectorAll('[data-sonner-toast]').length`)).toBe(0);
				// a list this long has a filter: typed into, only what matches is listed, open, each row with its own control
				await page.run(`document.querySelector('input[aria-label="Filter tools"]').focus()`);
				await page.input("Input.insertText", { text: "drain" });
				await page.until(`document.querySelectorAll('[data-tool-list] [data-tool]').length === 4`);
				expect(await page.run(`[...document.querySelectorAll('[data-group]')].map(el => el.dataset.group)`)).toEqual([
					"Drains",
				]);
				expect(await page.run(`document.querySelector('[data-group="Drains"]').textContent.includes('4 of 4')`)).toBe(
					true,
				);
				expect(await page.run(`Boolean(${group("Drains")})`)).toBe(false);
				expect((await pick(page, toolSelect("get_drain"), "Allow")).shows).toBe("Allow");
				expect(await counts("Drains")).toEqual({ "read:allow": 1, "read:ask": 1, "write:always": 2 });
				expect(page.errors()).toEqual([]);
			});
		} finally {
			await vite.close();
			await new Promise<void>((resolve) => listener.close(() => resolve()));
			await daemon.close();
			await fake.close();
		}
	},
	300000,
);
