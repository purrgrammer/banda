import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freePort, viteCacheDir } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

/**
 * A dialog with nothing left to do folds into one row of the chat's feed: an approval, a question, a proposal, a
 * routine, a change and an effect, each answered as the owner watches (its result holds, then it folds) or already
 * answered when the chat opens (a row from the start). The row names what was done and what to, the object as a rich
 * ref, a routine as a chip that opens it; its chevron opens the card it was. One agent's chat names no one.
 */
const fixturePath = fileURLToPath(new URL("../web/feed-fold-fixture.tsx", import.meta.url));
const facePath = fileURLToPath(new URL("../src/core/avatar-face.ts", import.meta.url));
const PR = {
	card: "pull-request",
	repo: "purrgrammer/banda",
	number: 34,
	title: "One word per thing",
	state: "open",
	author: "bandarra",
	branch: "terminology",
	checks: null,
	reviews: "",
	added: 1,
	removed: 1,
	url: "https://github.com/purrgrammer/banda/pull/34",
};
const DEADLINE = 4_102_444_800_000;
const segments = (settled: boolean) => [
	{
		kind: "approval",
		key: "10:ask",
		ask: {
			type: "approval",
			tool: "github__add_issue_comment",
			args: { body: "Looks good" },
			label: "Comment on purrgrammer/banda #34",
			verb: "Comment",
			as: "@bandarra on GitHub",
			on: { refs: ["https://github.com/purrgrammer/banda/pull/34"] },
		},
		label: "Comment on purrgrammer/banda #34",
		args: [],
		...(settled
			? { ended: { outcome: "answered", answer: "approve", said: "Approved, and allowed for this task" } }
			: { open: { wait: "w1", deadline: DEADLINE } }),
	},
	{
		kind: "question",
		key: "11:ask",
		ask: { type: "question", question: "Which flight should I book?", options: ["TP 1351", "IB 3105"] },
		...(settled
			? { ended: { outcome: "answered", answer: "TP 1351", said: "TP 1351" } }
			: { open: { wait: "w2", deadline: DEADLINE } }),
	},
	{
		kind: "proposal",
		key: "p1",
		state: settled ? "accepted" : "pending",
		proposal: {
			id: "p1",
			chat: 1,
			from: "sancho",
			kind: "agent",
			agentId: "mara",
			name: "Mara",
			face: "FACE",
			description: "Plans trips",
			instructions: "Warm and brief.",
			at: 0,
			state: settled ? "accepted" : "pending",
		},
	},
	{
		kind: "routine",
		key: "12",
		name: "fare-watch",
		state: settled ? "done" : "pending",
		routine: settled
			? { accepted: { routine: { when: "Daily at 08:00", ask: "Check fares", description: "Fare watch" } } }
			: {
					change: {
						kind: "added",
						sha: "abc",
						routine: { when: "Daily at 08:00", ask: "Check fares", description: "Fare watch" },
					},
				},
	},
	{
		kind: "change",
		key: "13",
		state: "done",
		folder: "connections",
		name: "notion",
		subject: { connection: { accepted: { connection: { service: "Notion" } } } },
	},
	{
		kind: "effect",
		key: "14",
		label: "Commented on purrgrammer/banda #34, as you allowed for this task",
		permission: { scope: "task" },
	},
];

let server: ViteDevServer;
let base = "";

