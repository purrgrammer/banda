import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import { type WebServer, webServer } from "./helpers.ts";
import { COMMAND_MS, hasChrome, openChrome } from "./smoke/chrome.ts";

const fixture = fileURLToPath(new URL("../web/message-layout-fixture.tsx", import.meta.url));
const at = Date.UTC(2026, 10, 4, 10, 42);
const words = [
	"Hi",
	"A longer owner message that wraps across several lines without colliding with its copy control or timestamp. ".repeat(
		4,
	),
];
const agents = [{ id: "mara", name: "Mara", face: defaultAvatarFace() }];
const longName = "Ana María de la Vega Ortega Fernández Hidalgo";
// the band as the shell says it, for a real 1:1 chat with Cervantes: nothing but AgentChat tells it who can be named
const shellAgents = [
	...agents,
	{ id: "ana", name: "Ana María", face: defaultAvatarFace() },
	{ id: "long", name: longName, face: defaultAvatarFace() },
	{ id: "cervantes", name: "Cervantes", face: defaultAvatarFace() },
].map((agent) => ({ name: agent.id, accepted: { sha: agent.id, text: "", agent: { ...agent, state: "active" } } }));
const directChat = 30;
const directText = `Ask @Mara, then @mara, and @Ana María about @${longName}, @Cervantes too, but not @Nobody.`;
const live = (event: object) => `data: ${JSON.stringify({ type: "live", chat: directChat, event })}\n\n`;
const groupMention = words.length + 2;
const group = {
	room: 20,
	name: "Layout group",
	members: ["mara"],
	working: [],
	at,
	latest: groupMention,
	read: groupMention,
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
		{ entry: groupMention, text: "Ask @Mara about it.", author: { owner: true }, mentions: ["mara"], at },
	],
};
let server: WebServer;
let base: string;

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
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
				import { AgentChat } from '/src/app/AgentChat.tsx'; import { showAgents } from '/src/lib/shell.ts';
				const who={name:'Mara',face:${JSON.stringify(defaultAvatarFace())}};
				showAgents(${JSON.stringify(shellAgents)});
				createRoot(document.getElementById('root')).render(<main style={{padding:16,maxWidth:1000,margin:'auto'}}>
				{${JSON.stringify(words)}.map((text,i)=><section id={'direct-'+i} key={i}><FeedView chat={10} who={who} compact={false} segments={[{kind:'owner',key:String(i+1),text,files:[],at:${at}}]} /></section>)}
				<div id="group" style={{height:1200,display:'flex'}}><GroupChat room={20} phone={innerWidth<768} agents={${JSON.stringify(agents)}} onBack={()=>{}} /></div>
				{[1,2,3].map(level=><section data-heading={level} key={level}><FeedView chat={10} who={who} compact={false} segments={[{kind:'companion',key:'h'+level,text:'#'.repeat(level)+' Leading heading\\n\\nParagraph\\n\\n'+'#'.repeat(level)+' Later heading',files:[],undelivered:false}]} /></section>)}
				<Mentionable.Provider value={${JSON.stringify(agents)}}>{[true,false].map(mine=><section data-mentions={mine?'owner':'agent'} key={String(mine)}><Bubble mine={mine}><Markdown>{'Ask [@Mara](#/a/mara) about [this page](https://example.com) and \`POST /coupon\`.'}</Markdown></Bubble></section>)}</Mentionable.Provider>
				<div className="banda-document">{[1,2,3].map(level=><section data-document={level} key={level}><Markdown>{'#'.repeat(level)+' Document heading'}</Markdown></section>)}</div>
				<div id="direct-chat" style={{height:800,display:'flex',position:'relative'}}><AgentChat agent="cervantes" who={{id:'cervantes',name:'Cervantes',face:${JSON.stringify(defaultAvatarFace())}}} row={{chat:${directChat},read:1,state:'idle'}} phone={innerWidth<768} panelOpen={false} onBack={()=>{}} onPanel={()=>{}} /></div>
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
							if ((req.url ?? "").includes(`chat=${directChat}`)) {
								res.write(live({ type: "ready", tail: 1, busy: false, partial: [], running: [] }));
								res.write(live({ type: "queued", queued: [{ id: "q1", text: "Later, @Mara." }] }));
							}
							return;
						}
						// a message being sent stays on its way, for the test to see it there
						if (path === "/api/messages") return;
						if (path?.startsWith("/api/")) {
							res.setHeader("content-type", "application/json");
							const items = { items: [{ id: 1, role: "user", text: directText, at }] };
							res.end(
								JSON.stringify(
									path === "/api/groups/20"
										? group
										: path === "/api/skills"
											? []
											: path === `/api/chats/${directChat}/items`
												? items
												: {},
								),
							);
							return;
						}
						next();
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

