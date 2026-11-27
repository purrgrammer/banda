/**
 * Reading the web leaves no row in the chat (DESIGN.md "The chat", #145): an answer that rests on several `web_fetch`
 * reads, one of them failed, shows the owner its words with their links and nothing per read; a reply that failed
 * after more reads still says so; and every read, the failed one marked, is in the message's activity. At phone and
 * desktop width, from the app's own chat over a fixture API; screenshots when `BANDA_WEB_READS_SHOTS` names a folder.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import type { Item } from "../src/server/api.ts";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";
import { chooseMessageAction } from "./smoke/message-actions.ts";

const fixture = fileURLToPath(new URL("../web/web-reads-fixture.tsx", import.meta.url));
const chat = 40;
const at = Date.UTC(2026, 10, 19, 9, 30);
const face = defaultAvatarFace();
const who = { id: "sancho", name: "Sancho", face };
const called = (id: number, call: string, url: string): Item => ({
	id,
	role: "assistant",
	text: "",
	at: at + id * 1000,
	calls: [{ id: call, name: "web_fetch", args: { url } }],
});
const read = (id: number, call: string, text: string, error = false): Item => ({
	id,
	role: "tool",
	call,
	name: "web_fetch",
	text,
	error,
	at: at + id * 1000,
});
const answer =
	"The next total solar eclipse is on 2 August 2027, longest over Luxor, per " +
	"[NASA's eclipse page](https://eclipse.example/2027) and [timeanddate](https://times.example/eclipse/2027).";
const items: Item[] = [
	{ id: 1, role: "user", text: "When is the next total solar eclipse, and where is it longest?", at },
	called(2, "a", "https://eclipse.example/2027"),
	read(3, "a", "Read https://eclipse.example/2027: HTTP 200, text/html.\nTotality on 2 August 2027…"),
	called(4, "b", "https://down.example/eclipses"),
	read(5, "b", "https://down.example/eclipses answered HTTP 503 (Service Unavailable).", true),
	called(6, "c", "https://times.example/eclipse/2027"),
	read(7, "c", "Read https://times.example/eclipse/2027: HTTP 200, text/html.\nLuxor, 6 minutes 23 seconds…"),
	{
		id: 8,
		role: "assistant",
		text: "",
		at: at + 8000,
		calls: [{ id: "say", name: "message_user", args: { text: answer } }],
	},
	{ id: 9, role: "tool", call: "say", name: "message_user", text: "Sent.", error: false, at: at + 9000 },
	{ id: 10, role: "user", text: "And the one after that?", at: at + 10_000 },
	called(11, "d", "https://eclipse.example/2028"),
	read(12, "d", "Read https://eclipse.example/2028: HTTP 200, text/html.\n…"),
	called(13, "e", "https://times.example/eclipse/2028"),
	read(14, "e", "Read https://times.example/eclipse/2028: HTTP 200, text/html.\n…"),
	{ id: 15, role: "assistant", text: "", at: at + 15_000, error: "overloaded" },
];
const tail = items.at(-1)?.id ?? 0;

let server: WebServer;
let base: string;

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
		plugins: [
			{
				name: "web-reads-fixture",
				resolveId: (id) => (id === "/web-reads-fixture.tsx" ? fixture : undefined),
				load(id) {
					if (id !== fixture) return;
					return `import React from 'react'; import { createRoot } from 'react-dom/client';
					import { AgentChat } from '/src/app/AgentChat.tsx'; import { showAgents } from '/src/lib/shell.ts';
					import '/src/styles/globals.css';
					const who = ${JSON.stringify(who)};
					showAgents([{ name: 'sancho', accepted: { sha: 'sancho', text: '', agent: { ...who, state: 'active' } } }]);
					createRoot(document.getElementById('root')).render(
					 <main style={{height:'100svh',display:'flex',position:'relative'}}>
					  <AgentChat agent="sancho" who={who} row={{chat:${chat},read:${tail},state:'idle'}} phone={innerWidth<768} panelOpen={false} onBack={()=>{}} onPanel={()=>{}} />
					 </main>);`;
				},
				configureServer(vite) {
					vite.middlewares.use((req, res, next) => {
						const path = (req.url ?? "").split("?")[0] ?? "";
						if (path === "/web-reads") {
							void vite
								.transformIndexHtml(
									req.url ?? "",
									'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/web-reads-fixture.tsx"></script>',
								)
								.then((html) => {
									res.setHeader("content-type", "text/html");
									res.end(html);
								});
							return;
						}
						if (path === "/api/events") {
							res.setHeader("content-type", "text/event-stream");
							res.write(": fixture\n\n");
							if ((req.url ?? "").includes(`chat=${chat}`))
								res.write(
									`data: ${JSON.stringify({ type: "live", chat, event: { type: "ready", tail, busy: false, partial: [], running: [] } })}\n\n`,
								);
							return;
						}
						if (!path.startsWith("/api/")) return next();
						res.setHeader("content-type", "application/json");
						if (path === `/api/chats/${chat}/items`) {
							const after = new URL(req.url ?? "", "http://x").searchParams.get("after");
							res.end(
								JSON.stringify({ items: after === null ? items : items.filter((item) => item.id > Number(after)) }),
							);
							return;
						}
						// lists the chat asks for beside its transcript: none here
						res.end(JSON.stringify(path === "/api/skills" || path === "/api/objects" ? [] : {}));
					});
				},
			},
		],
	});
	base = server.origin;
});
afterAll(async () => {
	await server?.close();
});

const feed = `document.querySelector('main')`;

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`an answer over several reads shows its words and links, no row per read, and the reads in its activity, at ${width}px`,
		async () => {
			const shots = process.env.BANDA_WEB_READS_SHOTS;
			if (shots !== undefined) await mkdir(shots, { recursive: true });
			await withPage(`${base}/web-reads#token=web-reads-test`, { width, height: 900 }, async (page) => {
				await page.until(`document.body.innerText.includes("Couldn't get a reply")`);
				await page.until(`document.querySelector('a[data-markdown-link][href="https://times.example/eclipse/2027"]')`);
				const text = await page.run<string>(`${feed}.innerText`);
				// the answer, with the sources it names
				expect(text).toContain("longest over Luxor");
				expect(
					await page.run<string[]>(
						`[...document.querySelectorAll('a[data-markdown-link]')].map((a) => a.getAttribute('href'))`,
					),
				).toEqual(["https://eclipse.example/2027", "https://times.example/eclipse/2027"]);
				// no row per read, successful or failed, and no "+n more" of the old line; the failed reply still says so
				expect(text).not.toMatch(/^Read\b/m);
				expect(text).not.toMatch(/\+\d+ more/);
				expect(text).not.toContain("down.example");
				expect(await page.run<number>(`document.querySelectorAll('.lucide-book-open').length`)).toBe(0);
				expect(text).toContain("Couldn't get a reply");
				expect(text).toContain("Try again");
				if (shots !== undefined) await page.shoot(join(shots, `${width}-feed.png`));
				// the message's activity holds every read, the failed one marked (its address is drawn in two parts)
				const action = `document.querySelector('button[data-message-transcript]')`;
				await chooseMessageAction(page, action, "Activity");
				await page.until(`document.querySelector('[role="dialog"] [data-step]')`);
				const activity = await page.run<string>(`document.querySelector('[role="dialog"]').textContent`);
				expect(activity).toContain("eclipse.example/2027");
				expect(activity).toContain("down.example/eclipses");
				expect(activity).toContain("times.example/eclipse/2027");
				expect(activity).toContain("Failed");
				if (shots !== undefined) {
					// the sheet has slid in: a picture of it, not of its way there
					await page.until(
						`Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished)).then(() => true)`,
					);
					await page.shoot(join(shots, `${width}-activity.png`));
				}
				expect(page.errors()).toEqual([]);
			});
		},
	);
