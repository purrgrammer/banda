/**
 * The MCP specimen (`#/specimen/mcp`): the app's own setup over a fixture connection, with no daemon behind it. Every
 * phase and sign-in is reached as the owner would, nothing is sent to an API, and the page keeps its width.
 */
import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

let server: WebServer;
let url: string;
beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
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
	url = `${server.origin}/#/specimen/mcp`;
});
afterAll(async () => {
	await server?.close();
});

const button = (text: string) =>
	`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const tab = (text: string) =>
	`[...document.querySelectorAll('[role="tab"]')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const summary = (text: string) =>
	`[...document.querySelectorAll('summary')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const labelled = (text: string) =>
	`document.getElementById([...document.querySelectorAll('label')].find(el => el.textContent.trim() === ${JSON.stringify(text)})?.htmlFor)`;
const heading = () => `document.querySelector('[data-mcp-phase] h1')?.textContent`;
const alert = () => `document.querySelector('[data-mcp-phase] [role="alert"]')?.textContent`;
async function click(page: Page, selector: string) {
	await page.until(selector);
	await page.run(
		`(() => {const el=${selector}; el.scrollIntoView({block:'nearest'}); el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); el.click();})()`,
	);
}
async function fill(page: Page, label: string, value: string) {
	await page.until(labelled(label));
	await page.run(
		`(() => {const el=${labelled(label)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
	);
}
/** A person's click at the middle of `expression`, once nothing (a dialog closing) lies over it. */
async function press(page: Page, expression: string) {
	const at = `(() => {const el=${expression}; if (!el) return undefined; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); const x=r.x+r.width/2, y=r.y+r.height/2; return el.contains(document.elementFromPoint(x,y)) ? {x,y} : undefined;})()`;
	await page.until(at);
	const point = await page.run<{ x: number; y: number }>(at);
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
/** Choose `words` in the row menu "More for `label`", as a person opens it. */
async function menu(page: Page, label: string, words: string) {
	await page.input("Page.bringToFront", {});
	await press(page, `document.querySelector('[aria-label=${JSON.stringify(`More for ${label}`)}]')`);
	await press(
		page,
		`[...document.querySelectorAll('[role="menu"][data-state="open"] [role="menuitem"]')].find(el => el.textContent.trim() === ${JSON.stringify(words)})`,
	);
}
async function phase(page: Page, value: string) {
	await page.until(`document.querySelector('[data-mcp-phase="${value}"]')`);
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
					await phase(page, "setup");
					await click(page, tab(theme));
					expect(await page.run(`getComputedStyle(document.querySelector('[data-mcp-phase]')).colorScheme`)).toBe(
						theme.toLowerCase(),
					);
					await shot(page, `${width}-${theme}-server`);
					// an address with credentials is refused above the form, and the owner's details stay
					await fill(page, "Server address", "https://user:password@example.com/mcp");
					await click(page, button("Check server"));
					await page.until(alert());
					await phase(page, "setup");
					expect(await page.run(`${labelled("Server address")}.value`)).toBe("https://user:password@example.com/mcp");
					await fill(page, "Server address", "https://ernesto.example/mcp");
					await click(page, button("Check server"));
					await phase(page, "auth");
					expect(await page.run(alert())).toBeUndefined();
					await click(page, button("Continue to sign in"));
					await phase(page, "waiting");
					expect(await page.run(`document.body.textContent.includes('HJKL-4821')`)).toBe(true);
					await shot(page, `${width}-${theme}-waiting`);
					await click(page, button("Cancel sign-in"));
					await phase(page, "auth");
					expect(await page.run(heading())).toBe("Connect Ernesto");
					await click(page, button("Continue to sign in"));
					await phase(page, "waiting");
					// the service confirms: the daemon's view would move the setup on
					await click(page, tab("Review"));
					await phase(page, "review");
					expect(await page.run(`document.querySelectorAll('[role="switch"][aria-checked="true"]').length`)).toBe(0);
					expect(
						await page.run(
							`[...document.querySelector('[data-tool="fs_read"]').querySelectorAll('button')].find(el => el.textContent === 'Allow').getAttribute('aria-checked')`,
						),
					).toBe("false");
					await click(page, summary("Introduction from the server"));
					await shot(page, `${width}-${theme}-review`);
					await click(page, labelled("Sancho"));
					await click(page, button("Save access"));
					await phase(page, "done");
					expect(await page.run(`${labelled("Sancho")}.getAttribute('aria-checked')`)).toBe("true");
					expect(await page.run(`${labelled("Mara")}.getAttribute('aria-checked')`)).toBe("false");
					await shot(page, `${width}-${theme}-done`);
					// Sign out is in the account's row menu, and asked first, saying who loses access
					await menu(page, "ernesto.example", "Sign out");
					await page.until(`document.querySelector('[role="alertdialog"]')`);
					expect(await page.run(`document.querySelector('[role="alertdialog"] p').textContent`)).toMatch(
						/^Sancho loses access to ernesto\.example\./,
					);
					expect(await page.run(`getComputedStyle(document.querySelector('[role="alertdialog"]')).colorScheme`)).toBe(
						theme.toLowerCase(),
					);
					await click(page, button("Stay connected"));
					await page.until(`!document.querySelector('[role="alertdialog"]')`);
					await phase(page, "done");
					await menu(page, "ernesto.example", "Sign out");
					await click(
						page,
						`[...document.querySelectorAll('[role="alertdialog"] button')].find(el => el.textContent === 'Sign out')`,
					);
					await phase(page, "auth");
					expect(
						await page.run(
							`performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname.startsWith('/api/')).length`,
						),
					).toBe(0);
					await scenario(page, "No sign-in");
					await phase(page, "setup");
					expect(page.errors()).toEqual([]);
				});
			},
			60000,
		);
	}

