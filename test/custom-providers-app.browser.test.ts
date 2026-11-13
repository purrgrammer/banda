/**
 * Adding providers through the app, as a person does, against a throwaway daemon that has pi-ai's real built-in
 * catalog (every provider, no credential from this computer) and a scripted OpenAI-compatible server on loopback
 * answering as Ollama documents (`./fixtures/compat-server.ts`). No live provider is reached: the cloud's sign-in is
 * pi-ai's own login, which stores what it is given and calls nothing; a catalog is pi-ai's, read locally; and only the
 * scripted server is ever asked anything.
 *
 * Add a provider lists every one, searchable and by keyboard; a cloud is signed in by its own form and started on a
 * model of its catalog, then not used; a server's models are found on asking, kept apart from the one it starts on,
 * and only what that one lacks is asked; saving sends nothing and uses nothing, Use does; the band answers a chat on
 * it; a check that fails says why in words; a removal is refused while the band thinks with it; and after a restart it
 * is all still there. At phone and desktop width, light and dark. `BANDA_CUSTOM_PROVIDER_SHOTS=<dir>` saves a
 * screenshot at each step.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { expect, it } from "vitest";
import { customProvidersPath } from "../src/core/custom-provider.ts";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { CustomProvidersView, TiersView } from "../src/server/api.ts";
import { compatServer } from "./fixtures/compat-server.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const SHOTS = process.env.BANDA_CUSTOM_PROVIDER_SHOTS;
const SPOKEN = "Hello from the scripted local model.";
const CLOUDFLARE_TOKEN = "cf-token-for-the-test-0000";

const visible = "el.getClientRects().length > 0";
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const named = (label: string) =>
	`[...document.querySelectorAll('[aria-label]')].find(el => ${visible} && el.getAttribute('aria-label') === ${JSON.stringify(label)})`;
const button = (text: string, within = "document") =>
	`[...${within}.querySelectorAll('button')].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(text)})`;
const dialog = `document.querySelector('[role="dialog"]')`;
const alert = `document.querySelector('[role="alertdialog"]')`;
const tab = (text: string) =>
	`[...document.querySelectorAll('[role="tab"]')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const option = (text: string) =>
	`[...document.querySelectorAll('[role="option"]')].find(el => ${visible} && el.querySelector('span span')?.textContent.trim() === ${JSON.stringify(text)})`;
/** The control a visible label names, within `within`. */
const field = (label: string, within = "document") =>
	`document.getElementById([...${within}.querySelectorAll('label')].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(label)})?.htmlFor)`;
const model = (id: string) => `${dialog}.querySelector('li[data-model=${JSON.stringify(id)}]')`;
const labelled = (text: string, within = "document") =>
	`[...${within}.querySelectorAll('label')].find(el => ${visible} && el.textContent.includes(${JSON.stringify(text)}))`;
const row = (id: string) => `document.querySelector('[data-custom-provider="${id}"]')`;
const keepRow = (id: string) => `${dialog}.querySelector('li[data-keep=${JSON.stringify(id)}]')`;
/**
 * The open dialog fits the screen: it runs past neither side, does not scroll sideways, nothing in it sticks out of it,
 * and no text in it is clipped (a field's own value aside). "ok", or what does not fit; "ok" with no dialog open.
 */
const fits = `(() => {
	const d = document.querySelector('[role="dialog"]');
	if (!d) return 'ok';
	const box = d.getBoundingClientRect();
	if (box.left < -1 || box.right > innerWidth + 1) return 'the dialog runs off the screen: ' + Math.round(box.left) + '..' + Math.round(box.right);
	if (d.scrollWidth > d.clientWidth + 1) return 'the dialog scrolls sideways: ' + d.scrollWidth + ' > ' + d.clientWidth;
	for (const el of d.querySelectorAll('*')) {
		if (['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(el.tagName)) continue;
		const r = el.getBoundingClientRect();
		if (r.width < 2 || r.height < 2) continue;
		const what = el.tagName + ' ' + (el.textContent ?? '').trim().slice(0, 40);
		if (r.left < box.left - 1 || r.right > box.right + 1) return 'sticks out of the dialog: ' + what;
		if (getComputedStyle(el).overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) return 'clipped sideways: ' + what;
	}
	return 'ok';
})()`;

