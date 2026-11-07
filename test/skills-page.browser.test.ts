/**
 * The Skills page against a throwaway daemon, as the owner would use it: what waits for review first, the list flat
 * and filterable, shipped skills added any time, the form refusing bad and taken names in words, acceptance clearing
 * the menu's dot; with an axe pass over the page and a detail. Both widths.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { freePort, tempHome, viteCacheDir } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const button = (label: string) =>
	`[...document.querySelectorAll('button')].find(el => el.getClientRects().length && el.textContent.trim() === ${JSON.stringify(label)})`;
type ClickTarget = { button: string; within?: string } | { selector: string };
async function click(page: Page, target: ClickTarget) {
	const expression =
		"button" in target
			? `[...document.querySelectorAll(${JSON.stringify(target.within ?? "button")})].find(el => el.getClientRects().length && el.textContent.trim() === ${JSON.stringify(target.button)})`
			: `document.querySelector(${JSON.stringify(target.selector)})`;
	try {
		await page.until(expression);
	} catch (error) {
		throw new Error(
			`${String(error)}; at ${await page.run("location.hash")}; page: ${String(await page.run("document.body.innerText")).slice(0, 1100)}`,
		);
	}
	await page.run(
		`(() => { const el = ${expression}; el.scrollIntoView({block:'nearest'}); el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); el.click(); })()`,
	);
}
async function fill(page: Page, selector: string, value: string) {
	const expression = `document.querySelector(${JSON.stringify(selector)})`;
	await page.until(expression);
	await page.run(
		`(() => { const el = ${expression}; el.focus(); el.select(); const type = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement; Object.getOwnPropertyDescriptor(type.prototype,'value').set.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); })()`,
	);
	if (value !== "") await page.input("Input.insertText", { text: value });
}

const file = (name: string, description: string, body: string, ownerOnly = false) =>
	`---\nname: ${name}\ndescription: ${description}\n${ownerOnly ? "disable-model-invocation: true\n" : ""}---\n\n${body}`;

/** Serious and critical axe findings, colour contrast aside (npm run web:contrast audits the palette itself). */
async function axeFindings(page: Page): Promise<string[]> {
	await page.run(await readFile(fileURLToPath(import.meta.resolve("axe-core/axe.min.js")), "utf8"));
	return await page.run<string[]>(
		`axe.run(document, { rules: { 'color-contrast': { enabled: false } } }).then((report) =>
			report.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(', ')))`,
	);
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(`the Skills page, end to end, at ${width}px`, async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const models = createModels();
		models.setProvider(fauxProvider().provider);
		const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), log: () => {} });
		const base = `http://127.0.0.1:${daemon.port}`;
		const token = (await readDaemonFile(home))!.token!;
		const api = async (path: string, init: RequestInit = {}) => {
			const response = await fetch(`${base}/api${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			});
			if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
			return response.json();
		};
		const server = await createServer({
			configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
			cacheDir: await viteCacheDir(),
			server: {
				host: "127.0.0.1",
				port: await freePort(),
				strictPort: true,
				open: false,
				proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } },
			},
		});
		try {
			await server.listen();
			const address = server.httpServer!.address();
			if (!address || typeof address === "string") throw new Error("No app port");
			await withPage(`http://127.0.0.1:${address.port}/#token=${token}`, { width, height: 900 }, async (page) => {
				// first run: take the six defaults (catch-me-up among them is owner-only)
				await page.until(`document.body.textContent.includes('Skills to start with')`);
				await click(page, { button: "Add 6 skills" });
				await page.until(`!document.body.textContent.includes('Skills to start with')`);
				// more accepted skills, as the owner would save them
				for (const name of ["pdf", "xlsx", "deploy-staging", "invoices"])
					await api(`/skills/${name}`, {
						method: "PUT",
						body: JSON.stringify({ text: file(name, `Work with ${name} files`, "Read it first."), base: null }),
					});
				// the box changes one accepted skill and drafts two new ones
				await writeFile(
					join(home, "workspace/skills/pdf/SKILL.md"),
					file("pdf", "Work with pdf files", "Flatten the form after filling it."),
				);
				for (const name of ["meeting-notes", "charts"]) {
					await mkdir(join(home, "workspace/skills", name), { recursive: true });
					await writeFile(
						join(home, "workspace/skills", name, "SKILL.md"),
						file(name, `Help with ${name}`, "Keep it short."),
					);
				}
				await page.run(`location.hash='#/skills'`);
				await page.run(`dispatchEvent(new Event('banda.skills-changed'))`);
				// the page opens on the list, nothing collapsed, with the waiting block above it
				await page.until(`document.body.textContent.includes('3 skills are waiting for your review')`);
				await page.until(`document.querySelector('[data-skill-list] a[href="#/skills/pdf"]')`);
				expect(
					await page.run(
						`(() => { const waiting = document.querySelector('section[aria-label="Skills waiting for review"]'); const list = document.querySelector('[data-skill-list]'); return (waiting.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; })()`,
					),
				).toBe(true);
				// quiet markers: owner-only and a change that waits
				expect(
					await page.run(
						`[...document.querySelectorAll('[data-skill-list] a')].find((a) => a.textContent.includes('/catch-me-up'))?.textContent.includes('Only you')`,
					),
				).toBe(true);
				expect(
					await page.run(
						`document.querySelector('[data-skill-list] a[href="#/skills/pdf"]')?.textContent.includes('Changed')`,
					),
				).toBe(true);
				// nine accepted skills: the filter appears, matches case aside, and says when nothing does
				await fill(page, 'input[aria-label="Filter skills"]', "PDF");
				await page.until(`document.querySelectorAll('[data-skill-list] a').length === 1`);
				await fill(page, 'input[aria-label="Filter skills"]', "zzz");
				await page.until(`document.body.textContent.includes('No skill matches \u201czzz\u201d.')`);
				await fill(page, 'input[aria-label="Filter skills"]', "");
				await page.until(`document.querySelectorAll('[data-skill-list] a').length >= 9`);
				// the axe pass over the full page
				expect(await axeFindings(page)).toEqual([]);
				// From banda: the one left at first run joins with one tap, accepted, and the section empties away
				await click(page, { selector: 'button[aria-label="Add /diagram-design"]' });
				await page.until(`document.querySelector('[data-skill-list] a[href="#/skills/diagram-design"]')`);
				await page.until(`!document.querySelector('section[aria-label="Skills from banda"]')`);
				// the changed skill's detail: the agent's version, accepted by the bytes shown
				await click(page, { selector: '[data-skill-list] a[href="#/skills/pdf"]' });
				await page.until(`document.body.textContent.includes('An agent changed this skill')`);
				expect(await page.run(`document.body.textContent.includes("Proposed version · agents don't use it yet")`)).toBe(
					true,
				);
				expect(await axeFindings(page)).toEqual([]);
				await click(page, { button: "Accept this version" });
				await page.until(`document.querySelector('[data-skill-detail]')?.textContent.includes('Flatten the form')`);
				await page.run(`location.hash='#/skills'`);
				// a new draft's detail says an agent wrote it
				await page.until(`document.body.textContent.includes('2 skills are waiting for your review')`);
				await click(page, {
					button: "/meeting-notes",
					within: 'section[aria-label="Skills waiting for review"] button',
				});
				await page.until(`document.body.textContent.includes('An agent wrote this skill')`);
				expect(await page.run(`document.body.textContent.includes("New skill · agents don't use it yet")`)).toBe(true);
				await page.run(`location.hash='#/skills'`);
				// Accept all takes the rest; nothing waits, and the menu's dot goes
				await click(page, { button: "Accept all 2 skills" });
				await page.until(`!document.querySelector('section[aria-label="Skills waiting for review"]')`);
				await page.until(`document.querySelector('[data-skill-list] a[href="#/skills/meeting-notes"]')`);
				if (width === 1440) {
					await page.until(`document.querySelector('button[aria-label="Menu"]')`);
					expect(await page.run(`!!document.querySelector('button[aria-label="Menu, something waits on you"]')`)).toBe(
						false,
					);
				}
				// the form refuses a bad name and a taken name in words, and saves a good one at once
				await click(page, { button: "Create a skill" });
				await fill(page, 'input[aria-label="Skill name"]', "My Skill");
				await page.until(`document.querySelector('input[aria-label="Skill name"]')?.value === 'my skill'`);
				await page.until(`${button("Save and use")}?.disabled === true`);
				expect(
					await page.run(`document.body.textContent.includes('Names use lowercase letters, digits and hyphens.')`),
				).toBe(true);
				await fill(page, 'input[aria-label="Skill name"]', "pdf");
				await page.until(`document.body.textContent.includes('A skill called /pdf already exists.')`);
				expect(await page.run(`${button("Save and use")}?.disabled`)).toBe(true);
				await fill(page, 'input[aria-label="Skill name"]', "release-notes");
				await page.until(`${button("Save and use")}?.disabled === false`);
				await click(page, { button: "Save and use" });
				await page.until(`location.hash === '#/skills/release-notes'`);
				await page.until(`document.querySelector('[data-skill-detail]')?.textContent.includes('/release-notes')`);
			});
		} finally {
			await server.close();
			await daemon.close();
		}
	});
