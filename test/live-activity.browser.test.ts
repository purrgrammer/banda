/** The actual app against a temporary daemon, with faux model records, not a specimen or a mocked transcript. */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxThinking,
	fauxToolCall,
	getCurrentTools,
} from "@earendil-works/pi-ai";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentMainThread } from "../src/core/gateway.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ChatRow, GroupView, Item, ItemPage, Posted } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until, type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

let daemon: Daemon;
let web: WebServer;
let base: string;
let token: string;
let chat: number;
let room: number;
let firstMessage: number;
let api: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
let release: () => void = () => {};
let gate: Promise<void> | undefined;

/** Whether a draft's files in IndexedDB hold one named `name`; a promise, which `until` awaits. */
const keptFile = (name: string) =>
	`new Promise((resolve) => { const open = indexedDB.open('banda-drafts', 1); open.onerror = () => resolve(false); open.onsuccess = () => { try { const all = open.result.transaction('files').objectStore('files').getAll(); all.onsuccess = () => { resolve(all.result.some((files) => (files ?? []).some((file) => file.name === ${JSON.stringify(name)}))); open.result.close(); }; } catch { resolve(false); } }; })`;
let streamGate: Promise<void> | undefined;
let entered = false;
const thread = agentMainThread("sancho");
const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));
const post = (value: string) =>
	api<Extract<Posted, { turn: number }>>("/messages", { id: randomUUID(), thread, text: value });
async function allItems(id: number) {
	const result: Item[] = [];
	let before: number | undefined;
	for (;;) {
		const page = await api<ItemPage>(`/chats/${id}/items${before === undefined ? "" : `?before=${before}`}`);
		result.unshift(...page.items);
		if (page.next === undefined) return result;
		before = page.next;
	}
}
async function idle() {
	await until(async () => (await api<ChatRow[]>("/chats")).find((row) => row.chat === chat)?.state === "idle");
}
async function settled(value: string) {
	await until(
		async () =>
			(await allItems(chat)).some((item) => item.role === "user" && item.text === value) &&
			(await api<ChatRow[]>("/chats")).find((row) => row.chat === chat)?.state === "idle",
	);
}

beforeAll(async () => {
	if (!hasChrome()) return;
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const faux = fauxProvider({ tokensPerSecond: 4000, tokenSize: { min: 40, max: 40 } });
	const models = createModels();
	models.setProvider({
		...faux.provider,
		streamSimple(...args) {
			const source = faux.provider.streamSimple(...args);
			const waiting = streamGate;
			if (!waiting) return source;
			streamGate = undefined;
			const held = createAssistantMessageEventStream();
			void (async () => {
				for await (const event of source) {
					held.push(event);
					if (event.type === "toolcall_start") await waiting;
				}
			})();
			return held;
		},
	});
	faux.setResponses(
		Array.from({ length: 1000 }, () => async (request, options) => {
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			const input = [...request.messages].reverse().find((message) => message.role === "user");
			const marker = [...text(input?.content).matchAll(/(?:BROWSER|GROUP)_[A-Z0-9_]+/g)].at(-1)?.[0] ?? "request";
			const group = getCurrentTools(request.messages).some((tool) => tool.name === "message_group");
			if (last?.role === "toolResult" && (last.toolName === "message_user" || last.toolName === "message_group"))
				return fauxAssistantMessage("Recorded final model note.");
			if (last?.role === "user") {
				if (marker.endsWith("LIVE") && gate) {
					entered = true;
					// a held request ends when it is aborted, as a provider's does
					await Promise.race([
						gate,
						new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true })),
					]);
				}
				if (group)
					return fauxAssistantMessage(
						[fauxToolCall("message_group", { text: "An identical group reply." }, { id: "reused-group-call" })],
						{
							stopReason: "toolUse",
						},
					);
				return fauxAssistantMessage(
					[
						fauxThinking("Recorded provider thinking."),
						fauxToolCall("bash", { command: `printf 'activity-output' # ${"literal arguments ".repeat(30)}` }),
					],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage([fauxToolCall("message_user", { text: `Reply: ${marker}` })], {
				stopReason: "toolUse",
			});
		}),
	);
	daemon = await startDaemon({
		home,
		port: 0,
		models,
		box: hostBox(home),
		log: () => {},
		settings: { progress: { partialIntervalMs: 20 } },
	});
	token = (await readDaemonFile(home))!.token!;
	await skipShippedSkills(daemon.port, token);
	api = async <T>(path: string, body?: unknown, method?: string): Promise<T> => {
		const res = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
			method: method ?? (body === undefined ? "GET" : "POST"),
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
		return (await res.json()) as T;
	};
	await api("/companion", { name: "Sancho", personality: "Brief." }, "PUT");
	for (let n = 0; n < 12; n++) {
		chat = (await post(`BROWSER_SEED_${n}`)).chat;
		await settled(`BROWSER_SEED_${n}`);
		if (n === 0)
			firstMessage = (await allItems(chat)).find(
				(item) => item.role === "assistant" && item.calls?.some((call) => call.name === "message_user"),
			)!.id;
	}
	await api(
		"/agents/mara",
		{ text: "---\ndescription: Helps\ntools: [bash, read]\n---\nHelp the owner.\n", base: null },
		"PUT",
	);
	room = (await api<{ room: number }>("/groups", { members: ["sancho", "mara"], name: "Activity group" })).room;
	for (const value of ["GROUP_FIRST", "GROUP_SECOND"]) {
		await api(`/groups/${room}/messages`, { key: randomUUID(), text: value, mentions: ["sancho", "mara"] });
		await until(async () => {
			const group = await api<GroupView>(`/groups/${room}`);
			return (
				group.working.length === 0 &&
				group.messages.filter((message) => "agent" in message.author).length === (value === "GROUP_FIRST" ? 2 : 4)
			);
		});
	}
	web = await webServer({
		server: {
			proxy: {
				"/api": {
					target: `http://127.0.0.1:${daemon.port}`,
					changeOrigin: true,
					headers: { origin: `http://127.0.0.1:${daemon.port}` },
				},
				"^/(?:icon(?:-maskable)?\\.svg|icon-(?:192|512|maskable-512)\\.png|apple-touch-icon\\.png|manifest\\.webmanifest)$":
					{ target: `http://127.0.0.1:${daemon.port}`, changeOrigin: true },
			},
		},
	});
	base = web.origin;
}, 30000);
afterAll(async () => {
	release();
	await web?.close();
	await daemon?.close();
});

