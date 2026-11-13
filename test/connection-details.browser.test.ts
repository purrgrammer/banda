/**
 * A connection's details through the app, against a throwaway daemon and a fake MCP server: the tool list in its groups,
 * each tool's kind and source, a setting changed in place, an agent switched, and a tool the server added since waiting
 * for the owner, told from one they switched off. At both widths, with no horizontal scroll.
 */
import { mkdir, writeFile } from "node:fs/promises";
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

const permission = (tool: string) => `document.querySelector('[data-tool="${tool}"] [role="combobox"]')`;
async function choosePermission(page: Page, tool: string, setting: string) {
	const trigger = permission(tool);
	const click = async (selector: string) => {
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
	};
	await page.until(`${trigger} && !${trigger}.disabled && !document.querySelector('[role="listbox"]')`);
	await page.run(`${trigger}.scrollIntoView({ block: 'center' })`);
	await click(trigger);
	const option = `[...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === ${JSON.stringify(setting)})`;
	await click(option);
	await page.until(
		`${permission(tool)}.getAttribute('aria-expanded') === 'false' && !${permission(tool)}.disabled && ${permission(tool)}.textContent.trim() === ${JSON.stringify(setting)}`,
	);
}
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
					await page.until(
						`document.querySelector('nav[aria-label="Breadcrumb"] [aria-current="page"] h1')?.textContent === 'Cal'`,
					);
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
						"Not known · asks until you say",
					);
					// Allow on what the server only proposed: it is a read now, and the owner's
					await choosePermission(page, "list_events", "Allow");
					expect((await view()).tools.find((tool) => tool.title === "list_events")).toMatchObject({
						classed: { kind: "read", from: "you" },
						setting: "allow",
					});
					expect(await page.run(`document.querySelector('[aria-label="Every tool in Events"]').textContent`)).toBe(
						"Mixed",
					);
					// Ask on it, at once
					await choosePermission(page, "list_events", "Ask");
					expect((await view()).tools.find((tool) => tool.title === "list_events")?.setting).toBe("ask");
					await choosePermission(page, "create_event", "Always ask");
					expect((await view()).tools.find((tool) => tool.title === "create_event")?.setting).toBe("always");
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
						`document.querySelector('[data-tool="archive_events"]')?.textContent.includes('Off until you choose')`,
					);
					await choosePermission(page, "archive_events", "Off");
					await page.until(
						`!document.querySelector('[data-tool="archive_events"]').textContent.includes('Off until you choose')`,
					);
					expect((await view()).tools.find((tool) => tool.title === "archive_events")?.waiting).toBeUndefined();
					// Remove, confirmed, takes it whole and comes back to the list
					await page.run(
						`[...document.querySelectorAll('button')].find(el => el.textContent.trim().startsWith('Remove ')).click()`,
					);
					await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Its tool settings')`);
					await page.run(
						`[...document.querySelector('[role="alertdialog"]').querySelectorAll('button')].find(el => el.textContent.trim() === 'Remove').click()`,
					);
					await page.until(
						`!document.querySelector('[data-tool-list]') && document.body.textContent.includes('Add MCP server')`,
					);
					expect(await view()).toBeUndefined();
					// focus lands on the list's heading, not on nothing, once the Remove button is gone
					await page.until(`document.activeElement?.matches('h1[data-page-title]')`);
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

