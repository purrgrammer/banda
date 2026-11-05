/**
 * Settings → Devices through the app against a throwaway daemon with its Iroh endpoint on loopback: the owner makes a
 * code, a device (the test's own Iroh endpoint) presents it, its request arrives live and the owner approves it under
 * another name; then renames it and revokes it, asked first, and the device is refused. No endpoint id, ticket or
 * relay shows until the owner opens Details.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { DevicesView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { testDevice } from "./fixtures/iroh-client.ts";
import { echoModels, skipShippedSkills, tempHome } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const labelled = (label: string) =>
	`document.querySelector(${JSON.stringify(`[aria-label=${JSON.stringify(label)}]`)})`;
const tab = (text: string) =>
	`[...document.querySelectorAll('[role="tab"]')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const button = (text: string, within = "document") =>
	`[...${within}.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
const dialog = `document.querySelector('[role="alertdialog"]')`;
const text = `document.body.innerText`;

async function click(page: Page, selector: string) {
	await page.until(selector).catch(async (error: Error) => {
		throw new Error(`${error.message}\n${await page.run<string>(`location.hash + ' | ' + ${text}.slice(0, 1500)`)}`);
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

for (const width of [390, 1280])
	it.skipIf(!hasChrome())(
		`Settings pairs a phone the owner approves, renames it and revokes it at ${width}px`,
		async () => {
			const home = await tempHome();
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const daemon = await startDaemon({
				home,
				port: 0,
				models: echoModels().models,
				log: () => {},
				box: hostBox(home),
				remote: { reach: "loopback" },
			});
			const base = `http://127.0.0.1:${daemon.port}`;
			const token = (await readDaemonFile(home))!.token!;
			await skipShippedSkills(daemon.port, token);
			const devices = async () =>
				(await (
					await fetch(`${base}/api/devices`, { headers: { authorization: `Bearer ${token}` } })
				).json()) as DevicesView;
			const phone = await testDevice();
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
					await page.until(
						`(location.hash.startsWith('#/settings') || (location.hash='#/settings', false)) && ${tab("Devices")}`,
					);
					await click(page, tab("Devices"));
					await page.until(`${text}.includes('No phone paired yet')`);

					await click(page, button("Pair a phone"));
					await page.until(labelled("Code to scan with banda on your phone"));
					expect(await page.run<string>(text)).toMatch(/Works for 10:00|Works for 9:5\d/);
					const endpoint = (await devices()).endpoint!.id;
					// the code the phone shows for this computer while it asks
					expect(await page.run<string>(text)).toContain(
						`This computer’s code: ${(endpoint.slice(0, 16).match(/.{4}/g) ?? []).join(" ")}`,
					);
					// consumer words only, until Details is opened
					const shown = await page.run<string>(text);
					for (const word of [endpoint, "ticket", "relay", "endpoint", "banda://"])
						expect(shown.toLowerCase()).not.toContain(word.toLowerCase());

					await click(page, button("Details"));
					await page.until(`${text}.includes('Pairing link')`);
					const pairing = await page.run<string>(
						`[...document.querySelectorAll('dt')].find(el => el.textContent === 'Pairing link').nextElementSibling.textContent`,
					);
					expect(await page.run<string>(text)).toContain(endpoint);
					const link = new URL(pairing);
					await phone.dial(link.searchParams.get("ticket")!);
					expect(
						await phone.request("POST", "/api/devices/pair", {
							invite: link.searchParams.get("invite"),
							name: "Pixel 9",
						}),
					).toEqual({ status: 202, body: { state: "pending" } });

					// the request arrives live, in place of the code
					await page.until(`${text}.includes('“Pixel 9” asks to pair')`);
					expect(await page.run(labelled("Code to scan with banda on your phone"))).toBeNull();
					// Approve waits until the owner says the phone in their hand shows the code its request came with
					const code = (id: string) => (id.slice(0, 16).match(/.{4}/g) ?? []).join(" ");
					expect(await page.run<string>(text)).toContain(code(phone.id));
					await fill(page, "Name it", "Ana's phone");
					expect(await page.run<boolean>(`${button("Approve")}.disabled`)).toBe(true);
					await click(page, `document.querySelector('button[role="checkbox"]')`);
					await page.until(`!${button("Approve")}.disabled`);
					await click(page, button("Approve"));
					await page.until(`${text}.includes("Ana's phone") && ${text}.includes('Connected now')`);
					expect((await devices()).devices).toEqual([
						expect.objectContaining({ id: phone.id, name: "Ana's phone", connected: true }),
					]);
					expect(await phone.request("GET", "/api/devices/pair")).toEqual({ status: 200, body: { state: "paired" } });

					await click(page, labelled("Rename Ana's phone"));
					await fill(page, "New name for Ana's phone", "Pixel 9 Pro");
					await click(page, button("Save"));
					await page.until(`${text}.includes('Pixel 9 Pro') && ${labelled("Revoke Pixel 9 Pro")}`);
					expect((await devices()).devices[0]?.name).toBe("Pixel 9 Pro");

					await click(page, labelled("Revoke Pixel 9 Pro"));
					await page.until(dialog);
					expect(await page.run<string>(`${dialog}.innerText`)).toContain("Revoke Pixel 9 Pro?");
					// kept: nothing changes
					await click(page, button("Keep Pixel 9 Pro", dialog));
					await page.until(`!${dialog}`);
					expect((await devices()).devices[0]?.revoked).toBeUndefined();
					await click(page, labelled("Revoke Pixel 9 Pro"));
					await page.until(dialog);
					await click(page, button("Revoke", dialog));
					await page.until(`${text}.includes('Revoked')`);
					expect((await devices()).devices[0]?.revoked).toEqual(expect.any(Number));
					await expect(phone.request("GET", "/api/status")).rejects.toThrow();
					await page.until(`${text}.includes('Another phone') && !${labelled("Revoke Pixel 9 Pro")}`);

					expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await phone.close();
				await server.close();
				await daemon.close();
			}
		},
		90000,
	);
