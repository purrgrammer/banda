/**
 * The exchange's states, against a daemon stood in for by the dev server: an empty newest page with older pages
 * behind it says nothing until every page was read (a long chat of other work gives such a page); the notice that
 * the message it opened at is not here belongs to that call alone, so opening at another message needs no reset; a
 * pair the daemon knows no more is read again when the place changes, so an agent restored since is found.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import type { ExchangeMessage, ExchangeView } from "../src/server/api.ts";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

const fixture = fileURLToPath(new URL("./fixtures/agent-exchange-states.tsx", import.meta.url));
const mara = { id: "mara", name: "Mara", face: defaultAvatarFace() };
const AT = 1_700_000_000_000;
const message = (
	chat: number,
	entry: number,
	from: string,
	to: string,
	call: string,
	minute: number,
): ExchangeMessage => ({
	chat,
	entry,
	from,
	to,
	text: `Message ${call}`,
	at: AT + minute * 60_000,
	call,
});

let server: WebServer;
let url: string;
/** The daemon's answers, by pair and cursor; `ghost` is no pair until revived. */
let revived = false;
const pages: Record<string, ExchangeView> = {
	"mara/atlas": {
		agents: ["mara", "atlas"],
		items: [message(2, 20, "atlas", "mara", "c2", 2), message(1, 30, "mara", "atlas", "c3", 3)],
		next: "20.30",
	},
	"mara/atlas@20.30": { agents: ["mara", "atlas"], items: [message(1, 10, "mara", "atlas", "c1", 1)] },
	"mara/quiet": { agents: ["mara", "quiet"], items: [], next: "7.7" },
	"mara/quiet@7.7": { agents: ["mara", "quiet"], items: [message(1, 5, "quiet", "mara", "c0", 0)] },
	"mara/nobody": { agents: ["mara", "nobody"], items: [] },
	"mara/ghost": { agents: ["mara", "ghost"], items: [] },
};

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
		plugins: [
			{
				name: "exchange-states-fixture",
				resolveId: (id) => (id === "/exchange-states-fixture.tsx" ? fixture : undefined),
				load(id) {
					if (id !== fixture) return;
					return `import React from 'react'; import {createRoot} from 'react-dom/client';
					import {ExchangePage} from '/src/app/Exchange.tsx';
					import '/src/styles/globals.css';
					const mara=${JSON.stringify(mara)};
					function App(){const [other,setOther]=React.useState('atlas'); const [call,setCall]=React.useState('c1');
					const pick=(o,c)=>()=>{setOther(o);setCall(c);};
					return <main style={{height:'100vh',display:'flex',flexDirection:'column'}}>
					 <nav id="drive">
					  <button id="atlas-c9" onClick={pick('atlas','c9')}>atlas c9</button>
					  <button id="atlas-c2" onClick={pick('atlas','c2')}>atlas c2</button>
					  <button id="quiet" onClick={pick('quiet',undefined)}>quiet</button>
					  <button id="nobody" onClick={pick('nobody',undefined)}>nobody</button>
					  <button id="ghost" onClick={pick('ghost',undefined)}>ghost</button>
					  <button id="ghost-c1" onClick={pick('ghost','c1')}>ghost c1</button>
					 </nav>
					 <ExchangePage key={other} pair={[mara,{id:other,name:other,face:mara.face}]} call={call} phone={false} onBack={()=>{}} gone={<p id="gone">This conversation isn't in your band.</p>} />
					</main>}; createRoot(document.getElementById('root')).render(<App/>);`;
				},
				configureServer(vite) {
					vite.middlewares.use((req, res, next) => {
						const [path = "", query = ""] = (req.url ?? "").split("?");
						if (path === "/exchange-states") {
							void vite
								.transformIndexHtml(
									req.url ?? "",
									'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/exchange-states-fixture.tsx"></script>',
								)
								.then((html) => {
									res.setHeader("content-type", "text/html");
									res.end(html);
								});
							return;
						}
						if (path === "/fixture/revive") {
							revived = true;
							res.end("ok");
							return;
						}
						const pair = /^\/api\/exchanges\/([^/]+)\/([^/]+)$/.exec(path);
						if (pair === null) return next();
						const before = new URLSearchParams(query).get("before");
						const key = `${pair[1]}/${pair[2]}${before === null ? "" : `@${before}`}`;
						const page = pair[2] === "ghost" && !revived ? undefined : pages[key];
						res.setHeader("content-type", "application/json");
						if (page === undefined) {
							res.statusCode = 404;
							res.end(JSON.stringify({ error: "no such agent" }));
							return;
						}
						res.end(JSON.stringify(page));
					});
				},
			},
		],
	});
	url = `${server.origin}/exchange-states#token=fixture`;
});
afterAll(async () => {
	await server?.close();
});