async function open(page: Page, hash: string) {
	await page.until(`localStorage.getItem('banda.token')`);
	await page.run(`location.hash='#/a/sancho'`);
	await page.until(`document.querySelector('[aria-label="View activity"]')`);
	await page.run(`location.hash=${JSON.stringify(hash)}`);
	await page.until(`document.querySelector('header')`);
}
async function drill(page: Page) {
	await page.until(`document.querySelector('[data-activity-timeline]')`);
	await page.run(`document.querySelector('[aria-label^="Inspect "]').click()`);
	await page.until(`document.querySelector('[aria-label="Tools"]')`);
}
async function close(page: Page) {
	await page.run(`document.querySelector('[data-slot="sheet-close"]').click()`);
	await page.until(`!document.querySelector('[role="dialog"]')`);
}
async function noOverflow(page: Page) {
	await page.until(`document.querySelector('[role="dialog"]').getBoundingClientRect().right <= innerWidth+1`);
	expect(
		await page.run(
			`document.documentElement.scrollWidth <= innerWidth && document.querySelector('[role="dialog"]').scrollWidth <= document.querySelector('[role="dialog"]').clientWidth+1`,
		),
	).toBe(true);
}

for (const width of [1440, 390, 320])
	it.skipIf(!hasChrome())(
		`live activity, historical paging and touch actions at ${width}px`,
		async () => {
			await withPage(`${base}/#token=${token}`, { width, height: 900 }, async (page) => {
				await open(page, `#/a/sancho?at=${firstMessage}`);
				await page.until(`document.querySelector('[data-entry="${firstMessage}"] [aria-label="View activity"]')`);
				const action = `document.querySelector('[data-entry="${firstMessage}"] [aria-label="View activity"]')`;
				if (width < 768) {
					const bubble = `${action}.closest('[class~="group/bubble"]')`;
					// Long press is handled on the bubble; click its revealed action, without adding another menu.
					await page.run(`${bubble}.scrollIntoView({block:'center'})`);
					const point = await page.run<{ x: number; y: number }>(
						`(()=>{const r=${bubble}.querySelector('[data-message-bubble]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
					);
					await page.input("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
					await page.until(`getComputedStyle(${action}).opacity==='1'`);
					await page.input("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
				} else {
					await page.run(`${action}.focus()`);
					await page.until(`getComputedStyle(${action}).opacity==='1'`);
				}
				await page.run(`${action}.click()`);
				await page.until(`document.querySelector('[data-activity-timeline]')?.textContent.includes('BROWSER_SEED_0')`);
				expect(
					await page.run(
						`document.querySelector('[data-activity-timeline]').textContent.includes('Running a command')`,
					),
				).toBe(true);
				await drill(page);
				expect(
					await page.run(
						`document.querySelector('[data-raw-content]').textContent.includes('BROWSER_SEED_0') && !document.querySelector('[data-raw-content]').textContent.includes('BROWSER_SEED_11')`,
					),
				).toBe(true);
				expect(
					await page.run(`document.querySelector('[aria-label="Tools"] button').getAttribute('aria-expanded')`),
				).toBe("false");
				await page.run(`document.querySelector('[aria-label="Tools"] button').click()`);
				expect(await page.run(`document.querySelector('[aria-label="Tools"]').textContent.includes('read')`)).toBe(
					true,
				);
				await page.run(
					`[...document.querySelectorAll('[data-raw-title]')].find(el=>el.textContent==='read').closest('button').click()`,
				);
				await page.until(`document.querySelector('[aria-label="Tools"]').textContent.includes('Parameters')`);
				await noOverflow(page);
				// A new live entry must not throw away the older pages shared with the open sheet.
				await post(`BROWSER_NEW_${width}`);
				await settled(`BROWSER_NEW_${width}`);
				expect(
					await page.run(`document.querySelector('[data-raw-content]')?.textContent.includes('BROWSER_SEED_0')`),
				).toBe(true);
				await page.run(
					`[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent.trim()==='Activity').click()`,
				);
				await page.until(`document.querySelector('[data-activity-timeline]')`);
				await close(page);
				expect(await page.run(`!!document.querySelector('[data-entry="${firstMessage}"]')`)).toBe(true);
				expect(page.errors()).toEqual([]);
			});
		},
		30000,
	);

it.skipIf(!hasChrome())(
	"working status streams into the same sheet, preserves focus and stays pinned when the next request starts",
	async () => {
		gate = new Promise((resolve) => {
			release = resolve;
		});
		entered = false;
		try {
			await withPage(`${base}/#token=${token}`, { width: 390, height: 900 }, async (page) => {
				await open(page, "#/a/sancho");
				await page.until(`document.querySelector('textarea')`);
				await page.run(
					`(()=>{const el=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'BROWSER_LIVE');el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
				);
				await page.run(`document.querySelector('textarea').closest('form').requestSubmit()`);
				await until(() => Promise.resolve(entered));
				await page.until(`document.querySelector('header [aria-label^="Activity:"]')`);
				await page.run(`document.querySelector('header [aria-label^="Activity:"]').click()`);
				await drill(page);
				await page.run(`document.querySelector('[data-slot="sheet-title"]').focus()`);
				release();
				gate = undefined;
				await idle();
				await page.until(`document.querySelector('[data-raw-content]')?.textContent.includes('bash result')`);
				expect(await page.run(`document.activeElement===document.querySelector('[data-slot="sheet-title"]')`)).toBe(
					true,
				);
				await page.run(
					`[...document.querySelectorAll('[data-raw-title]')].find(el=>el.textContent==='bash result').closest('button').click()`,
				);
				await page.until(`document.querySelector('[data-raw-content]').textContent.includes('activity-output')`);
				await noOverflow(page);
				await post("BROWSER_AFTER_LIVE");
				await settled("BROWSER_AFTER_LIVE");
				expect(
					await page.run(
						`document.querySelector('[data-raw-content]').textContent.includes('BROWSER_LIVE') && !document.querySelector('[data-raw-content]').textContent.includes('BROWSER_AFTER_LIVE')`,
					),
				).toBe(true);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			release();
			gate = undefined;
		}
	},
	30000,
);

it.skipIf(!hasChrome())(
	"keeps a streamed call's node, focus and context disclosures when it commits",
	async () => {
		streamGate = new Promise((resolve) => {
			release = resolve;
		});
		try {
			await post("BROWSER_FOCUS");
			await withPage(`${base}/#token=${token}`, { width: 390, height: 900 }, async (page) => {
				await open(page, "#/a/sancho");
				await page.until(`document.querySelector('header [aria-label^="Activity:"]')`);
				await page.run(`document.querySelector('header [aria-label^="Activity:"]').click()`);
				await drill(page);
				await page.until(
					`[...document.querySelectorAll('[data-raw-title]')].some(el=>el.textContent==='bash' && !el.closest('[aria-label="Tools"]'))`,
				);
				await page.run(
					`(()=>{window.contextNode=[...document.querySelectorAll('[data-raw-title]')].find(el=>el.textContent==='System prompt').closest('button');window.contextNode.click();window.callNode=[...document.querySelectorAll('[data-raw-title]')].find(el=>el.textContent==='bash' && !el.closest('[aria-label="Tools"]')).closest('button');window.callNode.click();window.callNode.focus();})()`,
				);
				release();
				await idle();
				await page.until(
					`document.querySelector('[data-raw-content]')?.textContent.includes('Recorded final model note.')`,
				);
				await page.until(
					`window.callNode.isConnected && document.activeElement===window.callNode && window.callNode.getAttribute('aria-expanded')==='false'`,
				);
				await page.until(`window.contextNode.isConnected && window.contextNode.getAttribute('aria-expanded')==='true'`);
				await noOverflow(page);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			release();
			streamGate = undefined;
		}
	},
	30000,
);

it.skipIf(!hasChrome())(
	"group replies select their exact member execution and call, not an identical later reply",
	async () => {
		await withPage(`${base}/#token=${token}`, { width: 320, height: 900 }, async (page) => {
			await open(page, `#/g/${room}`);
			await page.until(`document.querySelectorAll('[aria-label="View activity"]').length===4`);
			await page.run(`document.querySelector('[aria-label="View activity"]').click()`);
			await drill(page);
			expect(
				await page.run(
					`document.querySelector('[data-raw-content]').textContent.includes('GROUP_FIRST') && !document.querySelector('[data-raw-content]').textContent.includes('GROUP_SECOND')`,
				),
			).toBe(true);
			await noOverflow(page);
			await close(page);
			await page.run(`[...document.querySelectorAll('[aria-label="View activity"]')].at(-1).click()`);
			await drill(page);
			expect(
				await page.run(
					`document.querySelector('[data-raw-content]').textContent.includes('GROUP_SECOND') && !document.querySelector('[data-raw-content]').textContent.includes('GROUP_FIRST')`,
				),
			).toBe(true);
			await close(page);
			gate = new Promise((resolve) => {
				release = resolve;
			});
			entered = false;
			await api(`/groups/${room}/messages`, { key: randomUUID(), text: "GROUP_LIVE", mentions: ["sancho", "mara"] });
			await until(() => Promise.resolve(entered));
			await page.until(`document.querySelector('header [aria-label^="Activity:"]')`);
			await page.run(`document.querySelector('header [aria-label^="Activity:"]').click()`);
			await page.until(`document.querySelector('[aria-label="Agent activity"]')`);
			expect(await page.run(`document.querySelectorAll('[aria-label="Agent activity"] [role="tab"]').length`)).toBe(2);
			await page.run(`[...document.querySelectorAll('[aria-label="Agent activity"] [role="tab"]')].at(-1).click()`);
			await page.until(`document.querySelector('[data-activity-timeline]')?.textContent.includes('Activity group')`);
			await drill(page);
			await page.until(`document.querySelector('[data-raw-content]')?.textContent.includes('GROUP_LIVE')`);
			release();
			gate = undefined;
			await noOverflow(page);
			expect(page.errors()).toEqual([]);
		});
	},
	30000,
);

it.skipIf(!hasChrome())(
	"a message sent while the agent works shows at once as any message, and a second Enter on the emptied composer sends nothing",
	async () => {
		gate = new Promise((resolve) => {
			release = resolve;
		});
		entered = false;
		const field = `document.querySelector('textarea[name="message"]')`;
		const write = (value: string) =>
			`(()=>{const el=${field};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`;
		const button = (label: string) => `document.querySelector('form button[aria-label="${label}"]')`;
		const stop = `[...document.querySelectorAll('button')].some(el => el.textContent === 'Stop' || el.getAttribute('aria-label') === 'Stop')`;
		const bubble = `[...document.querySelectorAll('[data-slot], div')].find(el => el.textContent === 'BROWSER_STEER_NOTE')`;
		const labelled = `[...document.querySelectorAll('span')].some(el => el.textContent === 'Queued' || el.textContent === 'Waiting its turn')`;
		const dimmed = `(() => { for (let el = ${bubble}; el; el = el.parentElement) if (getComputedStyle(el).opacity !== '1') return true; return false; })()`;
		const enter = async (page: Page) => {
			await page.run(`${field}.focus()`);
			const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
			await page.input("Input.dispatchKeyEvent", { type: "keyDown", ...key });
			await page.input("Input.dispatchKeyEvent", { type: "keyUp", ...key });
		};
		try {
			await withPage(`${base}/#token=${token}`, { width: 1440, height: 900 }, async (page) => {
				await open(page, "#/a/sancho");
				await page.until(field);
				await page.run(write("BROWSER_STEER_LIVE"));
				await page.run(`${field}.closest('form').requestSubmit()`);
				await until(() => Promise.resolve(entered));
				// working, nothing written: Send is there but off, and there is no Stop anywhere
				await page.until(`${button("Send")}?.disabled === true`);
				expect(await page.run(stop)).toBe(false);
				await page.run(write("BROWSER_STEER_NOTE"));
				await page.until(`${button("Send")}?.disabled === false`);
				await enter(page);
				// behind the run: shown at once as any message, not dimmed and with no label, and the composer empty again
				await page.until(`${bubble} && ${field}.value === ''`);
				expect(await page.run(dimmed)).toBe(false);
				expect(await page.run(labelled)).toBe(false);
				// a second Enter, as a double tap lands once the composer has emptied: nothing more goes
				await enter(page);
				await new Promise((resolve) => setTimeout(resolve, 500));
				release();
				gate = undefined;
				await idle();
				// taken by the agent: still shown once, and no empty message went with it
				await page.until(bubble);
				expect(await page.run(labelled)).toBe(false);
				const owner = (await allItems(chat)).filter((item) => item.role === "user");
				expect(owner.filter((item) => item.text === "BROWSER_STEER_NOTE")).toHaveLength(1);
				expect(owner.filter((item) => (item.text ?? "").trim() === "" && (item.files ?? []).length === 0)).toEqual([]);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			release();
			gate = undefined;
		}
	},
	30000,
);

it.skipIf(!hasChrome())(
	"in a group while a member works: no Stop, the message joins the room at once, and the draft keeps its file",
	async () => {
		gate = new Promise((resolve) => {
			release = resolve;
		});
		entered = false;
		const field = `document.querySelector('textarea[name="message"]')`;
		const write = (value: string) =>
			`(()=>{const el=${field};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`;
		const button = (label: string) => `document.querySelector('form button[aria-label="${label}"]')`;
		const attached = `[...document.querySelectorAll('[data-attachment]')].map(el => el.dataset.attachment)`;
		try {
			await withPage(`${base}/#token=${token}`, { width: 390, height: 900 }, async (page) => {
				await open(page, `#/g/${room}`);
				await page.until(field);
				await api(`/groups/${room}/messages`, { key: randomUUID(), text: "GROUP_STEER_LIVE", mentions: ["sancho"] });
				await until(() => Promise.resolve(entered));
				// a member at work: the composer offers Send, off until something is written, and there is no Stop
				await page.until(`${button("Send")}?.disabled === true`);
				expect(
					await page.run(
						`[...document.querySelectorAll('button')].some(el => el.textContent === 'Stop' || el.getAttribute('aria-label') === 'Stop')`,
					),
				).toBe(false);
				await page.run(write("GROUP_STEER_NOTE"));
				// the draft, words and a file, survives a reload
				await page.run(`(() => {
					const input = document.querySelector('input[type="file"]');
					const files = new DataTransfer();
					files.items.add(new File(["seat 12A"], "group-notes.txt", { type: "text/plain" }));
					input.files = files.files;
					input.dispatchEvent(new Event("change", { bubbles: true }));
				})()`);
				await page.until(`${attached}.includes('group-notes.txt')`);
				// the draft is kept once its words are in localStorage and its file in IndexedDB: reloaded sooner, it is not
				await page.until(`Object.values(localStorage).includes('GROUP_STEER_NOTE') && ${keptFile("group-notes.txt")}`);
				// marked, so what is read next is the page the reload made, not the one it replaced
				await page.run(`window.beforeReload = true; location.reload()`);
				await page.until(`!window.beforeReload && document.readyState === 'complete'`);
				await page.until(`${field}?.value === 'GROUP_STEER_NOTE'`);
				await page.until(`${attached}.includes('group-notes.txt')`);
				// sent while the member works: in the room at once, the composer empty
				await page.run(`${button("Send")}.click()`);
				await page.until(
					`[...document.querySelectorAll('[data-entry]')].some(el => el.textContent.includes('GROUP_STEER_NOTE'))`,
				);
				await page.until(`${field}.value === '' && ${attached}.length === 0`);
				release();
				gate = undefined;
				expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			release();
			gate = undefined;
		}
	},
	30000,
);
