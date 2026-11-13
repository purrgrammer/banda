/**
 * Custom providers through the app, as a person uses them, against a throwaway daemon and a scripted OpenAI-compatible
 * server on loopback (`./fixtures/compat-server.ts`; no model runs, no live provider, nothing written outside the
 * temporary home): the form refuses what it should, saying why; a keyless provider is added with two models and a
 * tier each, and saving it sends nothing; a check is asked first, naming where it goes, and is the one request it
 * makes; the band thinks with it and answers a chat; a keyed one keeps its key out of sight; an edit is cancelled; a
 * removal is refused while the band thinks with it and goes once it moved; a failing check says why; after a restart
 * it is all still there. At phone and desktop width, light and dark. `BANDA_CUSTOM_PROVIDER_SHOTS=<dir>` saves a
 * screenshot at each step.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
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
const KEY = "sk-team-gateway-0123456789";
const SPOKEN = "Hello from the scripted local model.";

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
/** The control a visible label names, within `within` (a model's fieldset, say). */
const field = (label: string, within = "document") =>
	`document.getElementById([...${within}.querySelectorAll('label')].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(label)})?.htmlFor)`;
const model = (n: number) => `${dialog}.querySelector('fieldset[aria-label="Model ${n}"]')`;
const row = (id: string) => `document.querySelector('[data-custom-provider="${id}"]')`;

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