/** A click as a person makes one: on the control's centre, which must be the control and not something over it. */
async function click(page: Page, expression: string) {
	await page.until(expression).catch(async (error: Error) => {
		throw new Error(`${error.message}\n${await page.run<string>(`document.body.innerText.slice(0, 2000)`)}`);
	});
	await page.run(`(${expression}).scrollIntoView({block:'center'})`);
	await page.until(
		`(() => {const el=${expression}; const moving=el.closest('[role="dialog"],[role="alertdialog"]'); return !moving || moving.getAnimations({subtree:true}).every(a => a.playState !== 'running');})()`,
	);
	const point = await page.run<{ x: number; y: number }>(
		`(() => {const el=${expression}; const r=el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if(!el.contains(document.elementFromPoint(x,y))) throw new Error('Control is not hit-testable: '+el.outerHTML.slice(0,160)); return {x,y};})()`,
	);
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

/** A key pressed and let go, as the keyboard sends it. */
async function press(page: Page, key: "Enter" | "Tab" | "Escape" | "ArrowDown") {
	const code = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40 }[key];
	await page.input("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: code });
	if (key === "Enter") await page.input("Input.dispatchKeyEvent", { type: "char", key, code: key, text: "\r" });
	await page.input("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
}

/** Type `value` into a text field as the owner would, replacing what it held. */
async function fill(page: Page, expression: string, value: string) {
	await page.until(expression);
	await page.run(
		`(() => {const el=${expression}; el.scrollIntoView({block:'center'}); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
	);
	if (value !== "") await page.input("Input.insertText", { text: value });
	await page.until(`(${expression}).value === ${JSON.stringify(value)}`);
}

const nowhere = { env: async () => undefined, fileExists: async () => false };

async function daemonOn(home: string, port = 0) {
	const models = builtinModels({ credentials: new FileCredentialStore(home), authContext: nowhere });
	models.setProvider(fauxProvider().provider);
	const daemon = await startDaemon({ home, port, models, box: hostBox(home), log: () => {} });
	const base = `http://127.0.0.1:${daemon.port}`;
	const token = (await readDaemonFile(home))!.token!;
	const api = async <T>(path: string, method = "GET", body?: object): Promise<T> => {
		const response = await fetch(`${base}/api${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
		return response.json() as Promise<T>;
	};
	return { daemon, base, token, api };
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`the owner adds a cloud provider and a server of their own, uses one and removes it, at ${width}`,
		async () => {
			const home = await tempHome();
			if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const local = await compatServer({
				speak: SPOKEN,
				models: [
					{ id: "qwen3:8b", context: 40_960 },
					{ id: "llava:7b", context: 4096, vision: true },
					{ id: "Qwen/Qwen3-8B" },
					{ id: "nomic-embed-text", embedding: true },
				],
			});
			let daemon: Daemon | undefined;
			try {
				const started = await daemonOn(home);
				daemon = started.daemon;
				const { base, token, api } = started;
				await skipShippedSkills(daemon.port, token);
				const server = await webServer({
					server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
				});
				try {
					await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
						let scheme = "light";
						const shot = async (name: string) => {
							expect(
								await page.run("document.documentElement.scrollWidth <= innerWidth"),
								`${name}: no sideways scroll`,
							).toBe(true);
							expect(page.errors(), `${name}: no page errors`).toEqual([]);
							expect(await page.run<string>(fits), `${name}: the dialog fits`).toBe("ok");
							await page.until(
								"document.getAnimations().every(a => a.playState !== 'running' || !(a.effect?.getComputedTiming().endTime < 2000))",
							);
							if (SHOTS !== undefined) await page.shoot(join(SHOTS, `${width}-${scheme}-${name}.png`));
						};
						const darkToo = async (name: string) => {
							scheme = "dark";
							await page.input("Emulation.setEmulatedMedia", {
								features: [{ name: "prefers-color-scheme", value: "dark" }],
							});
							await shot(name);
							scheme = "light";
							await page.input("Emulation.setEmulatedMedia", {
								features: [{ name: "prefers-color-scheme", value: "light" }],
							});
						};
						const settings = async () => {
							await page.until(
								`(location.hash.startsWith('#/settings') || (location.hash='#/settings', false)) && ${tab("Model")}`,
							);
							await click(page, tab("Model"));
							await page.until(named("Add a provider"));
						};

						await page.until(shows("Sancho"));
						await settings();
						await shot("1-model-tab");

						// by keyboard: Enter opens every provider with the search focused; Escape closes back on the button
						await page.run(`(${named("Add a provider")}).focus()`);
						await press(page, "Enter");
						await page.until(`${dialog} && document.activeElement === ${named("Search providers and servers")}`);
						const listed = await page.run<number>(`document.querySelectorAll('[role="option"]').length`);
						// every provider pi-ai has with chat models but the legacy Codex, then one way to a server of your own
						expect(listed).toBeGreaterThan(40);
						// providers first: the dialog opens on pi-ai's, not on the kinds of server
						expect(await page.run<string>(`document.querySelector('[role="option"] span span').textContent`)).toBe(
							"Anthropic",
						);
						expect(await page.run<boolean>(`!!${option("Ollama")}`)).toBe(false);
						expect(await page.run<boolean>(`!!${option("A server of your own")}`)).toBe(true);
						await shot("2-every-provider");
						await darkToo("2-every-provider");
						// the longest name reads whole, wrapped rather than cut
						await page.input("Input.insertText", { text: "Qwen Token Plan Individual" });
						await page.until(option("Qwen Token Plan Individual"));
						expect(await page.run<string>(fits)).toBe("ok");
						await page.run(
							`(() => {const el=${named("Search providers and servers")}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
						);
						await page.input("Input.insertText", { text: "cloudflare" });
						await page.until(`document.querySelectorAll('[role="option"]').length === 2`);
						await press(page, "Escape");
						await page.until(`!${dialog} && document.activeElement === ${named("Add a provider")}`);

						// a cloud, by its own form: pi-ai's own login stores it, and nothing is called
						await click(page, named("Add a provider"));
						await page.until(`document.activeElement === ${named("Search providers and servers")}`);
						await page.input("Input.insertText", { text: "AI Gateway" });
						await click(page, option("Cloudflare AI Gateway"));
						await page.until(shows("banda needs an API token, the account's id and the gateway's"));
						await fill(page, field("Cloudflare API token", dialog), CLOUDFLARE_TOKEN);
						await fill(page, field("Account ID", dialog), "0123456789abcdef0123456789abcdef");
						await click(page, button("Connect", dialog));
						// said under the field, before anything is sent
						await page.until(
							`${field("Gateway ID", dialog)}?.parentElement.querySelector('[role="alert"]')?.textContent === 'Gateway ID is needed'`,
						);
						expect(await new FileCredentialStore(home).list()).toEqual([]);
						await shot("3-cloud-form-missing");
						await fill(page, field("Gateway ID", dialog), "band-gateway");
						// filled, it is no longer said
						await page.until(`!${shows("Gateway ID is needed")}`);
						await shot("3-cloud-form");
						await darkToo("3-cloud-form");
						await click(page, button("Connect", dialog));
						await page.until(shows("From pi-ai's catalog. Your account may not reach every model"));
						// saved, never "connected": nothing has used it
						expect(await page.run<boolean>(shows("Saved. banda hasn't used it yet"))).toBe(true);
						expect(await new FileCredentialStore(home).read("cloudflare-ai-gateway")).toEqual({
							type: "api_key",
							key: CLOUDFLARE_TOKEN,
							env: { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_GATEWAY_ID: "band-gateway" },
						});
						// its models are the catalog's; it has no preset, so it starts on one picked here
						await click(page, button("Save", dialog));
						await page.until(shows("Pick the model it starts on."));
						const first = await page.run<string>(
							`${dialog}.querySelector('input[name="start"]').getAttribute('aria-label')`,
						);
						await click(page, `${dialog}.querySelector('input[name="start"]')`);
						await shot("4-catalog-start");
						await click(page, button("Save", dialog));
						await page.until(shows("Cloudflare AI Gateway saved"));
						expect(await page.run<boolean>(shows("Its credentials are saved; banda hasn't used them yet."))).toBe(true);
						expect(await page.run<boolean>(shows("is ready"))).toBe(false);
						await shot("5-saved-not-used");
						await darkToo("5-saved-not-used");
						// saved, started, not used
						const afterCloud = await api<TiersView>("/tiers");
						expect(afterCloud.provider.id).toBe("faux");
						expect(afterCloud.providers.map((each) => each.id)).toContain("cloudflare-ai-gateway");
						await click(page, button("Not now", dialog));
						await page.until(`!${dialog}`);
						expect(first).toMatch(/^Start with /);
						// Settings says the same: a saved key, not a connection anything has tried
						await page.until(shows("Key saved, not yet used"));
						expect(await page.run<boolean>(shows("Connected"))).toBe(false);

						// a server of the owner's: Ollama, its models found on asking
						await click(page, named("Add a provider"));
						await page.until(`document.activeElement === ${named("Search providers and servers")}`);
						await click(page, option("A server of your own"));
						await page.until(
							`${dialog}?.getAttribute('data-add-provider') === 'servers' || ${dialog}.querySelector('[data-add-provider="servers"]')`,
						);
						await shot("6-server-kinds");
						await click(page, option("Ollama"));
						await page.until(`${dialog} && document.activeElement === ${field("Name", dialog)}`);
						expect(await page.run<string>(`${field("Address", dialog)}.value`)).toBe("http://localhost:11434/v1");
						await fill(page, field("Address", dialog), local.url);
						await page.until(shows(`Find models asks 127.0.0.1:${local.port} which models it has. No model runs.`));
						await shot("6-server-form");
						expect(local.requests).toHaveLength(0);
						await click(page, button("Find models", dialog));
						await page.until(shows("It listed 4 models."));
						// the listing asked no model to answer
						expect(local.requests.every((request) => !request.path.endsWith("/chat/completions"))).toBe(true);
						expect(local.requests.map((request) => `${request.method} ${request.path}`)).toContain("GET /api/tags");
						// what each says, and what it cannot be
						expect(await page.run<string>(`${model("qwen3:8b")}.innerText`)).toContain("40,960 context");
						expect(await page.run<string>(`${model("qwen3:8b")}.innerText`)).toContain(
							"Listed by the server · limits from the server",
						);
						expect(await page.run<string>(`${model("llava:7b")}.innerText`)).toContain("reads images");
						// the next choice is the start model: focus is on it
						await page.until(`document.activeElement?.getAttribute('name') === 'start'`);
						// an embedding model is no start choice
						expect(await page.run<boolean>(`!!${model("nomic-embed-text")}`)).toBe(false);
						// keeping and starting are two choices: it starts on qwen3, and keeps llava once llava is complete
						await click(page, named("Start with qwen3:8b"));
						// the others wait under "Also keep other models"
						await click(
							page,
							`[...${dialog}.querySelectorAll('button')].find(el => el.textContent.startsWith('Also keep other models'))`,
						);
						await page.until(keepRow("nomic-embed-text"));
						expect(await page.run<string>(`${keepRow("nomic-embed-text")}.innerText`)).toContain("It doesn't chat");
						expect(await page.run<string>(`${keepRow("Qwen/Qwen3-8B")}.innerText`)).toContain(
							"not usable until you add them",
						);
						expect(
							await page.run<boolean>(`${keepRow("Qwen/Qwen3-8B")}.querySelector('[role="checkbox"]').disabled`),
						).toBe(true);
						// only what the start model lacks is asked, and only for it
						await page.until(`${field("Answer cap, tokens", model("qwen3:8b"))}`);
						expect(await page.run<boolean>(`!!${field("Context, tokens", model("qwen3:8b"))}`)).toBe(false);
						await click(page, button("Save", dialog));
						await page.until(shows("Say whether it charges per token."));
						await page.until(
							shows(
								"Write how many tokens banda may ask for in one answer (sent as max_tokens), within what the server allows",
							),
						);
						await shot("7-server-found");
						await darkToo("7-server-found");
						await fill(page, field("Answer cap, tokens", model("qwen3:8b")), "8192");
						expect(await page.run<boolean>(`${keepRow("llava:7b")}.querySelector('[role="checkbox"]').disabled`)).toBe(
							true,
						);
						await click(page, button("Complete it", keepRow("llava:7b")));
						await page.until(field("Answer cap, tokens", keepRow("llava:7b")));
						await fill(page, field("Answer cap, tokens", keepRow("llava:7b")), "2048");
						await click(page, `${keepRow("llava:7b")}.querySelector('[role="checkbox"]')`);
						await click(page, labelled("No per-token charges", dialog));
						await click(page, button("Save", dialog));
						await page.until(shows("Ollama saved"));
						await shot("8-server-saved");
						// saving sent nothing and used nothing
						expect(local.requests.every((request) => !request.path.endsWith("/chat/completions"))).toBe(true);
						expect((await api<TiersView>("/tiers")).provider.id).toBe("faux");
						const kept = (await api<CustomProvidersView>("/custom-providers")).providers[0];
						expect(kept).toMatchObject({
							id: "custom-ollama",
							kind: "ollama",
							billing: "none",
							tiers: { quick: "qwen3:8b", balanced: "qwen3:8b", deep: "qwen3:8b" },
							models: [
								{ id: "qwen3:8b", contextWindow: 40_960, maxTokens: 8192, source: { listed: true, limits: "owner" } },
								{ id: "llava:7b", contextWindow: 4096, maxTokens: 2048, images: true },
							],
						});
						expect(kept?.models[0]).not.toHaveProperty("cost");
						await click(page, button("Use Ollama", dialog));
						await page.until(`!${dialog}`);
						const tiers = await api<TiersView>("/tiers");
						expect(tiers.provider).toMatchObject({ id: "custom-ollama", name: "Ollama", local: true });
						expect([tiers.models.quick.id, tiers.models.balanced.id, tiers.models.deep.id]).toEqual([
							"qwen3:8b",
							"qwen3:8b",
							"qwen3:8b",
						]);
						await page.until(`${row("custom-ollama")}?.innerText.includes('In use')`);
						await shot("9-in-use");
						await darkToo("9-in-use");

						// it answers a chat
						await page.run(`location.hash='#/a/sancho'`);
						const composer = `document.querySelector('textarea[name="message"]')`;
						await page.until(composer);
						await page.run(`(${composer}).focus()`);
						await page.input("Input.insertText", { text: "Are you running on my own model?" });
						await click(page, `document.querySelector('button[aria-label="Send"]')`);
						await page.until(shows(SPOKEN), 30_000);
						const asked = local.requests.filter((request) => request.path.endsWith("/chat/completions"));
						expect(asked.length).toBeGreaterThan(0);
						expect(asked.every((request) => request.body?.model === "qwen3:8b")).toBe(true);
						await shot("10-chat-answered");

						// a check that fails says why, in words; its details on asking
						await settings();
						local.set({ fail: { status: 500, message: "the model crashed while loading" } });
						await click(page, named("Check Ollama"));
						await page.until(alert);
						expect(await page.run<string>(`${alert}.innerText`)).toContain("costs a few tokens");
						await click(page, button("Send the check", alert));
						await page.until(shows("It failed on its own side. Check the server and its logs, then try again."));
						expect(await page.run<boolean>(shows("HTTP 500"))).toBe(false);
						await shot("11-check-failed");
						await darkToo("11-check-failed");
						local.set({ fail: undefined });

						// a removal is refused while the band thinks with it
						await click(page, named("Edit Ollama"));
						await click(page, button("Remove server", dialog));
						await click(page, button("Remove", alert));
						await page.until(shows("The band thinks with it: use another provider first"));
						await shot("12-remove-refused");
						await click(page, button("Cancel", dialog));
						await page.until(`!${dialog}`);

						// a restart: registered before anything resumes, shown as it was
						const port = daemon?.port ?? 0;
						await daemon?.close();
						daemon = (await daemonOn(home, port)).daemon;
						await page.run("location.reload()");
						await page.until(`document.readyState === 'complete' && ${tab("Model")}`);
						await settings();
						await page.until(`${row("custom-ollama")}?.innerText.includes('In use')`);
						await shot("13-after-restart");
						await darkToo("13-after-restart");
						expect(await readFile(customProvidersPath(home), "utf8")).not.toContain(CLOUDFLARE_TOKEN);
					});
				} finally {
					await server.close();
				}
			} finally {
				await daemon?.close();
				await local.close();
			}
		},
		240_000,
	);
