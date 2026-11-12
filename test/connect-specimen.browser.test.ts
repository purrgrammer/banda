import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

let server: WebServer;
let url: string;

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
		plugins: [
			{
				name: "connect-specimen:no-daemon",
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
	url = `${server.origin}/#/specimen?section=connect&only=1`;
});

afterAll(async () => {
	await server?.close();
});

const STEPS: readonly { readonly step: string; readonly words: readonly string[] }[] = [
	{ step: "permissions", words: ["Google Calendar access", "Read your calendars and events", "Sign in"] },
	{ step: "permissions", words: ["GitHub access", "Repositories, including private repositories", "Sign in"] },
	{ step: "starting", words: ["Sign in on GitHub", "Starting…"] },
	{ step: "code", words: ["Sign in on Google Calendar", "Open Google Calendar", "Waiting for Google Calendar…"] },
	{ step: "code", words: ["Enter this code on GitHub", "WDJB-MJHT", "Copy code", "Open GitHub"] },
	{ step: "failed", words: ["Google Calendar isn't connected", "SERVICE_DISABLED", "Try again"] },
	{ step: "known", words: ["GitHub is already signed in", "Use @bandarra", "Use @purrgrammer"] },
	{ step: "name", words: ["Name this Ernesto account", "keep ernesto.example 2", "Continue"] },
	{ step: "agents", words: ["Use Google Calendar with", "bandarra@example.com", "Sancho", "Mara", "Done"] },
	{ step: "share", words: ["Let Mara use GitHub as @bandarra?", "Allow", "Don't"] },
	{ step: "permissions", words: ["Google Calendar access", "as @bandarra"] },
	{ step: "permissions", words: ["Slack access", "Direct messages and search", "Send messages as you"] },
	{ step: "failed", words: ["Slack isn't connected", "port 7788", "Try again"] },
	{ step: "done", words: ["Slack connected"] },
];

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`Every step of connecting is a dialog that fits ${width}px`,
		async () => {
			await withPage(url, { width, height: 844 }, async (page) => {
				const directory = process.env.BANDA_CONNECT_SPECIMEN_SHOTS;
				const section = `document.getElementById('connect')`;
				await page.until(section);
				await page.run(`${section}.scrollIntoView({block:'start'})`);
				// the card where an agent asks says why and offers Connect; the sign-in itself is never in it
				expect(await page.run(`${section}.innerText.includes('Connect GitHub')`)).toBe(true);
				expect(await page.run(`${section}.innerText.includes('Waiting for')`)).toBe(false);
				expect(await page.run(`${section}.innerText.includes('Change permissions')`)).toBe(false);
				const buttons = `${section}.querySelectorAll('[data-connect-specimen]')`;
				for (const [index, { step, words }] of STEPS.entries())
					for (const scheme of ["light", "dark"]) {
						await page.run(
							`[...${buttons}].filter((b) => b.dataset.connectSpecimen === '${index}')[${scheme === "light" ? 0 : 1}].click()`,
						);
						const dialog = `document.querySelector('[role="dialog"][data-connect-step="${step}"]')`;
						await page.until(dialog);
						for (const each of words)
							expect(await page.run(`${dialog}.innerText.includes(${JSON.stringify(each)})`), each).toBe(true);
						expect(await page.run(`getComputedStyle(${dialog}).colorScheme`)).toBe(scheme);
						const fits = await page.run(`(() => {
							const box = ${dialog}.getBoundingClientRect();
							return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
								&& [${dialog}, ...${dialog}.querySelectorAll('*:not([data-slot="dialog-close"], [data-slot="dialog-close"] *, [data-slot="switch"])')].every((el) => el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).overflowX !== 'visible');
						})()`);
						expect(fits, `${step} ${index} ${scheme}`).toBe(true);
						if (step === "agents") {
							const mara = `${dialog}.querySelector('[aria-label^="Mara may use"]')`;
							expect(
								await page.run(
									`${dialog}.querySelector('[aria-label^="Sancho may use"]').getAttribute('aria-checked')`,
								),
							).toBe("true");
							expect(await page.run(`${mara}.getAttribute('aria-checked')`)).toBe("false");
							await page.run(`${mara}.click()`);
							await page.until(`${mara}.getAttribute('aria-checked') === 'true'`);
						}
						if (directory !== undefined && scheme === "dark") {
							await mkdir(directory, { recursive: true });
							await page.shoot(`${directory}/${width}-${index}-${step}.png`);
						}
						await page.run(`${dialog}.querySelector('[data-slot="dialog-close"]').click()`);
						await page.until(`document.querySelector('[role="dialog"][data-connect-step]') === null`);
					}
				expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
			});
		},
		120_000,
	);
