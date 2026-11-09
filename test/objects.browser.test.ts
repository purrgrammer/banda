import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import type { ObjectAsk, ObjectShown } from "../src/server/objects.ts";
import { freePort, viteCacheDir } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

async function openObjectMenu(page: Page, selector: string, keyboard = true) {
	await page.run(
		`(() => { const trigger = document.querySelector(${JSON.stringify(selector)}); trigger.focus(); trigger.dispatchEvent(new ${keyboard ? "KeyboardEvent('keydown', {key:'Enter',bubbles:true})" : "PointerEvent('pointerdown', {button:0,ctrlKey:false,pointerType:'touch',bubbles:true})"}); })()`,
	);
	await page.until(`document.querySelector('[role="menu"]')`);
}
async function closeObjectMenu(page: Page) {
	await page.run(
		`document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
	);
	await page.until(`!document.querySelector('[role="menu"]')`);
}
async function refreshObject(page: Page, selector: string, keyboard = true) {
	await openObjectMenu(page, selector, keyboard);
	await page.run(
		`(() => { const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(item => item.textContent === 'Refresh preview'); item.focus(); ${keyboard ? "item.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))" : "item.click()"}; })()`,
	);
}

const fixturePath = fileURLToPath(new URL("../web/objects-fixture.tsx", import.meta.url));
const longBranch = "ernesto/6aa9457fc87469c60ed88413/qa-commit-a-failed-web-case-s-proven-pre-cb5c56";
const longRepo = "an-organisation-with-a-long-name/a-repository-with-a-very-long-name-that-must-not-stretch-the-chat";
const longTitle =
	"A realistic pull request title that keeps its full meaning even on a narrow phone and can wrap safely ".repeat(2);
const pr = "https://github.com/owner/repo/pull/34";
const issue = "https://github.com/owner/repo/issues/35";
const check = "https://github.com/owner/repo/actions/runs/36/job/38";
const who = { id: "octo", name: "Octo", face: defaultAvatarFace() };
const approval = {
	type: "approval",
	tool: "github__add_issue_comment",
	label: "Comment on owner/repo #34",
	verb: "Comment",
	as: "@work on GitHub",
	args: { owner: "owner", repo: "repo", issue_number: 34, body: "Original exact comment" },
	editable: ["body"],
	on: { refs: [pr], account: "work" },
	scopes: [{ scope: "task", words: "Don't ask again for this task" }],
};
const interruptedApproval = {
	...approval,
	interrupted: true,
	args: { ...approval.args, body: "Original stored bytes\nsecond line" },
};
/** An agent's message that shows the links it names as cards: a card is only what a message gives in `objects`. */
const agentMessage = (id: number, text: string) => [
	{
		role: "assistant",
		id,
		calls: [{ id: `sent-${id}`, name: "message_user", args: { text, objects: text.match(/https:\/\/\S+/g) ?? [] } }],
	},
	{ role: "tool", id: id + 1, name: "message_user", call: `sent-${id}`, text: "Sent.", error: false },
];
const items = [
	{
		role: "user",
		id: 1,
		text: `Owner words ${pr} ${pr}#discussion [again](${pr}/files) ${issue} ${check} https://github.com/owner/repo/issues/37`,
	},
	{
		role: "assistant",
		id: 2,
		calls: [
			{ id: "sent", name: "message_user", args: { text: `Agent words [PR](${pr})`, objects: [pr, "notification/7"] } },
		],
	},
	{ role: "tool", id: 3, name: "message_user", call: "sent", text: "Sent.", error: false },
	{
		role: "assistant",
		id: 4,
		calls: [
			{
				id: "only",
				name: "message_user",
				args: { objects: ["https://github.com/owner/repo/actions/runs/99/job/100"] },
			},
		],
	},
	{ role: "tool", id: 5, name: "message_user", call: "only", text: "Sent.", error: false },
	...agentMessage(6, "Failed preview https://github.com/owner/repo/issues/400"),
	...agentMessage(8, "No account https://github.com/owner/repo/issues/401"),
];
const ownerItems = [
	{ role: "user", id: 301, text: `Approve and merge ${pr}. Then [the issue](${issue}). Code stays code: \`${pr}\`.` },
	{ role: "user", id: 302, text: "Unknown https://example.com/page" },
	{ role: "user", id: 303, text: "Failed https://github.com/owner/repo/issues/400" },
	{ role: "user", id: 304, text: "No account https://github.com/owner/repo/issues/401" },
	{ role: "user", id: 305, text: "Network https://github.com/owner/repo/issues/503" },
	{ role: "user", id: 306, text: "See you at [the offsite](calendar/abc), and [this one](calendar/nothing)" },
];
const connectItems = [
	{
		role: "assistant",
		id: 200,
		calls: [{ id: "connect", name: "message_user", args: { objects: [pr, issue, check] } }],
	},
	{ role: "tool", id: 201, name: "message_user", call: "connect", text: "Sent.", error: false },
];
const capabilities = (granted: boolean) => ({
	connections: [
		{
			name: "github",
			accepted: { connection: { service: "GitHub" } },
			accounts: [{ account: "personal", label: "@personal", agents: granted ? ["octo"] : [] }],
		},
	],
});
/** A connection nothing signed in to yet, and the same once a sign-in its server did not name finished for Octo. */
const unsigned = { connections: [{ name: "github", accepted: { connection: { service: "GitHub" } }, accounts: [] }] };
const numberedSignIn = (label: string) => ({
	connections: [
		{
			name: "github",
			accepted: { connection: { service: "GitHub" } },
			accounts: [{ account: "account-1", id: "account 1", label, numbered: true, agents: ["octo"] }],
			finished: { account: "account-1", id: "account 1", label, agent: "octo", known: false, at: 1 },
		},
	],
});
const unknownRef = "https://github.com/owner/repo/discussions/404";
const edgeItems = [
	{
		role: "assistant",
		id: 100,
		calls: [{ id: "unknown", name: "message_user", args: { objects: [unknownRef, "javascript:alert(1)"] } }],
	},
	{ role: "tool", id: 101, name: "message_user", call: "unknown", text: "Sent.", error: false },
	...agentMessage(102, "https://github.com/owner/repo/issues/503"),
	...agentMessage(104, "https://github.com/owner/repo/pull/500"),
];
const group = {
	room: 20,
	name: "Review",
	members: ["octo", "mara"],
	working: [],
	at: 1,
	latest: 5,
	read: 5,
	unread: 0,
	executions: { octo: 21, mara: 22 },
	asking: ["group-wait"],
	notices: [],
	messages: [
		{ entry: 1, author: { owner: true }, text: `Owner in group ${pr}`, mentions: [], at: 1 },
		{ entry: 2, author: { agent: "mara" }, text: `Mara in group ${pr}`, objects: [pr], mentions: [], at: 2 },
		{ entry: 3, author: { agent: "octo" }, text: "", objects: [check], mentions: [], at: 3 },
		{ entry: 4, author: { agent: "retired" }, text: "", objects: [unknownRef], mentions: [], at: 4 },
	],
	asks: [{ agent: "mara", wait: { key: "group-wait", ask: approval, deadline: Date.now() + 60_000 } }],
};

