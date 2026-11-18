/**
 * The lead's personality through the app, as any agent's: its file's whole body on About, a body longer than a
 * paragraph or two with headings of its own, saved as typed with nothing added, and a body a home wrote before (its
 * role and a "## Personality" section) shown whole.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { withPersonality } from "../src/core/choices.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, skipShippedSkills, tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const ROLE = "You are the owner's lead agent: you talk with them, and do the work or hand it on.";
/** About 4 KB: a role, a tone and a section of rules, none of it a "## Personality" section. */
const LONG = `${ROLE}\n\nSpeak plainly.\n\n## Rules\n${"Keep the owner's week sane, and say so in one line. ".repeat(70).trim()}`;
const ADDED = "Answer in one line when you can.";
/** What a home made by an earlier build wrote: the role, then the words in a section of their own. */
const OLDER = `${ROLE}\n\n## Personality\nBe dry.`;
const Agents = Type.Array(
	Type.Object({
		name: Type.String(),
		accepted: Type.Optional(Type.Object({ sha: Type.String(), text: Type.String() })),
	}),
);
const Companion = Type.Object({ personality: Type.Optional(Type.String()) });
const textarea = "document.querySelector('textarea[name=personality]')";

async function click(page: Page, expression: string) {
	await page.until(expression);
	await page.run(`(${expression}).scrollIntoView({block:'center'})`);
	const point = await page.run<{ x: number; y: number }>(
		`(() => {const el=${expression}; const r=el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2;
		if(!el.contains(document.elementFromPoint(x,y))) throw new Error('Control is covered'); return {x,y};})()`,
	);
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

for (const [width, height] of [
	[390, 900],
	[1440, 900],
] as const)
	it.skipIf(!hasChrome())(
		`shows and saves the lead's whole body on About, as any agent's, at ${width}px`,
		async () => {
			expect(LONG.length).toBeGreaterThan(2000);
			const home = await tempHome();
			await (await import("node:fs/promises")).writeFile(
				join(home, "config.json"),
				JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
			);
			const daemon = await startDaemon({
				home,
				port: 0,
				models: echoModels().models,
				box: hostBox(home),
				log: () => {},
			});
			const token = (await readDaemonFile(home))?.token;
			if (token === undefined) throw new Error("The throwaway daemon has no token.");
			const base = `http://127.0.0.1:${daemon.port}`;
			const api = async <T extends TSchema>(
				schema: T,
				path: string,
				method = "GET",
				body?: unknown,
			): Promise<Static<T>> => {
				const response = await fetch(`${base}/api${path}`, {
					method,
					headers: { authorization: `Bearer ${token}` },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
				if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
				const result: unknown = await response.json();
				if (!Value.Check(schema, result)) throw new Error("The daemon returned an invalid response.");
				return result;
			};
			const lead = async () => {
				const file = (await api(Agents, "/agents")).find((agent) => agent.name === "sancho")?.accepted;
				if (file === undefined) throw new Error("The lead has no accepted file.");
				return file;
			};
			const server = await webServer({
				server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
			});
			try {
				await skipShippedSkills(daemon.port, token);
				// the daemon's own lead file has no section: one body, the role first
				const initial = await lead();
				expect(initial.text).not.toContain("## Personality");
				// a long body with headings is taken whole, and the file holds exactly it after the frontmatter
				expect((await api(Companion, "/companion", "PUT", { personality: LONG })).personality).toBe(LONG);
				const long = await lead();
				expect(long.text).toBe(withPersonality(initial.text, LONG));
				await withPage(`${server.origin}/#token=${token}`, { width, height }, async (page) => {
					await page.until("!location.hash.includes('token=')");
					await page.run("location.hash='#/a/sancho'");
					await click(page, "document.querySelector('button[aria-label=\"Sancho: open its panel\"]')");
					await page.until(`document.querySelector('aside')?.getAttribute('aria-label') === "Sancho's panel"`);
					await click(page, "[...document.querySelectorAll('[role=tab]')].find(el=>el.textContent==='About')");
					await page.until(`${textarea}?.value === ${JSON.stringify(LONG)}`);
					const shots = process.env.BANDA_PERSONALITY_SHOTS;
					if (shots !== undefined) {
						await mkdir(shots, { recursive: true });
						await page.shoot(join(shots, `${width}-lead-about.png`));
					}
					// an edit saves the body as typed: nothing added, nothing repeated
					const edited = `${LONG}\n\n${ADDED}`;
					await click(page, textarea);
					await page.run(`${textarea}.select()`);
					await page.input("Input.insertText", { text: edited });
					await until(async () => (await lead()).text.includes(ADDED));
					await page.until("[...document.querySelectorAll('[role=status]')].some(el=>el.textContent.trim()==='Saved')");
					const saved = await lead();
					expect(saved.text).toBe(withPersonality(long.text, edited));
					expect(saved.text.split(ROLE)).toHaveLength(2);
					expect(saved.text).not.toContain("## Personality");
					expect(await readFile(join(home, "workspace/agents/sancho.md"), "utf8")).toBe(saved.text);
					expect((await api(Companion, "/companion")).personality).toBe(edited);
					// a body an earlier build wrote, its words in a section of their own, is shown whole and kept as it is
					await api(Companion, "/companion", "PUT", { personality: OLDER, base: saved.sha });
					await page.until(`${textarea}?.value === ${JSON.stringify(OLDER)}`);
					if (shots !== undefined) await page.shoot(join(shots, `${width}-lead-older.png`));
					expect((await lead()).text).toBe(withPersonality(saved.text, OLDER));
					expect(await page.run("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await server.close();
				await daemon.close();
			}
		},
		120000,
	);