it.skipIf(!hasChrome())(
	"says nothing is there only once every page was read, and keeps its notices to their place",
	async () => {
		await withPage(url, { width: 1100, height: 800 }, async (page) => {
			const marked = (call: string) => `document.querySelector('[data-found][data-call="${call}"]')`;
			const notice = `document.body.innerText.includes("The message this opened at isn't here.")`;
			const empty = `document.body.innerText.includes("haven't messaged each other yet")`;
			// opened at a message of an older page: paged back to it, marked
			await page.until(`${marked("c1")} !== null`);
			expect(await page.run(`document.querySelectorAll('[data-call]').length`)).toBe(3);
			// opened at a message that is nowhere: said, for that call
			await page.click("document.querySelector('#atlas-c9')");
			await page.until(notice);
			// opened at one that is here: found and marked, the notice gone with no reset of anything
			await page.click("document.querySelector('#atlas-c2')");
			await page.until(`${marked("c2")} !== null`);
			expect(await page.run(notice)).toBe(false);
			// an empty newest page with more behind it: no "nothing yet", only the way to the earlier page
			await page.click("document.querySelector('#quiet')");
			await page.until(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Earlier messages')`);
			expect(await page.run(empty)).toBe(false);
			await page.click(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Earlier messages')`);
			await page.until(`document.querySelector('[data-call="c0"]') !== null`);
			expect(await page.run(empty)).toBe(false);
			// nothing at all, every page read: said
			await page.click("document.querySelector('#nobody')");
			await page.until(empty);
			// a pair the daemon knows no more: gone; opened at a message once it is back, it is read again
			await page.click("document.querySelector('#ghost')");
			await page.until("document.querySelector('#gone') !== null");
			await page.run(`fetch('/fixture/revive', { method: 'POST' })`);
			await page.click("document.querySelector('#ghost-c1')");
			await page.until(`document.querySelector('#gone') === null && ${empty}`);
			expect(page.errors()).toEqual([]);
		});
	},
);

it.skipIf(!hasChrome())("the specimen shows the exchange and its empty states at both widths", async () => {
	const shots = process.env.BANDA_EXCHANGE_SHOTS;
	for (const [width, name] of [
		[1440, "desktop"],
		[390, "phone"],
	] as const)
		await withPage(
			`${server.origin}/#/specimen?section=agent-exchange&only=1&scheme=light&width=${name}`,
			{ width, height: 1400 },
			async (page) => {
				await page.until(`document.querySelectorAll('[data-call]').length === 3`);
				expect(await page.run(`document.body.innerText.includes("haven't messaged each other yet")`)).toBe(true);
				expect(await page.run(`document.body.innerText.split('Earlier messages').length`)).toBe(2);
				expect(await page.run("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
				if (shots !== undefined) {
					await mkdir(shots, { recursive: true });
					await page.shoot(join(shots, `${width}-specimen-exchange.png`));
				}
				expect(page.errors()).toEqual([]);
			},
		);
});