type Asked = { chat: number; asks: (ObjectAsk & { agent?: string })[]; refresh?: boolean };
let server: ViteDevServer;
let base = "";
let requests: Asked[] = [];
let answers: { path: string; body: unknown }[] = [];
let hold: Promise<void> | undefined;
let release: (() => void) | undefined;
let needsGrant = false;
let recoveryGroup = false;
let recoveryRefusals = 0;
let longMetadata = false;

function shown(ref: string, account = "personal", refresh = false): ObjectShown {
	if (ref === "calendar/nothing") return { shown: "link" };
	if (ref === "calendar/abc")
		return {
			shown: "card",
			key: ref,
			name: "abc",
			connection: "calendar",
			service: "Google Calendar",
			at: Date.now(),
			old: false,
			card: {
				card: "event",
				title: "Team offsite",
				start: "2026-11-11",
				end: "2026-11-14",
				allDay: true,
				timeZone: "",
				location: "Lisbon",
				organizer: "Ana",
				who: "Ana, Teo",
				attendees: 3,
				response: "accepted",
				status: "confirmed",
				description: "",
			},
		};
	if (ref === unknownRef || ref.startsWith("javascript:") || ref.startsWith("https://example.com/"))
		return { shown: "link" };
	if (ref.endsWith("pull/500"))
		return {
			shown: "card",
			key: ref,
			name: "Unknown PR",
			connection: "github",
			service: "GitHub",
			at: Date.now(),
			old: false,
			card: {
				card: "pull-request",
				repo: "owner/repo",
				number: 500,
				title: "Partial daemon reading",
				state: "unknown",
				author: "",
				branch: "",
				checks: null,
				reviews: "Unavailable",
				added: null,
				removed: null,
				url: "javascript:alert(1)",
			},
		};
	const name = ref.includes("99") ? "Object-only check" : ref.includes("400") ? "owner/repo #400" : "owner/repo #34";
	const common = {
		key: ref,
		name,
		connection: "github",
		service: "GitHub",
		account: `@${account}`,
		at: Date.now(),
	};
	if (ref.endsWith("401")) return { shown: "connect", connection: "github" };
	if (ref.endsWith("400") && !refresh)
		return { shown: "failed", ...common, why: "GitHub refused this read. Check access and try again." };
	if (ref === "notification/7")
		return {
			shown: "card",
			...common,
			old: false,
			card: {
				card: "notification",
				reason: "review-requested",
				unread: true,
				title: "Notification subject",
				subject: pr,
			},
			subject: shown(pr, account, true),
		};
	if (ref.includes("actions"))
		return {
			shown: "card",
			...common,
			old: false,
			card: { card: "check-run", repo: "owner/repo", name, state: "running", where: "main", url: ref },
		};
	if (ref.includes("issues"))
		return {
			shown: "card",
			...common,
			old: false,
			card: {
				card: "issue",
				repo: "owner/repo",
				number: ref.endsWith("400") ? 400 : 35,
				title: refresh ? "Read after retry" : "Daemon issue title",
				state: "open",
				author: "ana",
				labels: ["bug"],
				comments: 2,
				url: ref,
			},
		};
	return {
		shown: "card",
		...common,
		old: !refresh,
		at: Date.now() - (refresh ? 0 : 7_200_000),
		card: {
			card: "pull-request",
			repo: longMetadata ? longRepo : "owner/repo",
			number: 34,
			title: longMetadata ? longTitle : refresh ? "Fresh daemon title" : "Daemon PR title",
			state: "open",
			author: "ana",
			branch: longBranch,
			checks: { passed: 3, failed: 1, running: 0 },
			reviews: "Ana requested changes",
			added: 24,
			removed: 5,
			url: pr,
		},
	};
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
	let body = "";
	for await (const chunk of req) body += String(chunk);
	return JSON.parse(body || "{}");
}
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
				name: "objects-browser-fixture",
				resolveId(id) {
					if (id === "/objects-fixture.tsx") return fixturePath;
				},
				load(id) {
					if (id !== fixturePath) return;
					return `import React, { StrictMode, useState } from 'react';
				import { createRoot } from 'react-dom/client';
				import { FeedView } from '/src/app/Feed.tsx';
				import { GroupChat } from '/src/app/GroupChat.tsx';
				import { view } from '/src/lib/chat.ts';
				import { ObjectReading } from '/src/app/Objects.tsx';
				import { showCapabilities } from '/src/lib/shell.ts';
				import '/src/styles/globals.css';
				const params = new URLSearchParams(location.search);
				document.documentElement.dataset.theme = params.get('theme') || 'light';
				if (params.has('connect')) showCapabilities(params.get('connect') === 'name' ? ${JSON.stringify(unsigned)} : ${JSON.stringify(capabilities(false))});
				window.showCapabilities = showCapabilities;
				const nearStale = { ...${JSON.stringify(shown(pr, "personal", true))}, at: Date.now() - 3598000 };
				function Fixture() {
				 const [n, setN] = useState(0);
				 return <><button onClick={() => setN(n + 1)}>Rerender {n}</button>{params.has('stale') ? <ObjectReading shown={nearStale} /> : params.has('group') ? <div style={{height:'90vh',display:'flex'}}><GroupChat room={20} phone={innerWidth < 768} agents={${JSON.stringify([who, { id: "mara", name: "Mara", face: defaultAvatarFace() }])}} onBack={() => {}} /></div> : <main style={{maxWidth:700,margin:'auto',padding:16,display:'flex',flexDirection:'column',gap:20}}><FeedView chat={10} agent="octo" who={${JSON.stringify(who)}} compact={innerWidth < 768} segments={view(params.has('owner') ? ${JSON.stringify(ownerItems)} : params.has('long') ? ${JSON.stringify(agentMessage(300, pr))} : params.has('interrupted') ? [] : params.has('connect') ? ${JSON.stringify(connectItems)} : params.has('edge') ? ${JSON.stringify(edgeItems)} : ${JSON.stringify(items)}, (params.has('owner') || params.has('edge') || params.has('connect') || params.has('long')) ? [] : [{key:params.has('interrupted') ? 'interrupted-direct' : 'comment-wait',ask:params.has('interrupted') ? ${JSON.stringify(interruptedApproval)} : ${JSON.stringify(approval)},deadline:Date.now()+60000}], {busy:false,running:[],thinking:false})} /></main>}</>;
				}
				createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);`;
				},
				configureServer(vite) {
					vite.middlewares.use((req, res, next) => {
						const path = (req.url ?? "").split("?")[0];
						if (path === "/objects-fixture") {
							void vite
								.transformIndexHtml(
									req.url ?? "",
									'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/objects-fixture.tsx"></script></body></html>',
								)
								.then((html) => {
									res.setHeader("content-type", "text/html");
									res.end(html);
								});
							return;
						}
						if (!path?.startsWith("/api/")) return next();
						void (async () => {
							if (path === "/api/events") {
								res.setHeader("content-type", "text/event-stream");
								res.write(": fixture\n\n");
								return;
							}
							if (path === "/api/skills") return json(res, []);
							if (path === "/api/groups/20")
								return json(
									res,
									recoveryGroup
										? {
												...group,
												messages: [],
												asks: [
													{
														agent: "mara",
														wait: { key: "interrupted-group", ask: interruptedApproval, deadline: Date.now() + 60_000 },
													},
												],
											}
										: group,
								);
							if (path === "/api/capabilities/connections/github/signin") return json(res, { page: "about:blank" });
							if (path === "/api/capabilities/connections/github/accounts/account-1/label") {
								answers.push({ path, body: await bodyOf(req) });
								return json(res, numberedSignIn("Work"));
							}
							if (path === "/api/capabilities/connections/github/accounts/personal/switch") {
								expect(await bodyOf(req)).toEqual({ agent: "octo", on: true });
								needsGrant = false;
								return json(res, capabilities(true));
							}
							if (path.startsWith("/api/waits/")) {
								const body = await bodyOf(req);
								if (
									path.includes("interrupted-") &&
									typeof body === "object" &&
									body !== null &&
									("edits" in body || "permission" in body)
								) {
									recoveryRefusals++;
									res.statusCode = 400;
									return json(res, { error: "running it again is approved once, as it was" });
								}
								answers.push({ path, body });
								return json(res, { chat: 10 });
							}
							if (path === "/api/objects") {
								const asked = (await bodyOf(req)) as Asked;
								requests.push(asked);
								await hold;
								if (needsGrant)
									return json(
										res,
										asked.asks.map(() => ({ shown: "connect", connection: "github" })),
									);
								if (!asked.refresh && asked.asks.some((ask) => "ref" in ask && ask.ref.endsWith("/503"))) {
									res.statusCode = 503;
									return json(res, { error: "service unavailable" });
								}
								return json(
									res,
									asked.asks.map((ask, index) =>
										index >= 3
											? { shown: "link" }
											: shown(
													"ref" in ask ? ask.ref : (ask.refs[0] ?? ""),
													"account" in ask ? ask.account : ask.agent === "mara" ? "mara-account" : "personal",
													asked.refresh,
												),
									),
								);
							}
							json(res, {});
						})().catch((error) => {
							res.statusCode = 500;
							json(res, { error: String(error) });
						});
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
	release?.();
	await server?.close();
});

for (const width of [390, 1280])
	for (const theme of ["light", "dark"]) {
		it.skipIf(!hasChrome())(
			`renders actual chat objects, manual refresh and exact approvals at ${width}px ${theme}`,
			async () => {
				requests = [];
				answers = [];
				hold = new Promise<void>((resolve) => {
					release = resolve;
				});
				await withPage(
					`${base}/objects-fixture?theme=${theme}#token=objects-test`,
					{ width, height: 900 },
					async (page) => {
						await page.until(`document.querySelector('[aria-label="Reading from GitHub"]')`);
						release?.();
						hold = undefined;
						await page.until(
							`document.body.textContent.includes('Daemon PR title') && document.body.textContent.includes('Object-only check')`,
						);
						await page.until(`document.querySelectorAll('[data-entry="1"] [data-object-inline]').length === 5`);
						expect(await page.run(`document.querySelectorAll('[data-entry="1"] [data-object]').length`)).toBe(0);
						expect(
							await page.run(
								`document.querySelectorAll('[data-entry="1"] [data-message-bubble] [data-object-inline]').length`,
							),
						).toBe(5);
						expect(await page.run(`document.querySelector('[data-entry="1"]').textContent`)).not.toContain("Checks:");
						expect(await page.run(`document.querySelector('[data-entry="1"] a[href="${pr}/files"]') !== null`)).toBe(
							true,
						);
						expect(await page.run(`document.querySelectorAll('[data-entry="2"] [data-object]').length`)).toBe(2);
						expect(await page.run(`document.querySelector('[data-entry="2"]').textContent`)).toContain(
							"Your review was requested",
						);
						expect(
							await page.run(
								`document.querySelector('[data-object="notification/7:@personal"]').querySelectorAll('button[aria-label^="Actions for"]').length`,
							),
						).toBe(1);
						expect(await page.run(`document.querySelector('[data-entry="1"]').textContent`)).toContain("Owner words");
						expect(await page.run(`document.body.textContent`)).toContain("Checks: 1 failing, 3 passed");
						expect(await page.run(`document.body.textContent`)).toContain("Ana requested changes");
						expect(await page.run(`document.body.textContent`)).toMatch(/Connect GitHub/i);
						expect(await page.run(`document.body.textContent`)).not.toContain("#undefined");
						expect(await page.run(`document.querySelector('[data-entry="1"] [data-object-inline]').textContent`)).toBe(
							"Daemon PR title",
						);
						expect(
							await page.run(`(() => {
							const ref = document.querySelector('[data-entry="1"] [data-object-inline]');
							const icons = ref.querySelectorAll('svg');
							return icons.length === 2 && icons[0].getAttribute('viewBox') === '0 0 16 16' && icons[1].classList.contains('lucide-git-pull-request');
						})()`),
						).toBe(true);
						expect(
							await page.run(`(() => {
							const ref = document.querySelector('[data-entry="1"] [data-object-inline]');
							const range = document.createRange();
							range.selectNodeContents(ref.parentElement.firstChild);
							const prose = range.getBoundingClientRect();
							range.selectNodeContents(ref.querySelector('a'));
							const title = range.getBoundingClientRect();
							const line = ref.querySelector('a').getBoundingClientRect();
							return Math.abs(prose.top - title.top) <= 1 && Array.from(ref.querySelectorAll('svg')).every(icon => {
								const box = icon.getBoundingClientRect();
								return Math.abs((box.top + box.bottom) / 2 - (line.top + line.bottom) / 2) <= 1;
							});
						})()`),
						).toBe(true);
						const initial = requests.length;
						expect(initial).toBe(6); // one request per message/draft, even with React StrictMode's effect replay
						expect(requests[0]?.asks.filter((ask) => "ref" in ask && ask.ref.startsWith(pr))).toHaveLength(1);
						await page.run(`document.querySelector('button').click()`);
						await page.until(`document.querySelector('button').textContent === 'Rerender 1'`);
						expect(requests).toHaveLength(initial);
						expect(
							await page.run(
								`Array.from(document.querySelectorAll('[data-entry="1"] button')).some(b => b.textContent === 'Refresh')`,
							),
						).toBe(false);
						expect(await page.run(`document.querySelector('[data-entry="2"]').textContent`)).not.toContain("Read as");
						await openObjectMenu(page, '[data-object="notification/7:@personal"] button[aria-label^="Actions for"]');
						expect(
							await page.run(
								`document.querySelector('[role="menu"]').textContent.match(/@personal on GitHub/g).length`,
							),
						).toBe(1);
						await closeObjectMenu(page);
						await refreshObject(page, '[data-entry="2"] button[aria-label^="Actions for"]', width > 390);
						await page.until(`!document.querySelector('[data-entry="2"]').textContent.includes('as of')`);
						expect(requests.at(-1)?.refresh).toBe(true);
						expect(requests.at(-1)?.asks).toHaveLength(1);
						expect(await page.run(`document.querySelector('[data-entry="2"]').textContent`)).not.toContain("as of");
						await page.run(`document.querySelector('button[aria-label="Retry owner/repo #400"]').click()`);
						await page.until(`document.querySelector('[data-entry="6"]').textContent.includes('Read after retry')`);
						expect(answers).toHaveLength(0); // reads and outbound links never approve a write
						expect(
							await page.run(
								`Array.from(document.querySelectorAll('a[aria-label="Open on GitHub"]')).every(a => a.href.startsWith('https://github.com/') && a.rel.includes('noreferrer') && a.target === '_blank')`,
							),
						).toBe(true);
						await page.run(
							`const field = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify("Owner edited exact bytes\nsecond line")}); field.dispatchEvent(new Event('input',{bubbles:true}));`,
						);
						await page.run(`document.querySelector('[role="checkbox"]').click()`);
						await page.run(
							`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Comment').click()`,
						);
						await page.until(
							`Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Comment' && !b.disabled)`,
						);
						expect(answers).toEqual([
							{
								path: "/api/waits/comment-wait",
								body: {
									answer: "approve",
									type: "approval",
									via: "web",
									edits: { body: "Owner edited exact bytes\nsecond line" },
									permission: { scope: "task" },
								},
							},
						]);
						expect(
							requests.some((request) => request.asks.some((ask) => "account" in ask && ask.account === "work")),
						).toBe(true);
						expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
						expect(page.errors()).toEqual([]);
					},
				);
			},
			60_000,
		);
	}

for (const width of [320, 390, 1440])
	for (const theme of ["light", "dark"]) {
		it.skipIf(!hasChrome())(
			`keeps long object metadata compact with accessible details at ${width}px ${theme}`,
			async () => {
				requests = [];
				answers = [];
				hold = undefined;
				longMetadata = true;
				try {
					await withPage(
						`${base}/objects-fixture?long=1&theme=${theme}#token=objects-test`,
						{ width, height: 900 },
						async (page) => {
							await page.until(`document.querySelector('[data-object-branch]')`);
							expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
							expect(
								await page.run(
									`(() => { const e=document.querySelector('[data-object-branch]'); const s=getComputedStyle(e); return s.textOverflow==='ellipsis' && s.whiteSpace==='nowrap' && e.scrollWidth>e.clientWidth && e.getBoundingClientRect().width<=innerWidth; })()`,
								),
							).toBe(true);
							expect(
								await page.run(
									`(() => { const e=document.querySelector('[data-object-location]'); return getComputedStyle(e).textOverflow==='ellipsis' && e.scrollWidth>e.clientWidth; })()`,
								),
							).toBe(true);
							expect(await page.run(`document.querySelector('[data-entry="300"]').textContent`)).toContain(longTitle);
							expect(await page.run(`document.querySelector('[data-entry="300"]').textContent`)).not.toContain(
								"Read as",
							);
							expect(await page.run(`document.querySelector('[data-entry="300"]').textContent`)).not.toContain(
								"Refresh",
							);
							await openObjectMenu(page, '[data-entry="300"] button[aria-label^="Actions for"]', width === 1440);
							expect(await page.run(`document.querySelector('[role="menu"]').textContent`)).toContain(longBranch);
							expect(await page.run(`document.querySelector('[role="menu"]').textContent`)).toContain(longRepo);
							expect(await page.run(`document.querySelector('[role="menu"]').textContent`)).toContain(
								"@personal on GitHub",
							);
							expect(await page.run(`document.querySelector('[role="menu"]').textContent`)).toContain("Read at");
							expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
							expect(requests).toHaveLength(1);
							await closeObjectMenu(page);
							hold = new Promise<void>((resolve) => {
								release = resolve;
							});
							await refreshObject(page, '[data-entry="300"] button[aria-label^="Actions for"]', width === 1440);
							await page.until(
								`document.querySelector('[data-entry="300"] button[aria-label^="Actions for"]').disabled`,
							);
							expect(
								await page.run(`document.querySelector('[data-entry="300"] [data-object]').getAttribute('aria-busy')`),
							).toBe("true");
							release?.();
							hold = undefined;
							await page.until(`!document.querySelector('[data-entry="300"]').textContent.includes('as of')`);
							expect(requests).toHaveLength(2);
							expect(requests[1]?.refresh).toBe(true);
							expect(answers).toHaveLength(0);
							expect(page.errors()).toEqual([]);
						},
					);
				} finally {
					longMetadata = false;
				}
			},
			60_000,
		);
	}

for (const width of [320, 1280])
	for (const theme of ["light", "dark"]) {
		it.skipIf(!hasChrome())(
			`keeps owner objects inline and fallbacks as links at ${width}px ${theme}`,
			async () => {
				requests = [];
				answers = [];
				hold = undefined;
				longMetadata = true;
				try {
					await withPage(
						`${base}/objects-fixture?owner=1&theme=${theme}#token=objects-test`,
						{ width, height: 900 },
						async (page) => {
							await page.until(
								`document.querySelectorAll('[data-entry="301"] [data-object-inline]').length === 2`,
								30_000,
							);
							expect(await page.run(`document.querySelectorAll('[data-object-previews]').length`)).toBe(0);
							expect(await page.run(`document.querySelector('[data-entry="301"] code').textContent`)).toBe(pr);
							expect(await page.run(`document.querySelector('[data-entry="301"]').textContent`)).toContain(
								"Approve and merge",
							);
							expect(await page.run(`document.querySelector('[data-entry="301"] [data-object-inline] a').title`)).toBe(
								longTitle,
							);
							expect(
								await page.run(`document.querySelector('[data-entry="301"] [data-object-inline]').textContent`),
							).toBe(longTitle);
							// an id has no page: its name opens its card; an id that reads as nothing is its words
							await page.until(`document.querySelector('[data-entry="306"] button [data-object-inline]') !== null`);
							expect(await page.run(`document.querySelector('[data-entry="306"]').textContent`)).toContain("this one");
							expect(await page.run(`document.querySelectorAll('[data-entry="306"] a').length`)).toBe(0);
							await page.run(`document.querySelector('[data-entry="306"] button').click()`);
							await page.until(
								`document.querySelector('[data-radix-popper-content-wrapper]')?.textContent.includes('Team offsite') === true`,
							);
							for (const id of [302, 303, 304, 305]) {
								expect(await page.run(`document.querySelector('[data-entry="${id}"] a') !== null`)).toBe(true);
								expect(
									await page.run(`document.querySelector('[data-entry="${id}"] [data-object-inline]') === null`),
								).toBe(true);
							}
							expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
							expect(
								await page.run(
									`Array.from(document.querySelectorAll('[data-object-inline]')).every(e => e.getBoundingClientRect().right <= innerWidth)`,
								),
							).toBe(true);
							expect(requests).toHaveLength(6);
							await page.run(`document.querySelector('button').click()`);
							await page.until(`document.querySelector('button').textContent === 'Rerender 1'`);
							expect(requests).toHaveLength(6);
							expect(answers).toHaveLength(0);
							expect(page.errors()).toEqual([]);
						},
					);
				} finally {
					longMetadata = false;
				}
			},
			60_000,
		);
	}

for (const grouped of [false, true])
	for (const action of ["Retry", "Skip"]) {
		it.skipIf(!hasChrome())(
			`interrupted ${grouped ? "group" : "direct"} approval keeps original bytes for ${action}`,
			async () => {
				requests = [];
				answers = [];
				hold = undefined;
				recoveryRefusals = 0;
				recoveryGroup = grouped;
				const key = grouped ? "interrupted-group" : "interrupted-direct";
				try {
					await withPage(
						`${base}/objects-fixture?interrupted=1${grouped ? "&group=1" : ""}#token=objects-test`,
						{ width: 390, height: 900 },
						async (page) => {
							await page.until(`document.body.textContent.includes('Original stored bytes')`);
							// The fake enforces core/wait's refusal: even an empty edits object is forbidden.
							expect(
								await page.run(
									`fetch('/api/waits/${key}', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answer:'approve',type:'approval',edits:{}})}).then(r=>r.status)`,
								),
							).toBe(400);
							expect(await page.run(`document.querySelectorAll('[data-slot="field"] textarea').length`)).toBe(0);
							expect(await page.run(`document.querySelectorAll('[role="checkbox"]').length`)).toBe(0);
							expect(await page.run(`document.body.textContent`)).toContain("The earlier attempt may have happened");
							expect(await page.run(`document.body.textContent`)).toContain("Original stored bytes\nsecond line");
							await page.run(
								`Array.from(document.querySelectorAll('button')).find(b => b.textContent === '${action}').click()`,
							);
							await page.until(
								`Array.from(document.querySelectorAll('button')).some(b => b.textContent === '${action}' && !b.disabled)`,
							);
							expect(recoveryRefusals).toBe(1);
							expect(answers).toEqual([
								{
									path: `/api/waits/${key}`,
									body: { answer: action === "Retry" ? "approve" : "deny", type: "approval", via: "web" },
								},
							]);
							expect(page.errors()).toEqual([]);
						},
					);
				} finally {
					recoveryGroup = false;
				}
			},
			60_000,
		);
	}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`the chat's connect card names an account its server did not, at ${width}`,
		async () => {
			answers = [];
			needsGrant = true;
			await withPage(
				`${base}/objects-fixture?connect=name#token=objects-test`,
				{ width, height: 900 },
				async (page) => {
					const card = `[...document.querySelectorAll('[data-object="connect:github"] button')].find(b => b.textContent === 'Connect GitHub')`;
					await page.until(card, 30_000);
					needsGrant = false;
					await page.run(`${card}.click()`);
					const signIn = `[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === 'Sign in')`;
					await page.until(signIn);
					await page.run(`${signIn}.click()`);
					await page.until(`document.querySelector('[role="dialog"][data-connect-step="starting"]') !== null`);
					await page.run(`window.showCapabilities(${JSON.stringify(numberedSignIn("github.example"))})`);
					// the dialog stays for the name instead of closing on the sign-in
					const named = `document.querySelector('[role="dialog"][data-connect-step="name"]')`;
					await page.until(named);
					expect(await page.run(`${named}.innerText.includes('keep github.example')`)).toBe(true);
					expect(await page.run(`/account \\d/i.test(document.body.innerText)`)).toBe(false);
					const input = `${named}.querySelector('input')`;
					expect(await page.run(`${input}.placeholder`)).toBe("github.example");
					await page.run(
						`(() => {const el=${input}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'Work'); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
					);
					await page.run(
						`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === 'Continue').click()`,
					);
					await page.until(`document.querySelector('[role="dialog"][data-connect-step]') === null`);
					expect(answers).toEqual([
						{ path: "/api/capabilities/connections/github/accounts/account-1/label", body: { label: "Work" } },
					]);
					expect(page.errors()).toEqual([]);
				},
			);
		},
		60_000,
	);

it.skipIf(!hasChrome())(
	"refreshes every ref represented by one connect card after one owner grant",
	async () => {
		requests = [];
		answers = [];
		hold = undefined;
		needsGrant = true;
		try {
			await withPage(
				`${base}/objects-fixture?connect=1#token=objects-test`,
				{ width: 390, height: 900 },
				async (page) => {
					await page.until(
						`Array.from(document.querySelectorAll('[data-object="connect:github"] button')).some(b => b.textContent === 'Connect GitHub')`,
						30_000,
					);
					expect(await page.run(`document.querySelectorAll('[data-object="connect:github"]').length`)).toBe(1);
					expect(requests).toHaveLength(1);
					// the card opens the connect dialog, which asks to share the account banda has
					await page.run(
						`Array.from(document.querySelectorAll('[data-object="connect:github"] button')).find(b => b.textContent === 'Connect GitHub').click()`,
					);
					await page.until(`document.querySelector('[role="dialog"][data-connect-step="share"]') !== null`);
					await page.run(
						`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Allow').click()`,
					);
					await page.until(`document.body.textContent.includes('GitHub connected')`);
					expect(requests).toHaveLength(1); // granting does not start a passive retry loop
					await page.run(`document.querySelector('[aria-label="Refresh preview"]').click()`);
					await page.until(`document.querySelectorAll('[data-entry="200"] [data-object]').length === 3`);
					expect(await page.run(`document.querySelector('[data-object="connect:github"]') === null`)).toBe(true);
					expect(requests).toHaveLength(2);
					expect(requests[1]?.refresh).toBe(true);
					expect(requests[1]?.asks).toHaveLength(3);
					expect(await page.run(`document.querySelector('[data-entry="200"]').textContent`)).toContain(
						"Fresh daemon title",
					);
					expect(await page.run(`document.querySelector('[data-entry="200"]').textContent`)).toContain(
						"Read after retry",
					);
					expect(await page.run(`document.querySelector('[data-entry="200"]').textContent`)).toContain("Running");
					expect(answers).toHaveLength(0);
					expect(page.errors()).toEqual([]);
				},
			);
		} finally {
			needsGrant = false;
		}
	},
	60_000,
);

