import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, skipShippedSkills, tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const ORIGINAL = "---\nname: Mira\ndescription: Plans trips\n---\nOriginal personality.\n";
const REMOTE = ORIGINAL.replace("Original personality.", "The other device's personality.");
const MINE = "My draft stays here.";
const Agents = Type.Array(
	Type.Object({
		name: Type.String(),
		accepted: Type.Optional(Type.Object({ sha: Type.String(), text: Type.String() })),
	}),
);
const History = Type.Object({
	items: Type.Array(
		Type.Object({
			retained: Type.Array(
				Type.Union([
					Type.Object({ kind: Type.Literal("text"), text: Type.String() }),
					Type.Object({ kind: Type.Literal("unreadable") }),
				]),
			),
		}),
	),
});
const textarea = "document.querySelector('textarea[name=personality]')";
const button = (text: string) =>
	`[...document.querySelectorAll('button')].find(el => el.getClientRects().length && el.textContent.trim() === ${JSON.stringify(text)})`;
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;

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

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`keeps a stale personality draft and both saved versions through the app at ${width}px`,
		async () => {
			const home = await tempHome();
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
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
			const server = await webServer({
				server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
			});
			try {
				await skipShippedSkills(daemon.port, token);
				const created = await api(Agents, "/agents/mira", "PUT", { text: ORIGINAL, base: null });
				const original = created.find((agent) => agent.name === "mira")?.accepted;
				if (original === undefined) throw new Error("Mira was not accepted.");
				await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
					await page.until("!location.hash.includes('token=')");
					await page.run("location.hash='#/a/mira'");
					await click(page, "document.querySelector('button[aria-label=\"Mira: open its panel\"]')");
					await click(
						page,
						"document.querySelector('[role=tab][data-state=inactive][value=about]') || [...document.querySelectorAll('[role=tab]')].find(el=>el.textContent==='About')",
					);
					await page.until(`${textarea}?.value === 'Original personality.'`);
					await page.run(`(() => {
					const fetch = window.fetch.bind(window);
					let first = true;
					window.fetch = async (...args) => {
						if (first && String(args[0]).endsWith('/api/agents/mira') && args[1]?.method === 'PUT') {
							first = false;
							window.publicationRequestHeld = true;
							await new Promise(resolve => window.releasePublication = resolve);
							try {return await fetch(...args);} finally {window.publicationRequestFinished = true;}
						}
						return fetch(...args);
					};
				})()`);
					await click(page, textarea);
					await page.run(`${textarea}.select()`);
					await page.input("Input.insertText", { text: MINE });
					await page.until("window.publicationRequestHeld === true");
					await api(Agents, "/agents/mira", "PUT", { text: REMOTE, base: original.sha });
					await page.until(shows("Your changes are kept"));
					expect(await page.run(`${textarea}.value`)).toBe(MINE);
					await page.run("window.releasePublication()");
					await page.until("window.publicationRequestFinished === true");
					const shots = process.env.BANDA_PUBLICATION_SHOTS;
					if (shots !== undefined) {
						await mkdir(shots, { recursive: true });
						await page.shoot(join(shots, `${width}-conflict.png`));
					}
					await page.run("location.hash='#/a/sancho'");
					await page.until(shows("Sancho"));
					await page.run("location.hash='#/a/mira'");
					await page.until(
						`document.querySelector('aside')?.getAttribute('aria-label') === "Mira's panel" || document.querySelector('button[aria-label="Mira: open its panel"]')`,
					);
					if (!(await page.run(`document.querySelector('aside')?.getAttribute('aria-label') === "Mira's panel"`)))
						await click(page, "document.querySelector('button[aria-label=\"Mira: open its panel\"]')");
					await click(page, "[...document.querySelectorAll('[role=tab]')].find(el=>el.textContent==='About')");
					await page.until(`${textarea}?.value === ${JSON.stringify(MINE)}`);
					await click(page, button("Use my changes"));
					await until(async () =>
						(await api(Agents, "/agents")).find((agent) => agent.name === "mira")?.accepted?.text.includes(MINE),
					);
					await page.until("[...document.querySelectorAll('[role=status]')].some(el=>el.textContent.trim()==='Saved')");
					expect(await readFile(join(home, "workspace/agents/mira.md"), "utf8")).toContain(MINE);
					const history = await api(History, "/agents/mira/publications");
					expect(
						history.items
							.flatMap((item) => item.retained)
							.some((version) => version.kind === "text" && version.text === REMOTE),
					).toBe(true);
					await click(page, "[...document.querySelectorAll('summary')].find(el=>el.textContent==='Review versions')");
					await page.until(shows("Earlier workspace version"));
					await click(
						page,
						"[...document.querySelectorAll('summary')].find(el=>el.textContent==='Earlier workspace version')",
					);
					await page.until(shows("The other device's personality."));
					expect(await page.run("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
					if (shots !== undefined) await page.shoot(join(shots, `${width}-recovered.png`));
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await server.close();
				await daemon.close();
			}
		},
	);