function json(res: ServerResponse, body: unknown) {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await createServer({
		configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
		cacheDir: await viteCacheDir(),
		server: { port: await freePort(), strictPort: true, host: "127.0.0.1", open: false },
		plugins: [
			{
				name: "feed-fold-fixture",
				resolveId(id) {
					if (id === "/feed-fold-fixture.tsx") return fixturePath;
				},
				load(id) {
					if (id !== fixturePath) return;
					// the open asks, then each answered in place; or, on ?settled, answered when the chat opens
					return `import React, { StrictMode, useState } from 'react';
					import { createRoot } from 'react-dom/client';
					import { FeedView } from '/src/app/Feed.tsx';
					import { defaultAvatarFace } from '/@fs${facePath}';
					import '/src/styles/globals.css';
					const face = defaultAvatarFace();
					const dress = (list) => JSON.parse(JSON.stringify(list).replaceAll('"FACE"', JSON.stringify(face)));
					const open = dress(${JSON.stringify(segments(false))});
					const settled = dress(${JSON.stringify(segments(true))});
					window.opened = [];
					function Fixture() {
					 const [answered, setAnswered] = useState(location.search.includes('settled'));
					 return <main style={{maxWidth:720,margin:'auto',padding:16,display:'flex',flexDirection:'column',gap:12}}>
					  <button onClick={() => setAnswered(true)}>Answer them</button>
					  <FeedView chat={1} who={{ name: 'Sancho', face }} agent="sancho" compact={false}
					   segments={answered ? settled : open} onRoutine={(name) => window.opened.push(name)} />
					 </main>;
					}
					createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);`;
				},
				configureServer(vite) {
					vite.middlewares.use((req, res, next) => {
						const path = (req.url ?? "").split("?")[0] ?? "";
						if (path === "/feed-fold-fixture") {
							void vite
								.transformIndexHtml(
									req.url ?? "",
									'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/feed-fold-fixture.tsx"></script></body></html>',
								)
								.then((html) => {
									res.setHeader("content-type", "text/html");
									res.end(html);
								});
							return;
						}
						if (!path.startsWith("/api/")) return next();
						if (path === "/api/events") {
							res.setHeader("content-type", "text/event-stream");
							res.write(": fixture\n\n");
							return;
						}
						if (path === "/api/objects")
							return json(res, [
								{
									shown: "card",
									key: "github:pull-request:purrgrammer/banda/34",
									connection: "github",
									service: "GitHub",
									name: "purrgrammer/banda #34",
									at: Date.now(),
									old: false,
									card: PR,
								},
							]);
						json(res, {});
					});
				},
			},
		],
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (address === null || typeof address !== "object" || address === undefined)
		throw new Error("fixture did not listen");
	base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
	await server?.close();
});

const button = (text: string) =>
	`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const row = (kind: string) => `document.querySelector('[data-done="${kind}"]')`;
const rowText = (kind: string) => `(${row(kind)}?.textContent ?? '')`;
const KINDS = ["comment", "answer", "agent", "routine", "permission"];

for (const width of [390, 1280]) {
	it.skipIf(!hasChrome())(
		`answered as the owner watches, each card holds its result, then folds, at ${width}px`,
		async () => {
			await withPage(`${base}/feed-fold-fixture#token=fold-test`, { width, height: 1400 }, async (page) => {
				// open: the cards, with their verbs
				await page.until(`!!(${button("Comment")}) && !!(${button("TP 1351")}) && !!(${button("Create agent")})`);
				expect(await page.run(`document.querySelectorAll('[data-done]').length`)).toBe(2); // the change and the effect
				await page.run(`${button("Answer them")}.click()`);
				// the result holds a beat on the card, so the owner sees it land
				await page.until(`document.body.textContent.includes('Approved, and allowed for this task')`);
				expect(await page.run(`!!${row("comment")}`)).toBe(false);
				// then each folds into its row
				await page.until(KINDS.map((kind) => `!!${row(kind)}`).join(" && "));
				await page.until(`!${button("Comment")} && !${button("Create agent")}`);
				// one agent's chat names no one: the row starts with what was done
				expect(await page.run<string>(rowText("comment"))).toMatch(/^Commented on purrgrammer\/banda #34/);
				// the object it acted on, rich: GitHub's mark, its state and its title, linked
				await page.until(`!!${row("comment")}.querySelector('[data-object-inline] a[href="${PR.url}"]')`);
				expect(await page.run<string>(rowText("comment"))).toContain("One word per thing");
				expect(await page.run<string>(rowText("answer"))).toContain("Answered");
				expect(await page.run<string>(rowText("answer"))).toContain("TP 1351");
				// a new agent is its mention, a link to its chat
				expect(await page.run(`!!${row("agent")}.querySelector('a[href="#/a/mara"]')`)).toBe(true);
				// a routine's chip opens it
				await page.run(`${row("routine")}.querySelector('button[aria-label="Open the routine Fare watch"]').click()`);
				expect(await page.run<string[]>(`window.opened`)).toEqual(["fare-watch"]);
				expect(
					await page.run<string>(`document.querySelectorAll('[data-done="permission"]')[0].textContent`),
				).toContain("Allowed");
				// the chevron opens the card it was, settled; again, it folds
				const chevron = `${row("comment")}.querySelector('button[aria-expanded]')`;
				await page.run(`${chevron}.click()`);
				await page.until(
					`${chevron}.getAttribute('aria-expanded') === 'true' && ${rowText("comment")}.includes('as @bandarra on GitHub')`,
				);
				await page.run(`${chevron}.click()`);
				await page.until(`!${rowText("comment")}.includes('as @bandarra on GitHub')`);
				// a stretch of rows reads as one log: close together, not a message's distance apart
				const spaced = await page.run<number[]>(
					`(() => { const boxes = [...document.querySelectorAll('[data-done]')].map(el => el.getBoundingClientRect()).sort((a, b) => a.top - b.top); return boxes.slice(1).map((box, i) => Math.round(box.top - boxes[i].bottom)); })()`,
				);
				expect(spaced.length).toBe(5);
				for (const gap of spaced) expect(gap).toBeLessThanOrEqual(8);
				// rows sit across the feed, centred, never wider than the page
				expect(
					await page.run<boolean>(
						`[...document.querySelectorAll('[data-done]')].every(el => el.getBoundingClientRect().right <= innerWidth + 0.5)`,
					),
				).toBe(true);
				expect(page.errors()).toEqual([]);
			});
		},
	);

	it.skipIf(!hasChrome())(`a chat opened on answered asks shows their rows from the start, at ${width}px`, async () => {
		await withPage(`${base}/feed-fold-fixture?settled#token=fold-test`, { width, height: 1400 }, async (page) => {
			await page.until(KINDS.map((kind) => `!!${row(kind)}`).join(" && "));
			// no card waits to fold: nothing to hold, nothing animates in
			expect(
				await page.run(`!!(${button("Comment")}) || document.body.textContent.includes('Approved, and allowed')`),
			).toBe(false);
			expect(page.errors()).toEqual([]);
		});
	});
}
