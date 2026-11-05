import { mkdir } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

let server: ViteDevServer;
let listener: Server;
let url: string;
beforeAll(async () => {
	if (!hasChrome()) return;
	listener = createHttpServer((req, res) => server.middlewares(req, res));
	server = await createServer({
		configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
		server: { middlewareMode: true, hmr: { server: listener }, open: false },
		plugins: [
			{
				name: "mcp-specimen:no-daemon",
				configResolved(config) {
					delete config.server.proxy;
				},
				configureServer(server) {
					server.middlewares.use("/icon.svg", (_req, res) => {
						res.writeHead(204);
						res.end();
					});
				},
			},
		],
	});
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("No specimen port");
	url = `http://127.0.0.1:${address.port}/#/specimen/mcp`;
});
afterAll(async () => {
	await server?.close();
	if (listener)
		await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
});

const button = (text: string) =>
	`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const labelled = (text: string) =>
	`document.getElementById([...document.querySelectorAll('label')].find(el => el.textContent.trim() === ${JSON.stringify(text)})?.htmlFor)`;
async function click(page: Page, selector: string) {
	await page.until(selector);
	await page.run(
		`(() => {const el=${selector}; el.scrollIntoView({block:'nearest'}); el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); el.click();})()`,
	);
}
async function fill(page: Page, label: string, value: string) {
	await page.run(
		`(() => {const el=${labelled(label)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
	);
}
async function step(page: Page, value: string) {
	await page.until(`document.querySelector('[data-mcp-step="${value}"]')`);
	expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
}
async function scenario(page: Page, text: string) {
	await page.run(
		`(() => {const el=document.querySelector('[aria-label="Specimen scenario"]'); el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse',ctrlKey:false}));})()`,
	);
	const option = `[...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
	await page.until(option);
	expect(await page.run(`getComputedStyle(document.querySelector('[role="listbox"]')).colorScheme`)).toBe(
		await page.run(`getComputedStyle(document.querySelector('[aria-label="Specimen scenario"]')).colorScheme`),
	);
	await page.run(
		`(() => {const el=${option}; el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerType:'mouse'})); el.click();})()`,
	);
}
async function shot(page: Page, name: string) {
	const directory = process.env.BANDA_MCP_SPECIMEN_SHOTS;
	if (!directory) return;
	await mkdir(directory, { recursive: true });
	await page.shoot(`${directory}/${name}.png`);
}

for (const width of [390, 1440])
	for (const theme of ["Light", "Dark"]) {
		it.skipIf(!hasChrome())(
			`MCP specimen: OAuth, conservative access, cancellation and sign-out at ${width} ${theme}`,
			async () => {
				await withPage(url, { width, height: 900 }, async (page) => {
					await step(page, "catalogue");
					await click(page, `[...document.querySelectorAll('[role="tab"]')].find(el => el.textContent === '${theme}')`);
					expect(await page.run(`getComputedStyle(document.querySelector('[data-mcp-step]')).colorScheme`)).toBe(
						theme.toLowerCase(),
					);
					await click(page, button("Add MCP server"));
					await step(page, "server");
					await shot(page, `${width}-${theme}-server`);
					await fill(page, "Server address", "https://user:password@example.com/mcp");
					await click(page, button("Check server"));
					await page.until(`document.querySelector('[aria-invalid="true"]')`);
					await step(page, "server");
					await fill(page, "Server address", "https://ernesto.example/mcp");
					await click(page, button("Check server"));
					await step(page, "auth");
					await click(page, button("Continue to sign in"));
					await step(page, "waiting");
					await shot(page, `${width}-${theme}-waiting`);
					await click(page, button("Cancel sign-in"));
					await step(page, "auth");
					await click(page, button("Continue to sign in"));
					await click(page, button("Simulate expired sign-in"));
					await step(page, "auth");
					await page.until(`document.querySelector('[role="alert"]')`);
					await click(page, button("Continue to sign in"));
					await click(page, button("Simulate successful sign-in"));
					await step(page, "review");
					expect(await page.run(`document.querySelectorAll('[role="switch"][aria-checked="true"]').length`)).toBe(0);
					expect(await page.run(`${labelled("Allow file reads without approval")}.getAttribute('aria-checked')`)).toBe(
						"false",
					);
					await click(
						page,
						`[...document.querySelectorAll('summary')].find(el => el.textContent === 'Introduction from the server')`,
					);
					await click(page, `[...document.querySelectorAll('summary')].find(el => el.textContent === 'Tools · 3')`);
					await shot(page, `${width}-${theme}-review`);
					await click(page, labelled("Sancho"));
					await click(page, button("Add connection and give access"));
					await step(page, "done");
					expect(await page.run(`document.body.textContent.includes('Sancho can use this connection.')`)).toBe(true);
					expect(await page.run(`${labelled("Mara")}.getAttribute('aria-checked')`)).toBe("false");
					await shot(page, `${width}-${theme}-done`);
					await click(page, button("Sign out"));
					await page.until(`document.querySelector('[role="alertdialog"]')`);
					expect(await page.run(`getComputedStyle(document.querySelector('[role="alertdialog"]')).colorScheme`)).toBe(
						theme.toLowerCase(),
					);
					await click(page, button("Stay connected"));
					await step(page, "done");
					await click(page, button("Sign out"));
					await click(
						page,
						`[...document.querySelectorAll('[role="alertdialog"] button')].find(el => el.textContent === 'Sign out')`,
					);
					await step(page, "auth");
					expect(
						await page.run(
							`performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname.startsWith('/api/')).length`,
						),
					).toBe(0);
					await scenario(page, "No sign-in");
					await step(page, "catalogue");
					expect(page.errors()).toEqual([]);
				});
			},
			60000,
		);
	}

it.skipIf(!hasChrome())(
	"MCP specimen: anonymous, bearer, retry, and expired-sign-in branches",
	async () => {
		await withPage(url, { width: 390, height: 844 }, async (page) => {
			await step(page, "catalogue");
			await scenario(page, "No sign-in");
			await click(page, button("Add MCP server"));
			await click(page, button("Check server"));
			await step(page, "review");
			expect(await page.run(`document.body.textContent.includes('No account or credential will be created.')`)).toBe(
				true,
			);
			await click(page, button("Add connection"));
			await step(page, "done");
			expect(await page.run(`document.body.textContent.includes('No agents have access yet.')`)).toBe(true);
			await scenario(page, "Bearer credential");
			await click(page, button("Add MCP server"));
			await click(page, button("Check server"));
			await step(page, "auth");
			expect(await page.run(`${button("Continue")}.disabled`)).toBe(true);
			await fill(page, "Bearer credential", "pretend-value");
			await click(page, button("Continue"));
			await step(page, "review");
			await click(page, button("Server details"));
			await click(page, button("Check server"));
			await step(page, "auth");
			expect(await page.run(`${labelled("Bearer credential")}.value`)).toBe("");
			await scenario(page, "Server unavailable");
			await click(page, button("Add MCP server"));
			await click(page, button("Check server"));
			await step(page, "problem");
			await shot(page, "390-error");
			await click(page, button("Try again"));
			await step(page, "auth");
			await scenario(page, "Expired sign-in");
			await step(page, "auth");
			await page.until(`document.querySelector('[role="alert"]')`);
			expect(page.errors()).toEqual([]);
		});
	},
	60000,
);