type LayoutPage = {
	run<T>(expression: string): Promise<T>;
	until(expression: string): Promise<void>;
	input(method: string, params: object): Promise<unknown>;
};
/** The same Chrome as smoke/chrome; adds real pointer and keyboard input for CSS hover/focus. */
async function withLayoutPage(width: number, use: (page: LayoutPage) => Promise<void>) {
	const chrome = await openChrome();
	try {
		const send = <T>(method: string, params: object = {}, sessionId?: string) =>
			chrome.cdp.send<T>(method, params, sessionId, COMMAND_MS);
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
		await chrome.stop();
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
		`every agent the owner names shows as a whole chip with its face, in a chat and a group, at ${width}px`,
		async () => {
			await withLayoutPage(width, async (page) => {
				const bubble = (words: string) =>
					`[...document.querySelectorAll('#direct-chat [data-message-bubble]')].find(b=>b.textContent.includes(${JSON.stringify(words)}))`;
				const chips = (root: string) => `[...${root}.querySelectorAll('a[href^="#/a/"]')]`;
				// each chip as it stands: its name's text, the agent its face names, the lines its words take, inside its bubble
				const read = (root: string) =>
					page.run<
						{ name: string; face: string; faceWidth: number; lines: number; inside: boolean }[]
					>(`${chips(root)}.map(chip=>{
						const words=chip.lastElementChild;
						const range=document.createRange();range.selectNodeContents(words);
						const face=chip.querySelector('[role="img"]');
						const box=chip.getBoundingClientRect(),holder=chip.closest('[data-message-bubble]').getBoundingClientRect();
						return {name:words.textContent,face:face.getAttribute('aria-label'),faceWidth:face.getBoundingClientRect().width,lines:new Set([...range.getClientRects()].map(r=>Math.round(r.top))).size,inside:box.right<=holder.right+0.5&&box.left>=holder.left-0.5};
					})`);
				const whole = (seen: Awaited<ReturnType<typeof read>>) => {
					for (const chip of seen) {
						expect(chip.face, JSON.stringify(chip)).toBe(chip.name);
						expect(chip.faceWidth, JSON.stringify(chip)).toBeGreaterThan(0);
						expect(chip.lines, JSON.stringify(chip)).toBe(1);
						expect(chip.inside, JSON.stringify(chip)).toBe(true);
					}
				};
				const taken = bubble("but not");
				await page.until(`${taken} && ${chips(taken)}.length===5`);
				const direct = await read(taken);
				// whatever the case it was typed in, under the agent's own name; this chat's own agent too
				expect(direct.map((chip) => chip.name)).toEqual(["Mara", "Mara", "Ana María", longName, "Cervantes"]);
				whole(direct);
				const said = await page.run<string>(`${taken}.textContent`);
				expect(said).toContain("@Nobody");
				expect(said).not.toContain("](#/a/");
				// Copy gives what the owner wrote, not the link drawn for the eye
				await page.run(
					`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{window.copied=t}}});${taken}.parentElement.querySelector('button[aria-label="Copy the message"]').click()`,
				);
				await page.until("window.copied");
				expect(await page.run<string>("window.copied")).toBe(directText);
				// on its way as much as taken: queued, and sending
				const queued = bubble("Later,");
				await page.until(`${queued} && ${chips(queued)}.length===1`);
				whole(await read(queued));
				await page.run(`document.querySelector('#direct-chat textarea').focus()`);
				await page.input("Input.insertText", { text: "Now @Mara" });
				await page.until(`!document.querySelector('#direct-chat button[aria-label="Send"]').disabled`);
				await page.run(`document.querySelector('#direct-chat button[aria-label="Send"]').click()`);
				const sending = bubble("Now");
				await page.until(`${sending} && ${chips(sending)}.length===1`);
				whole(await read(sending));
				const inGroup = `document.querySelector('#group [data-entry="${groupMention}"]')`;
				await page.until(`${inGroup} && ${chips(inGroup)}.length===1`);
				const named = await read(inGroup);
				expect(named.map((chip) => chip.name)).toEqual(["Mara"]);
				whole(named);
				expect(await page.run<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
			});
		},
		60_000,
	);
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