it.skipIf(!hasChrome())(
	"each account's menu changes its access or signs it out, asked first, with two accounts",
	async () => {
		const home = await tempHome();
		const fake = await startFakeMcp({ auth: "oauth", scopes: ["calendar", "repo"] });
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const shipped = join(home, "shipped");
		await mkdir(shipped, { recursive: true });
		await writeFile(
			join(shipped, "cal.json"),
			JSON.stringify({
				service: "Cal",
				about: "Your days",
				url: fake.url,
				auth: "oauth",
				scopes: ["calendar"],
				account: "get_me.login",
				reads: ["list_events"],
				needs: { create_event: ["repo"] },
				access: {
					choices: [
						{ label: "See your days", scopes: ["calendar"] },
						{ label: "Change them", scopes: ["repo"] },
					],
					note: "Sign in again to change this.",
				},
			}),
		);
		const models = createModels();
		models.setProvider(fauxProvider().provider);
		const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), shipped, log: () => {} });
		const base = `http://127.0.0.1:${daemon.port}`;
		const token = (await readDaemonFile(home))?.token as string;
		await skipShippedSkills(daemon.port, token);
		const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
		await fetch(`${base}/api/capabilities/connections/cal/add`, { method: "POST", headers, body: "{}" });
		for (const login of ["ana", "bob"]) {
			fake.user = login;
			const started = (await (
				await fetch(`${base}/api/capabilities/connections/cal/signin`, {
					method: "POST",
					headers,
					body: JSON.stringify({ scopes: ["calendar"] }),
				})
			).json()) as { url: string };
			const consent = await fetch(started.url, { redirect: "manual" });
			await fetch(consent.headers.get("location") ?? "", { redirect: "manual" });
		}
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
				await page.run(`window.open = () => ({ opener: null, close() {}, location: { replace() {} } })`);
				await page.run(`window.__signins = [];
					const was = window.fetch;
					window.fetch = (input, init) => {
						if (String(input).includes('/signin')) window.__signins.push(JSON.parse(init.body));
						return was(input, init);
					};
					location.hash = '#/connections?connection=cal'`);
				await page.until(`document.querySelector('[data-account="bob"]')`);
				// what acts on an account is in its row's menu, opened as a pointer opens it
				const menu = (who: string) =>
					`document.querySelector('[data-account="${who}"] [aria-label="More for @${who}"]')`;
				const item = (words: string) =>
					`[...document.querySelectorAll('[role="menu"][data-state="open"] [role="menuitem"]')].find(el => el.textContent.trim() === ${JSON.stringify(words)})`;
				// a person's click: at the control's middle, once nothing (a dialog closing) lies over it
				const press = async (expression: string) => {
					const at = `(() => {const el=${expression}; if (!el) return undefined; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); const x=r.x+r.width/2, y=r.y+r.height/2; return el.contains(document.elementFromPoint(x,y)) ? {x,y} : undefined;})()`;
					await page.until(at);
					const point = await page.run<{ x: number; y: number }>(at);
					await page.input("Input.dispatchMouseEvent", {
						type: "mousePressed",
						button: "left",
						clickCount: 1,
						...point,
					});
					await page.input("Input.dispatchMouseEvent", {
						type: "mouseReleased",
						button: "left",
						clickCount: 1,
						...point,
					});
				};
				const open = async (who: string, words: string) => {
					await page.input("Page.bringToFront", {});
					// a menu still animating closed (behind a confirm just dismissed) would take the press and close instead
					await page.until(`!document.querySelector('[role="menu"]')`);
					await press(menu(who));
					await press(item(words));
				};
				await open("ana", "Change access");
				await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('as @ana')`);
				await page.run(
					`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(el => /sign in/i.test(el.textContent)).click()`,
				);
				await page.until(`window.__signins.length > 0`);
				expect(await page.run(`window.__signins[0]`)).toMatchObject({ account: "ana", scopes: ["calendar"] });
				await page.run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
				await page.until(`!document.querySelector('[role="dialog"]')`);
				// what adds an account is one control below the list
				const add = `[...document.querySelectorAll('button')].filter(el => el.textContent.trim() === 'Add account')`;
				expect(await page.run(`${add}.length`)).toBe(1);
				// signing out of an account says who loses it, and nothing is sent until the owner says Sign out
				const sancho = await fetch(`${base}/api/capabilities/connections/cal/accounts/bob/switch`, {
					method: "POST",
					headers,
					body: JSON.stringify({ agent: "sancho", on: true }),
				});
				expect(sancho.ok).toBe(true);
				await page.until(`document.querySelector('[data-account="bob"]')?.textContent.includes('Sancho')`);
				await page.run(`window.__signouts = 0;
					const before = window.fetch;
					window.fetch = (input, init) => {
						if (String(input).includes('/signout')) window.__signouts++;
						return before(input, init);
					};`);
				const dialog = `document.querySelector('[role="alertdialog"]')`;
				const accounts = async () =>
					((await (await fetch(`${base}/api/capabilities`, { headers })).json()) as CapabilitiesView).connections
						.find((each) => each.name === "cal")
						?.accounts?.map((each) => each.account);
				await open("bob", "Sign out");
				await page.until(dialog);
				expect(await page.run(`${dialog}.querySelector('h2').textContent`)).toBe("Sign out of @bob?");
				expect(await page.run(`${dialog}.querySelector('p').textContent`)).toBe(
					"Sancho loses access to @bob. Its sign-in is forgotten, and the permissions, watches and waiting drafts that use it end. You can sign in again.",
				);
				const buttons = `[...${dialog}.querySelectorAll('button')].map(el => el.textContent.trim())`;
				expect(await page.run(buttons)).toEqual(["Stay connected", "Sign out"]);
				expect(await page.run(`window.__signouts`)).toBe(0);
				expect(await accounts()).toEqual(["ana", "bob"]);
				// Stay connected changes nothing
				await page.run(
					`[...${dialog}.querySelectorAll('button')].find(el => el.textContent.trim() === 'Stay connected').click()`,
				);
				await page.until(`!${dialog}`);
				expect(await page.run(`window.__signouts`)).toBe(0);
				expect(await accounts()).toEqual(["ana", "bob"]);
				expect(await page.run(`Boolean(document.querySelector('[data-account="bob"]'))`)).toBe(true);
				// Sign out, confirmed, signs that account out and no other
				await open("bob", "Sign out");
				await page.until(dialog);
				await page.run(
					`[...${dialog}.querySelectorAll('button')].find(el => el.textContent.trim() === 'Sign out').click()`,
				);
				await page.until(`!document.querySelector('[data-account="bob"]')`);
				expect(await page.run(`window.__signouts`)).toBe(1);
				expect(await accounts()).toEqual(["ana"]);
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