/** Type `value` into a text field as the owner would, replacing what it held. */
async function fill(page: Page, expression: string, value: string) {
	await page.until(expression);
	await page.run(
		`(() => {const el=${expression}; el.scrollIntoView({block:'center'}); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
	);
	if (value !== "") await page.input("Input.insertText", { text: value });
	await page.until(`(${expression}).value === ${JSON.stringify(value)}`);
}

/** Pick `option` (its text) in a select. */
async function choose(page: Page, expression: string, option: string) {
	await page.until(expression);
	await page.run(
		`(() => {const el=${expression}; const o=[...el.options].find(o => o.textContent.trim() === ${JSON.stringify(option)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,o.value); el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
	);
	await page.until(`(${expression}).selectedOptions[0]?.textContent.trim() === ${JSON.stringify(option)}`);
}

async function daemonOn(home: string, port = 0) {
	const models = createModels({ credentials: new FileCredentialStore(home) });
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
		`the owner adds, checks, uses, edits and removes a custom provider, at ${width}`,
		async () => {
			const home = await tempHome();
			if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const local = await compatServer({ speak: SPOKEN });
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
							await page.until(shows("Your own providers"));
						};

						await page.until(shows("Sancho"));
						await settings();
						await page.until(shows("None yet"));
						await shot("1-model-tab");

						// what the form refuses, said by the field, before anything is sent
						await click(page, named("Add a provider"));
						await page.until(dialog);
						await fill(page, field("Address"), "http://api.example.com/v1");
						await click(page, button("Save", dialog));
						await page.until(shows("Give it a name you will know it by"));
						expect(await page.run<boolean>(shows("Use https:// for api.example.com"))).toBe(true);
						expect(await page.run<boolean>(shows("Write the model's name as the server knows it"))).toBe(true);
						expect(await page.run<boolean>(shows("things to fix above"))).toBe(true);
						await shot("2-add-errors");
						await darkToo("2-add-errors");

						// a keyless provider on this computer, two models, a tier each
						await fill(page, field("Name"), "Local scripted");
						await fill(page, field("Address"), local.url);
						await page.until(shows(`Sends to 127.0.0.1:${local.port}: this computer, where banda runs.`));
						await fill(page, field("Model id", model(1)), "scripted-small");
						await fill(page, field("Name in banda", model(1)), "Scripted small");
						await click(page, button("Add a model", dialog));
						await fill(page, field("Model id", model(2)), "scripted-large");
						await fill(page, field("Context, tokens", model(2)), "65536");
						await click(page, `${model(2)}.querySelector('[aria-label="Model 2 thinks first"]')`);
						await choose(page, field("Deep", dialog), "scripted-large");
						expect(await page.run<string>(`${field("Quick", dialog)}.selectedOptions[0].textContent`)).toBe(
							"Scripted small",
						);
						await shot("3-add-filled");
						await darkToo("3-add-filled");
						await click(page, button("Save", dialog));
						await page.until(`!${dialog}`);
						await page.until(row("custom-local-scripted"));
						// saving is not a check: nothing reached it
						expect(local.requests).toHaveLength(0);
						await page.until(shows(`On this computer · 127.0.0.1:${local.port}`));
						expect(await page.run<boolean>(shows("No key · 2 models"))).toBe(true);
						await shot("4-listed");

						// a check, asked first with where it goes and what it may cost; the one request
						await click(page, named("Check Local scripted"));
						await page.until(alert);
						expect(await page.run<string>(`${alert}.innerText`)).toMatch(
							new RegExp(
								`one short message to 127\\.0\\.0\\.1:${local.port} \\(on this computer\\) with Scripted small[\\s\\S]*costs a few tokens`,
							),
						);
						await shot("5-check-ask");
						await darkToo("5-check-ask");
						await click(page, button("Send the check", alert));
						await page.until(shows("Answered in"));
						expect(await page.run<boolean>(shows("with Scripted small: “OK from scripted-small”"))).toBe(true);
						expect(local.requests).toHaveLength(1);
						await shot("6-checked");

						// the band thinks with it: the tiers are its models
						await click(page, named("Use Local scripted"));
						await page.until(`${row("custom-local-scripted")}.innerText.includes('In use')`);
						const tiers = await api<TiersView>("/tiers");
						expect(tiers.provider).toMatchObject({ id: "custom-local-scripted", name: "Local scripted", local: true });
						expect([tiers.models.quick.id, tiers.models.balanced.id, tiers.models.deep.id]).toEqual([
							"scripted-small",
							"scripted-small",
							"scripted-large",
						]);
						await page.until(
							`[...document.querySelectorAll('button')].some(el => el.getAttribute('aria-label')?.startsWith('Change Deep model: scripted-large'))`,
						);
						await shot("7-in-use");
						await darkToo("7-in-use");

						// and answers a chat on it
						await page.run(`location.hash='#/a/sancho'`);
						const composer = `document.querySelector('textarea[name="message"]')`;
						await page.until(composer);
						await page.run(`(${composer}).focus()`);
						await page.input("Input.insertText", { text: "Are you running on my own model?" });
						await click(page, `document.querySelector('button[aria-label="Send"]')`);
						await page.until(shows(SPOKEN), 30_000);
						expect(
							local.requests
								.filter((request) => request.path.endsWith("/chat/completions"))
								.slice(1)
								.every((request) => request.body?.model === "scripted-small"),
						).toBe(true);
						await shot("8-chat-answered");
						await darkToo("8-chat-answered");

						// a hosted one with a key: saved, never contacted, its key out of sight
						await settings();
						await click(page, named("Add a provider"));
						await fill(page, field("Name"), "Team gateway");
						await fill(page, field("Address"), "https://llm.example.com/v1");
						await page.until(shows("Sends everything the band says to llm.example.com, on the internet."));
						await click(page, named("It needs a key"));
						await fill(page, field("Its key"), KEY);
						await fill(page, field("Model id", model(1)), "fast-1");
						await fill(page, field("$ per 1M tokens in", model(1)), "0.2");
						await fill(page, field("$ per 1M tokens out", model(1)), "0.8");
						await click(page, button("Save", dialog));
						await page.until(row("custom-team-gateway"));
						await page.until(shows("On the internet · llm.example.com"));
						expect(await page.run<boolean>(shows("Key saved · 1 model"))).toBe(true);
						expect(await page.run<boolean>(`document.documentElement.outerHTML.includes(${JSON.stringify(KEY)})`)).toBe(
							false,
						);
						expect(await readFile(customProvidersPath(home), "utf8")).not.toContain(KEY);
						await shot("9-two-providers");
						await darkToo("9-two-providers");

						// an edit, cancelled: nothing changes
						await click(page, named("Edit Local scripted"));
						await page.until(`${dialog}?.innerText.includes('Edit Local scripted')`);
						await fill(page, field("Name"), "Renamed but not saved");
						await shot("10-editing");
						await click(page, button("Cancel", dialog));
						await page.until(`!${dialog}`);
						expect(await page.run<boolean>(shows("Renamed but not saved"))).toBe(false);
						expect((await api<CustomProvidersView>("/custom-providers")).providers[0]?.name).toBe("Local scripted");

						// a removal is refused while the band thinks with it, saying what to do
						await click(page, named("Edit Local scripted"));
						await click(page, button("Remove provider", dialog));
						await page.until(alert);
						await click(page, button("Remove", alert));
						await page.until(shows("The band thinks with it: use another provider first"));
						await shot("11-remove-refused");
						await darkToo("11-remove-refused");
						await click(page, button("Cancel", dialog));
						await page.until(`!${dialog}`);

						// a failing check says why, without the key
						local.set({ fail: { status: 500, message: "the model crashed while loading" } });
						await click(page, named("Check Local scripted"));
						await click(page, button("Send the check", alert));
						await page.until(shows("Didn't answer: 500"));
						await shot("12-check-failed");
						local.set({ fail: undefined });

						// once the band moved, it goes
						await click(page, named("Use Team gateway"));
						await page.until(`${row("custom-team-gateway")}.innerText.includes('In use')`);
						await click(page, named("Edit Local scripted"));
						await click(page, button("Remove provider", dialog));
						await click(page, button("Remove", alert));
						await page.until(`!${row("custom-local-scripted")}`);
						expect((await api<TiersView>("/tiers")).provider.id).toBe("custom-team-gateway");
						await shot("13-removed");

						// a restart: the daemon registers it before anything resumes, and the app shows it as it was
						const port = daemon?.port ?? 0;
						await daemon?.close();
						daemon = (await daemonOn(home, port)).daemon;
						await page.run("location.reload()");
						// a phone reopens on Settings itself, without the band beside it
						await page.until(`document.readyState === 'complete' && ${tab("Model")}`);
						await settings();
						await page.until(row("custom-team-gateway"));
						await page.until(`${row("custom-team-gateway")}.innerText.includes('In use')`);
						await shot("14-after-restart");
						await darkToo("14-after-restart");
					});
				} finally {
					await server.close();
				}
			} finally {
				await daemon?.close();
				await local.close();
			}
		},
		180_000,
	);
