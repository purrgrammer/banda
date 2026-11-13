/**
 * Custom providers on a paired phone: the real web app in Chrome at phone size, its requests going the way the Android
 * shell sends them. A stand-in for the shell's `Banda` plugin (`web/src/lib/transport.ts`) hands each request to this
 * test, which sends it over Iroh from a device the owner paired (`./fixtures/iroh-client.ts`), so the app runs as a
 * device: no owner token, `runsOnDevice` true. What it must say there: an address on localhost is the computer banda
 * runs on, never the phone, in the row, the form and the check's question; and the check runs on that computer. A
 * scripted OpenAI-compatible server stands in for the model server; nothing else is reached.
 * `BANDA_CUSTOM_PROVIDER_SHOTS=<dir>` saves screenshots.
 */

import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { expect, it } from "vitest";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { DevicesView, InviteView } from "../src/server/api.ts";
import { streamSocket } from "../src/server/remote.ts";
import { compatServer } from "./fixtures/compat-server.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { testDevice } from "./fixtures/iroh-client.ts";
import { skipShippedSkills, tempHome, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const SHOTS = process.env.BANDA_CUSTOM_PROVIDER_SHOTS;
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
const field = (label: string, within = "document") =>
	`document.getElementById([...${within}.querySelectorAll('label')].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(label)})?.htmlFor)`;
const modelRow = (id: string) => `${dialog}.querySelector('li[data-model=${JSON.stringify(id)}]')`;
const option = (text: string) =>
	`[...document.querySelectorAll('[role="option"]')].find(el => ${visible} && el.querySelector('span span')?.textContent.trim() === ${JSON.stringify(text)})`;
const labelled = (text: string, within = "document") =>
	`[...${within}.querySelectorAll('label')].find(el => ${visible} && el.textContent.includes(${JSON.stringify(text)}))`;
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
const row = (id: string) => `document.querySelector('[data-custom-provider="${id}"]')`;

async function click(page: Page, expression: string) {
	await page.until(expression);
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

async function fill(page: Page, expression: string, value: string) {
	await page.until(expression);
	await page.run(
		`(() => {const el=${expression}; el.scrollIntoView({block:'center'}); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
	);
	if (value !== "") await page.input("Input.insertText", { text: value });
	await page.until(`(${expression}).value === ${JSON.stringify(value)}`);
}

/** The shell's plugin, in the page: each call goes to `bridge`, which this test answers over Iroh. */
const plugin = (bridge: string, daemon: string, device: string) => `(() => {
	const bridge = ${JSON.stringify(bridge)};
	const listeners = { chunk: [], end: [], link: [] };
	const emit = (event, value) => listeners[event].forEach((listener) => listener(value));
	const aborts = new Map();
	const base64 = (bytes) => { let text = ""; for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000)); return btoa(text); };
	const Banda = {
		request: async (options) => (await fetch(bridge + "/request", { method: "POST", body: JSON.stringify(options) })).json(),
		stream: async (options) => {
			const control = new AbortController();
			aborts.set(options.id, control);
			const response = await fetch(bridge + "/stream", { method: "POST", body: JSON.stringify(options), signal: control.signal });
			const head = { status: Number(response.headers.get("x-status")), headers: JSON.parse(response.headers.get("x-headers")) };
			(async () => {
				const reader = response.body.getReader();
				try {
					for (;;) { const { done, value } = await reader.read(); if (done) break; emit("chunk", { id: options.id, data: base64(value) }); }
					emit("end", { id: options.id });
				} catch (error) { emit("end", { id: options.id, error: String(error) }); }
			})();
			return head;
		},
		cancel: async ({ id }) => { aborts.get(id)?.abort(); aborts.delete(id); },
		addListener: async (event, listener) => { listeners[event].push(listener); return { remove: async () => { listeners[event] = listeners[event].filter((each) => each !== listener); } }; },
		state: async () => ({ daemon: ${JSON.stringify(daemon)}, device: ${JSON.stringify(device)}, name: "Pixel 9" }),
		setDaemon: async () => {}, keepDaemon: async () => {}, revertDaemon: async () => {}, forget: async () => {},
	};
	window.Capacitor = { isNativePlatform: () => true, Plugins: { Banda } };
})();`;

it.skipIf(!hasChrome())(
	"on a paired phone, an address on localhost is the computer banda runs on, never the phone",
	async () => {
		const home = await tempHome();
		if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		// pi-ai's real providers, with no credential from this computer
		const models = builtinModels({
			credentials: new FileCredentialStore(home),
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(fauxProvider().provider);
		const daemon = await startDaemon({
			home,
			port: 0,
			models,
			box: hostBox(home),
			log: () => {},
			remote: { reach: "loopback" },
		});
		const local = await compatServer({ models: ["scripted-small"] });
		const phone = await testDevice();
		const base = `http://127.0.0.1:${daemon.port}`;
		const token = (await readDaemonFile(home))!.token!;
		const owner = async <T>(path: string, method = "GET", body?: object): Promise<T> => {
			const response = await fetch(`${base}/api${path}`, {
				method,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
			return response.json() as Promise<T>;
		};
		let bridge: http.Server | undefined;
		let server: Awaited<ReturnType<typeof webServer>> | undefined;
		try {
			await skipShippedSkills(daemon.port, token);
			// the owner pairs the phone, as Settings → Devices does
			const invite = await owner<InviteView>("/devices/invites", "POST");
			const connection = await phone.dial(invite.ticket);
			expect(await phone.request("POST", "/api/devices/pair", { invite: invite.secret, name: "Pixel 9" })).toEqual({
				status: 202,
				body: { state: "pending" },
			});
			await owner(`/devices/requests/${phone.id}/approve`, "POST", { name: "Pixel 9" });
			const daemonId = (await owner<DevicesView>("/devices")).endpoint!.id;

			// what the shell's plugin does, over Iroh from the paired device; every path it carried is kept
			const carried: string[] = [];
			const overIroh = (method: string, path: string, headers: Record<string, string>) =>
				http.request({
					method,
					path,
					createConnection: () => streamSocket(connection.openBi()),
					headers: { ...headers, host: "banda.iroh" },
				});
			const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "x-status, x-headers" };
			bridge = http.createServer((req, res) => {
				void (async () => {
					const chunks: Buffer[] = [];
					for await (const chunk of req) chunks.push(chunk as Buffer);
					const options = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
						method?: string;
						path: string;
						headers: Record<string, string>;
						body?: string;
					};
					carried.push(`${options.method ?? "GET"} ${options.path}`);
					const out = overIroh(options.method ?? "GET", options.path, options.headers);
					if (req.url === "/stream") {
						res.on("close", () => out.destroy());
						out.on("response", (answer) => {
							res.writeHead(200, {
								...cors,
								"x-status": String(answer.statusCode ?? 0),
								"x-headers": JSON.stringify(answer.headers),
							});
							res.flushHeaders();
							answer.pipe(res);
						});
						out.on("error", () => res.destroy());
						out.end();
						return;
					}
					out.on("response", (answer) => {
						const body: Buffer[] = [];
						answer.on("data", (chunk: Buffer) => body.push(chunk));
						answer.on("end", () => {
							res.writeHead(200, { ...cors, "content-type": "application/json" });
							res.end(
								JSON.stringify({
									status: answer.statusCode ?? 0,
									headers: Object.fromEntries(
										Object.entries(answer.headers).map(([key, value]) => [key, String(value)]),
									),
									body: Buffer.concat(body).toString("base64"),
								}),
							);
						});
					});
					out.on("error", (error) => {
						res.writeHead(502, cors);
						res.end(String(error));
					});
					out.end(options.body === undefined ? undefined : Buffer.from(options.body, "base64"));
				})();
			});
			await new Promise<void>((resolve) => bridge?.listen(0, "127.0.0.1", resolve));
			const bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
			// no proxy to the daemon: the page reaches it only through the plugin
			server = await webServer();
			const origin = server.origin;

			await withPage("about:blank", { width: 390, height: 900 }, async (page) => {
				let scheme = "light";
				const shot = async (name: string) => {
					expect(
						await page.run("document.documentElement.scrollWidth <= innerWidth"),
						`${name}: no sideways scroll`,
					).toBe(true);
					await page.until(
						"document.getAnimations().every(a => a.playState !== 'running' || !(a.effect?.getComputedTiming().endTime < 2000))",
					);
					expect(await page.run<string>(fits), `${name}: the dialog fits`).toBe("ok");
					if (SHOTS !== undefined) await page.shoot(join(SHOTS, `phone-${scheme}-${name}.png`));
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
				// the shell's plugin is there before the app's first line runs
				await page.input("Page.enable", {});
				await page.input("Page.addScriptToEvaluateOnNewDocument", { source: plugin(bridgeUrl, daemonId, phone.id) });
				await page.goto(`${origin}/#/settings`);
				await page.until(`window.Capacitor?.isNativePlatform?.() === true`);
				await page.until(
					`(location.hash.startsWith('#/settings') || (location.hash='#/settings', false)) && ${tab("Model")}`,
					30_000,
				);
				await click(page, tab("Model"));
				await page.until(named("Add a provider"));
				// it runs as the device: every request it made went over Iroh, and it holds no token
				expect(carried.some((path) => path === "GET /api/tiers")).toBe(true);
				expect(await page.run<string>("location.hash")).not.toContain("token=");

				await click(page, named("Add a provider"));
				// on a phone, a person taps the search field
				await click(page, named("Search providers and servers"));
				await page.until(`document.activeElement === ${named("Search providers and servers")}`);
				// a sign-in comes back to the computer banda runs on, not this phone
				await page.input("Input.insertText", { text: "Anthropic" });
				await click(page, option("Anthropic"));
				await page.until(shows("Signing in to Anthropic comes back to the computer banda runs on: do it there."));
				await shot("1-sign-in-elsewhere");
				await click(page, named("Back to every provider"));
				// on a phone, a person taps the search field
				await click(page, named("Search providers and servers"));
				await page.until(`document.activeElement === ${named("Search providers and servers")}`);
				await page.input("Input.insertText", { text: "OpenAI-compatible" });
				await click(page, option("OpenAI-compatible server"));
				await fill(page, field("Name", dialog), "Desk server");
				await fill(page, field("Address", dialog), `http://localhost:${local.port}/v1`);
				await page.until(shows(`Sends to localhost:${local.port}: the computer banda runs on, not this phone.`));
				await click(page, labelled("Requires an API key", dialog));
				await page.until(`!${field("Its key", dialog)}`);
				await click(page, button("Find models", dialog));
				await page.until(shows("It listed 1 model."));
				// the daemon asked, on its computer; the phone only asked the daemon
				expect(local.requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /v1/models"]);
				expect(carried).toContain("POST /api/custom-providers/list");
				await click(page, named("Start with scripted-small"));
				await fill(page, field("Context, tokens", modelRow("scripted-small")), "32768");
				await fill(page, field("Answer cap, tokens", modelRow("scripted-small")), "4096");
				await click(page, labelled("No per-token charges", dialog));
				await page.run(`(${field("Address", dialog)}).scrollIntoView({block:'center'})`);
				await shot("2-form");
				await darkToo("2-form");
				await click(page, button("Save", dialog));
				await page.until(shows("Desk server saved"));
				await click(page, button("Not now", dialog));
				await page.until(row("custom-desk-server"));
				const text = await page.run<string>(`${row("custom-desk-server")}.innerText`);
				expect(text).toContain("On the computer banda runs on, not this phone");
				expect(text).toContain(`http://localhost:${local.port}/v1`);
				await page.run(`(${row("custom-desk-server")}).scrollIntoView({block:'center'})`);
				await shot("3-listed");
				await darkToo("3-listed");

				await click(page, named("Check Desk server"));
				await page.until(alert);
				expect(await page.run<string>(`${alert}.innerText`)).toContain(
					`one short message to localhost:${local.port} (on the computer banda runs on, not this phone)`,
				);
				await shot("4-check-ask");
				await darkToo("4-check-ask");
				await click(page, button("Send the check", alert));
				await page.until(shows("Answered in"));
				expect(local.requests.filter((request) => request.path.endsWith("/chat/completions"))).toHaveLength(1);
				expect(carried).toContain("POST /api/custom-providers/custom-desk-server/check");
				expect(page.errors()).toEqual([]);
			});
		} finally {
			await server?.close();
			await new Promise<void>((resolve) => (bridge === undefined ? resolve() : bridge.close(() => resolve())));
			bridge?.closeAllConnections();
			await phone.close();
			await daemon.close();
			await local.close();
		}
	},
	120_000,
);