it.skipIf(!hasChrome())(
	"ages a fresh reading on screen without making any network request",
	async () => {
		requests = [];
		answers = [];
		hold = undefined;
		await withPage(`${base}/objects-fixture?stale=1#token=objects-test`, { width: 390, height: 900 }, async (page) => {
			await page.until(`document.body.textContent.includes('Fresh daemon title')`);
			expect(await page.run(`document.body.textContent`)).not.toContain("as of");
			await page.until(`document.body.textContent.includes('as of')`);
			expect(requests).toHaveLength(0);
			expect(answers).toHaveLength(0);
			expect(page.errors()).toEqual([]);
		});
	},
	60_000,
);

it.skipIf(!hasChrome())(
	"preserves explicit unknown refs and recovers a network failure only on the owner's tap",
	async () => {
		requests = [];
		answers = [];
		hold = undefined;
		await withPage(`${base}/objects-fixture?edge=1#token=objects-test`, { width: 390, height: 900 }, async (page) => {
			await page.until(
				`document.body.textContent.includes('Preview unavailable') && document.body.textContent.includes("Couldn't read the previews")`,
				30_000,
			);
			expect(await page.run(`document.querySelector('[data-entry="100"]').textContent`)).toContain(unknownRef);
			expect(await page.run(`document.querySelector('[data-entry="100"]').textContent`)).toContain(
				"javascript:alert(1)",
			);
			expect(await page.run(`document.querySelectorAll('a[href^="javascript:"]').length`)).toBe(0);
			expect(await page.run(`document.querySelectorAll('a[aria-label="Open on GitHub"]').length`)).toBe(0);
			expect(await page.run(`document.querySelector('[data-entry="104"]').textContent`)).toContain(
				"Checks: Unavailable",
			);
			expect(await page.run(`document.querySelector('[data-entry="104"]').textContent`)).toContain("Diff unavailable");
			expect(await page.run(`document.querySelector('[data-entry="104"]').textContent`)).not.toContain("passed");
			expect(await page.run(`document.querySelector('[data-entry="104"]').textContent`)).not.toContain("as of");
			const initial = requests.length;
			await page.run(`document.querySelector('button').click()`);
			await page.until(`document.querySelector('button').textContent === 'Rerender 1'`);
			expect(requests).toHaveLength(initial);
			await page.run(
				`Array.from(document.querySelectorAll('[data-entry="102"] button')).find(b => b.textContent === 'Try again').click()`,
			);
			await page.until(`document.querySelector('[data-entry="102"]').textContent.includes('Read after retry')`);
			expect(requests).toHaveLength(initial + 1);
			expect(requests.at(-1)?.refresh).toBe(true);
			expect(answers).toHaveLength(0);
			expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
			expect(page.errors()).toEqual([]);
		});
	},
	60_000,
);

