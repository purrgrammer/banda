import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { RoutineRunView, RoutineView } from "../src/server/api.ts";
import { until, type WebServer, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

/**
 * A routine's detail in the agent's panel, against a daemon's answers: its runs in words, newest first, ten and "Show
 * earlier"; a run that spoke opens its line in the chat and focus comes back to it; a quiet one is no button; Pause
 * says Paused and asks the daemon, which says Resume once it is; Edit and Back are handed up. At phone and desktop
 * width.
 */
const fixturePath = fileURLToPath(new URL("../web/routine-detail-fixture.tsx", import.meta.url));
const NOW = new Date(2026, 10, 12, 9, 0).getTime();
const HOUR = 3_600_000;

const run = (i: number): RoutineRunView =>
	i === 0
		? { at: NOW - HOUR, state: "said", said: "2 PRs need you", line: { chat: 12, entry: 40 } }
		: i === 1
			? { at: NOW - 2 * HOUR, state: "failed", why: "overloaded", line: { chat: 12, entry: 30 } }
			: { at: NOW - (i + 1) * HOUR, state: "quiet" };
const PAGES: { [before: string]: { runs: RoutineRunView[]; earlier?: number } } = {
	newest: { runs: Array.from({ length: 10 }, (_, i) => run(i)), earlier: NOW - 10 * HOUR },
	[String(NOW - 10 * HOUR)]: { runs: [run(10), run(11)] },
};
const routine = (paused: boolean): RoutineView => ({
	name: "morning-brief",
	agent: "mara",
	state: paused ? "paused" : "active",
	...(paused ? { paused: "owner" as const } : { next: NOW + 23 * HOUR }),
	accepted: {
		sha: "a".repeat(64),
		routine: {
			description: "Morning brief",
			when: "Weekdays at 08:00",
			schedule: "cron 0 8 * * 1-5",
			runsADay: 24,
			ask: "Brief me.",
		},
	},
});

let server: WebServer;
let base = "";
let posted: string[] = [];
let paused = false;

const json = (res: ServerResponse, body: unknown) => {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
};
const drain = async (req: IncomingMessage) => {
	for await (const _ of req);
};

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
		plugins: [
			{
				name: "routine-detail-fixture",
				resolveId(id) {
					if (id === "/routine-detail-fixture.tsx") return fixturePath;
				},
				load(id) {
					if (id !== fixturePath) return;
					return `import React, { StrictMode, useState } from 'react';
					import { createRoot } from 'react-dom/client';
					import { RoutineHistory } from '/src/app/routines.tsx';
					import { useShell } from '/src/lib/shell.ts';
					import '/src/styles/globals.css';
					function Fixture() {
					 // the routine as the daemon's answer to Pause says it, once there is one
					 const view = useShell().control?.routines?.[0] ?? ${JSON.stringify(routine(false))};
					 const [focus, setFocus] = useState(undefined);
					 const [shown, setShown] = useState(true);
					 window.opened = window.opened ?? []; window.handed = window.handed ?? [];
					 return <main style={{maxWidth:420,height:'100vh',display:'flex',flexDirection:'column'}}>
					  <button onClick={() => setShown(true)}>Open the panel</button>
					  {shown ? <RoutineHistory routine={view} agent="Mara" chat={12} now={${NOW}} focusRun={focus}
					   onBack={() => window.handed.push('back')} onEdit={() => window.handed.push('edit')}
					   onOpenRun={(at, entry) => { window.opened.push([at, entry]); setFocus(at); setShown(false); }} /> : null}
					 </main>;
					}
					createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);`;
				},
				configureServer(vite) {
					vite.middlewares.use((req, res, next) => {
						const [path = "", query = ""] = (req.url ?? "").split("?");
						if (path === "/routine-detail-fixture") {
							void vite
								.transformIndexHtml(
									req.url ?? "",
									'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/routine-detail-fixture.tsx"></script></body></html>',
								)
								.then((html) => {
									res.setHeader("content-type", "text/html");
									res.end(html);
								});
							return;
						}
						if (!path.startsWith("/api/")) return next();
						void (async () => {
							if (path === "/api/events") {
								res.setHeader("content-type", "text/event-stream");
								res.write(": fixture\n\n");
								return;
							}
							if (path === "/api/routines/morning-brief/runs") {
								const before = new URLSearchParams(query).get("before");
								return json(res, PAGES[before ?? "newest"] ?? { runs: [] });
							}
							if (req.method === "POST" && path.startsWith("/api/routines/morning-brief/")) {
								await drain(req);
								posted.push(path);
								paused = path.endsWith("/pause");
								// the control view as it is after, as the daemon answers
								return json(res, { routines: [routine(paused)], activity: [], permissions: [] });
							}
							json(res, {});
						})();
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

const button = (text: string) =>
	`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const runButtons = `Array.from(document.querySelectorAll('button[data-run]'))`;

for (const width of [390, 1280])
	it.skipIf(!hasChrome())(
		`a routine's runs read back, open the chat at their line, and pause, at ${width}px`,
		async () => {
			posted = [];
			paused = false;
			await withPage(`${base}/routine-detail-fixture#token=routine-test`, { width, height: 900 }, async (page) => {
				await page.until(`document.querySelectorAll('[data-run]').length === 10`);
				const text = await page.run<string>(`document.querySelector('main').innerText`);
				expect(text).toContain("Morning brief");
				expect(text).toContain("Said: 2 PRs need you");
				expect(text).toContain("Failed: the model provider is busy or out of quota");
				expect(text).toContain("Said nothing");
				// only the runs that spoke or failed are buttons; silence is quiet text
				expect(await page.run<number>(`${runButtons}.length`)).toBe(2);
				// each run's line is tall enough to tap
				expect(
					await page.run<number>(`Math.min(...${runButtons}.map(b => b.getBoundingClientRect().height))`),
				).toBeGreaterThanOrEqual(44);
				// ten in view, then the earlier page beneath them
				await page.run(`${button("Show earlier")}.click()`);
				await page.until(`document.querySelectorAll('[data-run]').length === 12`);
				expect(await page.run<boolean>(`!${button("Show earlier")}`)).toBe(true);
				// a run that spoke opens its line; when the detail shows again, focus is back on it
				await page.run(`${runButtons}[0].click()`);
				await page.until(`window.opened.length === 1`);
				expect(await page.run<[number, number][]>(`window.opened`)).toEqual([[NOW - HOUR, 40]]);
				await page.run(`${button("Open the panel")}.click()`);
				await page.until(`document.activeElement?.dataset.run === ${JSON.stringify(String(NOW - HOUR))}`);
				// Pause asks the daemon and says Paused; then the verb is Resume
				await page.run(`${button("Pause")}.click()`);
				await until(() => posted.length === 1);
				expect(posted).toEqual(["/api/routines/morning-brief/pause"]);
				await page.until(`!!${button("Resume")} && document.querySelector('main').innerText.includes('Paused')`);
				await page.run(`${button("Edit")}.click()`);
				await page.run(`${button("Routines")}.click()`);
				expect(await page.run<string[]>(`window.handed`)).toEqual(["edit", "back"]);
				expect(page.errors()).toEqual([]);
			});
		},
	);
