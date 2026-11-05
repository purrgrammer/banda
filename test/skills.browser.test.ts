/** A throwaway daemon, not the specimen: owner creation, acceptance, invocation, feed and Activity at both widths. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const button = (label: string) =>
	`[...document.querySelectorAll('button')].find(el => el.getClientRects().length && el.textContent.trim() === ${JSON.stringify(label)})`;
async function click(page: Page, selector: string) {
	try {
		await page.until(selector, 5_000);
	} catch (error) {
		throw new Error(
			`${String(error)}; at ${await page.run("location.hash")}; page: ${String(await page.run("document.body.innerText")).slice(0, 1100)}`,
		);
	}
	await page.run(
		`(() => { const el = ${selector}; el.scrollIntoView({block:'nearest'}); el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); el.click(); })()`,
	);
}
async function fill(page: Page, selector: string, value: string, type = "HTMLInputElement") {
	await page.until(selector);
	await page.run(
		`(() => { const el = ${selector}; Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`,
	);
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(`skill owner flow, Activity and pending box edits at ${width}px`, async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const faux = fauxProvider();
		faux.setResponses(
			Array.from(
				{ length: 12 },
				(_, n) =>
					(() =>
						n === 0
							? fauxAssistantMessage([fauxToolCall("message_user", { text: "Done" })], { stopReason: "toolUse" })
							: fauxAssistantMessage("Finished.")) as never,
			),
		);
		const models = createModels();
		models.setProvider(faux.provider);
		const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), log: () => {} });
		const base = `http://127.0.0.1:${daemon.port}`;
		const token = (await readDaemonFile(home))!.token!;
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
				// first run offers the skills banda ships, once: the owner turns one off and adds the rest
				await page.until(`document.body.textContent.includes('Skills to start with')`, 12_000);
				await click(page, `document.querySelector('#first-skill-unslop')`);
				await click(page, button("Add 4 skills"));
				await page.until(`!document.body.textContent.includes('Skills to start with')`, 12_000);
				await page.run(`location.hash='#/skills'`);
				await click(page, `[...document.querySelectorAll('button')].find(el => el.textContent.includes('4 shared'))`);
				await page.until(`document.body.textContent.includes('/catch-me-up')`);
				expect(await page.run(`document.body.textContent.includes('/unslop')`)).toBe(false);
				await page.run(`location.hash='#/a/sancho'`);
				await page.until(`document.querySelector('textarea[placeholder^="Message "]')`);
				await page.run(`location.hash='#/skills'`);
				await click(page, button("Create a skill"));
				await fill(page, `document.querySelector('input[aria-label="Skill name"]')`, "research");
				await fill(
					page,
					`document.querySelector('textarea[aria-label="SKILL.md"]')`,
					"---\nname: research\ndescription: Gather sources\n---\n\n# Research\nCite your sources.",
					"HTMLTextAreaElement",
				);
				await click(page, button("Save and use"));
				await page.until(`document.querySelector('[data-skill-detail]')?.textContent.includes('Cite your sources.')`);
				await page.run(`location.hash='#/a/sancho'`);
				await fill(
					page,
					`document.querySelector('textarea[placeholder^="Message "]')`,
					"Use /research please",
					"HTMLTextAreaElement",
				);
				await click(page, `document.querySelector('button[aria-label="Send"]')`);
				await page.until(`document.body.textContent.includes('Loaded /research')`, 30_000);
				expect(await page.run(`document.body.textContent.includes('Cite your sources.')`)).toBe(false);
				await click(
					page,
					`document.querySelector('[aria-label="View activity"]') || document.querySelector('[aria-label="View current activity"]')`,
				);
				await page.until(`document.querySelector('[role="dialog"]')`);
				const activity = String(await page.run(`document.querySelector('[role="dialog"]')?.innerText`));
				expect(activity).toContain("Activity");
				await click(page, `document.querySelector('[aria-label="Inspect Loaded /research"]')`);
				await page.until(`document.querySelector('[aria-label="Full transcript"]')`);
				const transcript = String(await page.run(`document.querySelector('[role="dialog"]')?.innerText`));
				expect(transcript).toContain("skill result");
				await click(
					page,
					`[...document.querySelectorAll('[data-raw-content] button')].find(el => el.textContent.trim().startsWith('skill result'))`,
				);
				await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Cite your sources.')`);
				await page.run(`location.hash='#/skills/research'`);
				await page.until(`document.querySelector('[data-skill-detail]')`);
				await writeFile(
					join(home, "workspace/skills/research/SKILL.md"),
					"---\nname: research\ndescription: Gather sources\n---\n\n# Research\nCheck every source.",
				);
				await page.run(`dispatchEvent(new Event('banda.skills-changed'))`);
				await page.until(`document.body.textContent.includes('A change in the box needs your review')`);
				expect(
					await page.run(`document.querySelector('[data-skill-detail]')?.textContent.includes('Cite your sources.')`),
				).toBe(true);
				await click(page, button("Accept this version"));
				await page.until(`document.querySelector('[data-skill-detail]')?.textContent.includes('Check every source.')`);
				// a shipped skill the owner chose at first run works like any other
				await page.run(`location.hash='#/a/sancho'`);
				await fill(page, `document.querySelector('textarea[placeholder^="Message "]')`, "/bro", "HTMLTextAreaElement");
				await click(page, `document.querySelector('button[aria-label="Send"]')`);
				await page.until(`document.body.textContent.includes('Loaded /bro')`, 30_000);
			});
		} finally {
			await server.close();
			await daemon.close();
		}
	});