it.skipIf(!hasChrome())(
	"attributes group objects and drafts to the speaking member, including object-only messages",
	async () => {
		requests = [];
		answers = [];
		hold = undefined;
		await withPage(`${base}/objects-fixture?group=1#token=objects-test`, { width: 390, height: 900 }, async (page) => {
			await page.until(
				`document.body.textContent.includes('Daemon PR title') && document.querySelector('[data-entry="2"] button[aria-label^="Actions for"]')`,
				30_000,
			);
			expect(
				await page.run(
					`document.querySelectorAll('[data-entry="1"] [data-message-bubble] [data-object-inline]').length`,
				),
			).toBe(1);
			expect(await page.run(`document.querySelector('[data-entry="1"] [data-object-previews]') === null`)).toBe(true);
			expect(await page.run(`document.querySelector('[data-entry="2"]').textContent`)).not.toContain("Read as");
			await openObjectMenu(page, '[data-entry="2"] button[aria-label^="Actions for"]');
			expect(await page.run(`document.querySelector('[role="menu"]').textContent`)).toContain("@mara-account");
			await closeObjectMenu(page);
			expect(requests.every((request) => request.chat === 20)).toBe(true);
			expect(requests.some((request) => request.asks.some((ask) => ask.agent === "mara" && "ref" in ask))).toBe(true);
			expect(
				requests.some((request) =>
					request.asks.some((ask) => ask.agent === "octo" && "ref" in ask && ask.ref === check),
				),
			).toBe(true);
			expect(await page.run(`document.querySelector('[data-entry="3"] [data-object]') !== null`)).toBe(true);
			expect(await page.run(`document.querySelector('[data-entry="4"]').textContent`)).toContain(unknownRef);
			expect(requests.some((request) => request.asks.some((ask) => ask.agent === "retired"))).toBe(true);
			expect(await page.run(`document.body.textContent`)).toContain("as @work on GitHub");
			await page.run(
				`Array.from(document.querySelectorAll('button')).find(b => b.textContent === "Don't comment").click()`,
			);
			await page.until(
				`Array.from(document.querySelectorAll('button')).some(b => b.textContent === "Don't comment" && !b.disabled)`,
			);
			expect(answers[0]).toEqual({
				path: "/api/waits/group-wait",
				body: { answer: "deny", type: "approval", via: "web" },
			});
			expect(page.errors()).toEqual([]);
		});
	},
	60_000,
);
