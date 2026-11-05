/** Settings' providers through the app against a throwaway daemon: connect a second with a key, use it, sign out. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { presetOf, TIERS } from "../src/core/tiers.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { TiersView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const ANTHROPIC = presetOf("anthropic")!;
const OPENAI = presetOf("openai")!;

const labelled = (label: string) => `document.querySelector('[aria-label=${JSON.stringify(label)}]')`;
const tab = (text: string) =>
	`[...document.querySelectorAll('[role="tab"]')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const button = (text: string) =>
	`[...document.querySelectorAll('[role="alertdialog"] button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
async function click(page: Page, selector: string) {
	await page.until(selector).catch(async (error: Error) => {
		throw new Error(
			`${error.message}\n${await page.run<string>(`location.hash + ' | ' + document.body.innerText.slice(0, 1500)`)}`,
		);
	});
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

/** A faux Anthropic, always signed in, and a faux OpenAI that takes a key. */
function models() {
	const registry = createModels();
	const faux = (provider: string, preset: NonNullable<ReturnType<typeof presetOf>>) =>
		fauxProvider({ provider, models: [...new Set(TIERS.map((tier) => preset.models[tier]))].map((id) => ({ id })) });
	// signed in here: its credential is the owner's (pi-ai's stored label), not one found around the daemon, which first
	// run would wait for the owner to pick
	registry.setProvider({
		...faux("anthropic", ANTHROPIC).provider,
		name: "Anthropic",
		auth: {
			apiKey: {
				name: "Test key",
				resolve: async () => ({ auth: { apiKey: "signed-in" }, source: "stored credential" }),
			},
		},
	} as never);
	const openai = faux("openai", OPENAI).provider;
	registry.setProvider({
		...openai,
		name: "OpenAI",
		auth: {
			apiKey: {
				name: "Test key",
				login: async ({ prompt }: { prompt: (ask: { type: "secret"; message: string }) => Promise<string> }) => ({
					type: "api_key" as const,
					key: await prompt({ type: "secret", message: "Key" }),
				}),
				resolve: async ({ credential }: { credential?: { key?: string } }) =>
					credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined,
			},
		},
	} as never);
	return registry;
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`Settings connects a second provider, switches to it and signs out of it at ${width}px`,
		async () => {
			const home = await tempHome();
			await writeFile(
				join(home, "config.json"),
				JSON.stringify({ model: { provider: "anthropic", modelId: ANTHROPIC.models.quick } }),
			);
			const daemon = await startDaemon({ home, port: 0, models: models(), box: hostBox(home), log: () => {} });
			const base = `http://127.0.0.1:${daemon.port}`;
			const token = (await readDaemonFile(home))!.token!;
			await skipShippedSkills(daemon.port, token);
			const tiers = async () =>
				(await (
					await fetch(`${base}/api/tiers`, { headers: { authorization: `Bearer ${token}` } })
				).json()) as TiersView;
			const server = await createServer({
				configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
				server: {
					host: "127.0.0.1",
					port: 0,
					open: false,
					proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } },
				},
			});
			try {
				await server.listen();
				const address = server.httpServer!.address();
				if (!address || typeof address === "string") throw new Error("No app port");
				await withPage(`http://127.0.0.1:${address.port}/#token=${token}`, { width, height: 900 }, async (page) => {
					await page.until(`document.body.textContent.includes('Sancho')`, 30000);
					// the app may route to the first agent's chat once it has loaded: ask for Settings until it shows
					await page.until(
						`(location.hash.startsWith('#/settings') || (location.hash='#/settings', false)) && ${tab("Model")}`,
					);
					await click(page, tab("Model"));
					await page.until(labelled("Connect OpenAI"));
					expect(await page.run(`document.body.textContent.includes('In use')`)).toBe(true);

					await click(page, labelled("Connect OpenAI"));
					await fill(page, "OpenAI key", "test-key");
					await click(page, `${labelled("OpenAI key")}.form.querySelector('button[type="submit"]')`);
					await page.until(`document.body.textContent.includes(${JSON.stringify(OPENAI.models.quick)})`);
					expect((await tiers()).provider.id).toBe("openai");

					await click(page, labelled("Use Anthropic"));
					await page.until(`document.body.textContent.includes(${JSON.stringify(ANTHROPIC.models.quick)})`);
					expect((await tiers()).provider.id).toBe("anthropic");

					await click(page, labelled("Sign out of OpenAI"));
					await page.until(`document.querySelector('[role="alertdialog"]')`);
					await click(page, button("Sign out"));
					await page.until(labelled("Connect OpenAI"));
					expect((await tiers()).providers.map((each) => each.id)).toEqual(["anthropic"]);
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
