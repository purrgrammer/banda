import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import { freePort, viteCacheDir } from "./helpers.ts";
import { CHROME, hasChrome } from "./smoke/chrome.ts";

const fixture = fileURLToPath(new URL("../web/message-layout-fixture.tsx", import.meta.url));
const at = Date.UTC(2026, 10, 4, 10, 42);
const words = [
	"Hi",
	"A longer owner message that wraps across several lines without colliding with its copy control or timestamp. ".repeat(
		4,
	),
];
const agents = [{ id: "mara", name: "Mara", face: defaultAvatarFace() }];
const group = {
	room: 20,
	name: "Layout group",
	members: ["mara"],
	working: [],
	at,
	latest: words.length + 1,
	read: words.length + 1,
	unread: 0,
	executions: { mara: 21 },
	asking: [],
	asks: [],
	notices: [],
	messages: [
		...words.map((text, i) => ({ entry: i + 1, text, author: { owner: true }, mentions: [], at })),
		// a member's message that published to the Library carries its card, then one it showed again by id
		{
			entry: words.length + 1,
			text: "Here is the landing.",
			author: { agent: "mara" },
			mentions: [],
			at,
			artifacts: [
				{ id: "a1b2c3d4e5f60718", n: 2, title: "banda landing", kind: "page" },
				{ id: "0f1e2d3c4b5a6978", n: 1, title: "Launch checklist", kind: "markdown" },
			],
		},
	],
};
let server: ViteDevServer;
let base: string;

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await createServer({
		configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
		cacheDir: await viteCacheDir(),
		server: { port: await freePort(), strictPort: true, host: "127.0.0.1", open: false },
		plugins: [
			{
				name: "message-layout-fixture",
				resolveId: (id) => (id === "/message-layout-fixture.tsx" ? fixture : undefined),
				load(id) {
					if (id !== fixture) return;
					return `import React from 'react'; import { createRoot } from 'react-dom/client';
				import { FeedView } from '/src/app/Feed.tsx'; import { GroupChat } from '/src/app/GroupChat.tsx';
				import { Markdown } from '/src/components/Markdown.tsx'; import '/src/styles/globals.css';
				import { Mentionable } from '/src/components/MentionChip.tsx';
				import { Bubble } from '/src/chat/Feed.tsx';
				const who={name:'Mara',face:${JSON.stringify(defaultAvatarFace())}};
				createRoot(document.getElementById('root')).render(<main style={{padding:16,maxWidth:1000,margin:'auto'}}>
				{${JSON.stringify(words)}.map((text,i)=><section id={'direct-'+i} key={i}><FeedView chat={10} who={who} compact={false} segments={[{kind:'owner',key:String(i+1),text,files:[],at:${at}}]} /></section>)}
				<div id="group" style={{height:1200,display:'flex'}}><GroupChat room={20} phone={innerWidth<768} agents={${JSON.stringify(agents)}} onBack={()=>{}} /></div>
				{[1,2,3].map(level=><section data-heading={level} key={level}><FeedView chat={10} who={who} compact={false} segments={[{kind:'companion',key:'h'+level,text:'#'.repeat(level)+' Leading heading\\n\\nParagraph\\n\\n'+'#'.repeat(level)+' Later heading',files:[],undelivered:false}]} /></section>)}
				<Mentionable.Provider value={${JSON.stringify(agents)}}>{[true,false].map(mine=><section data-mentions={mine?'owner':'agent'} key={String(mine)}><Bubble mine={mine}><Markdown>{'Ask [@Mara](#/a/mara) about [this page](https://example.com) and \`POST /coupon\`.'}</Markdown></Bubble></section>)}</Mentionable.Provider>
				<div className="banda-document">{[1,2,3].map(level=><section data-document={level} key={level}><Markdown>{'#'.repeat(level)+' Document heading'}</Markdown></section>)}</div>
				</main>);`;
				},
				configureServer(vite) {
					vite.middlewares.use((req, res, next) => {
						const path = (req.url ?? "").split("?")[0];
						if (path === "/message-layout") {
							void vite
								.transformIndexHtml(
									req.url ?? "",
									'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/message-layout-fixture.tsx"></script>',
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
							return;
						}
						if (path?.startsWith("/api/")) {
							res.setHeader("content-type", "application/json");
							res.end(JSON.stringify(path === "/api/groups/20" ? group : path === "/api/skills" ? [] : {}));
							return;
						}
						next();
					});
				},
			},
		],
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("fixture did not listen");
	base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
	await server?.close();
});

type LayoutPage = {
	run<T>(expression: string): Promise<T>;
	until(expression: string): Promise<void>;
	input(method: string, params: object): Promise<unknown>;
};
/** Same OS-assigned headless/CDP mechanism as smoke/chrome; adds real pointer and keyboard input for CSS hover/focus. */
async function withLayoutPage(width: number, use: (page: LayoutPage) => Promise<void>) {
	const profile = await mkdtemp(join(tmpdir(), "banda-message-layout-"));
	const chrome = spawn(
		CHROME,
		["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let socket: WebSocket | undefined;
	try {
		const endpoint = await new Promise<string>((resolve, reject) => {
			let output = "";
			chrome.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				const found = /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1];
				if (found) resolve(found);
			});
			chrome.once("exit", () => reject(new Error(output)));
		});
		socket = new WebSocket(endpoint);
		const ws = socket;
		await new Promise((resolve, reject) => {
			ws.onopen = resolve;
			ws.onerror = reject;
		});
		let next = 0;
		const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
		ws.onmessage = (event) => {
			const data = JSON.parse(String(event.data));
			const waiter = pending.get(data.id);
			if (!waiter) return;
			pending.delete(data.id);
			if (data.error) waiter.reject(new Error(data.error.message));
			else waiter.resolve(data.result);
		};
		const send = <T>(method: string, params: object = {}, sessionId?: string) =>
			new Promise<T>((resolve, reject) => {
				const id = ++next;
				pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
				ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			});
		const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
		const input = (method: string, params: object) => send(method, params, sessionId);
		await input("Emulation.setDeviceMetricsOverride", {
			width,
			height: 1000,
			deviceScaleFactor: 1,
			mobile: width < 768,
		});
		await input("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
		const run = async <T>(expression: string): Promise<T> => {
			const data = await send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
				"Runtime.evaluate",
				{ expression, awaitPromise: true, returnByValue: true },
				sessionId,
			);
			if (data.exceptionDetails) throw new Error(data.exceptionDetails.text);
			return data.result.value;
		};
		const page: LayoutPage = {
			run,
			input,
			until: async (expression) => {
				const end = Date.now() + 30000;
				while (!(await run(`Boolean(${expression})`))) {
					if (Date.now() > end) throw new Error(`timed out: ${expression}`);
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			},
		};
		await input("Page.navigate", { url: `${base}/message-layout#token=layout-test` });
		await page.until(
			`document.querySelector('[data-heading="3"] h3') && document.querySelector('#group [data-entry="2"] button[aria-label="Copy the message"]')`,
		);
		await run("document.fonts.ready.then(()=>true)");
		await use(page);
	} finally {
		socket?.close();
		chrome.kill();
		await rm(profile, { recursive: true, force: true }).catch(() => {});
	}
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`a member's artifacts show as cards in the group, each opening at its version at ${width}px`,
		async () => {
			await withLayoutPage(width, async (page) => {
				const entry = `#group [data-entry="${words.length + 1}"]`;
				await page.until(`document.querySelector(${JSON.stringify(entry)})?.textContent.includes('banda landing')`);
				expect(await page.run<string>(`document.querySelector(${JSON.stringify(entry)}).textContent`)).toContain(
					"Version 2",
				);
				await page.run(
					`[...document.querySelectorAll(${JSON.stringify(`${entry} button`)})].find(b=>b.textContent.trim()==='Open').click()`,
				);
				expect(await page.run<string>("location.hash")).toBe("#/artifact/a1b2c3d4e5f60718?v=2");
				// the one shown again: its own card, after the published one, fitting the width
				const cards = await page.run<string[]>(
					`[...document.querySelectorAll(${JSON.stringify(`${entry} button`)})].filter(b=>b.textContent.trim()==='Open').map(b=>b.closest('div').textContent)`,
				);
				expect(cards).toHaveLength(2);
				expect(cards[1]).toContain("Launch checklist");
				expect(await page.run<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
				await page.run(
					`[...document.querySelectorAll(${JSON.stringify(`${entry} button`)})].filter(b=>b.textContent.trim()==='Open')[1].click()`,
				);
				expect(await page.run<string>("location.hash")).toBe("#/artifact/0f1e2d3c4b5a6978?v=1");
			});
		},
		60_000,
	);

for (const width of [320, 390, 1440]) {
	it.skipIf(!hasChrome())(
		`mention chips and inline code keep readable ink in both themes at ${width}px`,
		async () => {
			await withLayoutPage(width, async (page) => {
				await page.until(`document.querySelector('[data-mentions] a[href="#/a/mara"]')`);
				for (const theme of ["light", "dark"]) {
					await page.run(`document.documentElement.className=${JSON.stringify(theme)}`);
					const colors = await page.run<{ contrast: number; code: number; plainInherits: boolean }[]>(`(() => {
						const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
						const ctx = canvas.getContext('2d');
						const luminance = color => {
							ctx.fillStyle = color; ctx.fillRect(0,0,1,1);
							const rgb = [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v => {
								v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
							});
							return rgb[0]*.2126 + rgb[1]*.7152 + rgb[2]*.0722;
						};
						const contrast = style => {
							const fg = luminance(style.color), bg = luminance(style.backgroundColor);
							return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
						};
						return [...document.querySelectorAll('[data-mentions]')].map(root => {
							return {contrast:contrast(getComputedStyle(root.querySelector('a[href="#/a/mara"]'))),
								code:contrast(getComputedStyle(root.querySelector('[data-streamdown="inline-code"], :not(pre) > code'))),
								plainInherits:getComputedStyle(root.querySelector('a[href^="https://example.com"]')).color === getComputedStyle(root.querySelector('[data-message-bubble]')).color};
						});
					})()`);
					for (const color of colors) {
						expect(color.contrast, `${theme}: ${JSON.stringify(color)}`).toBeGreaterThanOrEqual(4.5);
						expect(color.code, `${theme}: ${JSON.stringify(color)}`).toBeGreaterThanOrEqual(4.5);
						expect(color.plainInherits).toBe(true);
					}
				}
			});
		},
		60000,
	);
	it.skipIf(!hasChrome())(
		`leading headings keep bubble spacing, not document spacing, at ${width}px`,
		async () => {
			await withLayoutPage(width, async (page) => {
				for (const level of [1, 2, 3]) {
					const spacing = await page.run<{ first: number; padding: number; later: number; document: number }>(
						`(()=>{const headings=document.querySelectorAll('[data-heading="${level}"] h${level}');return {first:parseFloat(getComputedStyle(headings[0]).marginTop),padding:parseFloat(getComputedStyle(headings[0]).paddingTop),later:parseFloat(getComputedStyle(headings[1]).marginTop),document:parseFloat(getComputedStyle(document.querySelector('[data-document="${level}"] h${level}')).marginTop)};})()`,
					);
					expect(spacing).toEqual({
						first: 0,
						padding: 0,
						later: 24,
						document: level === 1 ? 0 : level === 2 ? 32 : 24,
					});
				}
			});
		},
		60000,
	);
	it.skipIf(!hasChrome())(
		`copy and timestamp never overlap or jump at ${width}px`,
		async () => {
			await withLayoutPage(width, async (page) => {
				for (const selector of ["#direct-0", "#direct-1", '#group [data-entry="1"]', '#group [data-entry="2"]']) {
					await page.run(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
					const measure = `(()=>{const root=document.querySelector(${JSON.stringify(selector)});const copy=root.querySelector('button[aria-label="Copy the message"]');const stamp=Array.from(root.querySelectorAll('span')).find(e=>e.textContent===new Date(${at}).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));const a=copy.getBoundingClientRect(),b=stamp.getBoundingClientRect(),r=root.getBoundingClientRect();return {overlap:a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top,copyY:a.top-r.top,timeY:b.top-r.top,height:r.height,copyX:a.left,copyTop:a.top,opacity:getComputedStyle(copy).opacity};})()`;
					const before = await page.run<{
						overlap: boolean;
						copyY: number;
						timeY: number;
						height: number;
						copyX: number;
						copyTop: number;
						opacity: string;
					}>(measure);
					expect(before.overlap, `${selector}: ${JSON.stringify(before)}`).toBe(false);
					const stable = async () =>
						expect(await page.run<typeof before>(measure)).toMatchObject({
							overlap: false,
							copyY: before.copyY,
							timeY: before.timeY,
							height: before.height,
						});
					await page.input("Input.dispatchMouseEvent", {
						type: "mouseMoved",
						x: before.copyX + 10,
						y: before.copyTop + 10,
					});
					await page.until(
						`getComputedStyle(document.querySelector(${JSON.stringify(selector)}+' button[aria-label="Copy the message"]')).opacity==='1'`,
					);
					await stable();
					await page.input("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
					await page.run(
						`document.querySelector(${JSON.stringify(selector)}+' button[aria-label="Copy the message"]').focus({preventScroll:true})`,
					);
					await page.input("Input.dispatchKeyEvent", {
						type: "keyDown",
						key: "Shift",
						code: "ShiftLeft",
						modifiers: 8,
					});
					await page.input("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft" });
					await page.until(
						`getComputedStyle(document.querySelector(${JSON.stringify(selector)}+' button[aria-label="Copy the message"]')).opacity==='1'`,
					);
					await stable();
					await page.run(
						`document.activeElement.blur();document.querySelector(${JSON.stringify(selector)}+' [class~="group/bubble"]').dispatchEvent(new PointerEvent('pointerdown',{pointerType:'touch',bubbles:true}))`,
					);
					await page.until(
						`document.querySelector(${JSON.stringify(selector)}+' button[aria-label="Copy the message"]').classList.contains('opacity-100')`,
					);
					await page.run(
						`document.querySelector(${JSON.stringify(selector)}+' [class~="group/bubble"]').dispatchEvent(new PointerEvent('pointerup',{pointerType:'touch',bubbles:true}))`,
					);
					const after = await page.run<typeof before>(measure);
					expect(after).toMatchObject({
						overlap: false,
						copyY: before.copyY,
						timeY: before.timeY,
						height: before.height,
					});
					expect(await page.run(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true);
				}
			});
		},
		60000,
	);
}