it.skipIf(!hasChrome())(
	"MCP specimen: anonymous, bearer, the way back, and an expired sign-in",
	async () => {
		await withPage(url, { width: 390, height: 844 }, async (page) => {
			await phase(page, "setup");
			await scenario(page, "No sign-in");
			await fill(page, "Server address", "https://ernesto.example/mcp");
			await click(page, button("Check server"));
			await phase(page, "review");
			expect(await page.run(`document.body.textContent.includes('No sign-in needed.')`)).toBe(true);
			expect(await page.run(`Boolean(${button("Back to sign-in")})`)).toBe(false);
			await click(page, button("Save access"));
			await phase(page, "done");
			expect(await page.run(`document.querySelectorAll('[role="switch"][aria-checked="true"]').length`)).toBe(0);
			await scenario(page, "Bearer credential");
			await fill(page, "Server address", "https://ernesto.example/mcp");
			await click(page, button("Check server"));
			await phase(page, "auth");
			expect(await page.run(`${button("Connect")}.disabled`)).toBe(true);
			await fill(page, "Bearer credential", "pretend-value");
			await click(page, button("Connect"));
			await phase(page, "review");
			await click(page, button("Back to sign-in"));
			await phase(page, "auth");
			expect(await page.run(`${labelled("Bearer credential")}.value`)).toBe("");
			// from a connected server, adding an account can come back to the review it left
			await scenario(page, "Ernesto · OAuth");
			await click(page, tab("Review"));
			await phase(page, "review");
			await click(page, button("Add account"));
			await phase(page, "auth");
			expect(await page.run(`Boolean(${button("Use a connected account")})`)).toBe(false);
			await click(page, button("Back to review"));
			await phase(page, "review");
			await scenario(page, "Expired sign-in");
			await phase(page, "auth");
			expect(await page.run(heading())).toBe("Sign in to Ernesto again");
			expect(await page.run(alert())).toBe(
				"Your sign-in expired or wasn’t completed. No new access has been given. Sign in again to continue.",
			);
			await shot(page, "390-expired");
			expect(page.errors()).toEqual([]);
		});
	},
	60000,
);
