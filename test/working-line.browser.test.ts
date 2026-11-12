/**
 * The working line in the actual app against a temporary daemon with a held faux model: a direct chat at desktop and
 * phone width, a group of two, and reduced motion. Each agent's run is held twice: before it says anything, and after
 * it said something, so the line can be seen to go at the first content while the turn still runs.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentMainThread } from "../src/core/gateway.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ChatRow, GroupView, Posted } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until, type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

let daemon: Daemon;
let web: WebServer;
let base: string;
let token: string;
let chat: number;
let room: number;
let api: <T>(path: string, body?: unknown, method?: string) => Promise<T>;

/** A hold on a run: requests wait on it while it is closed. */
type Gate = { promise: Promise<void>; open: () => void; held: number };
const gate = (): Gate => {
	let open: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open, held: 0 };
};
/** Per agent: held before it says anything, and after it said something, before its turn ends. */
let before = new Map<string, Gate>();
let after = new Map<string, Gate>();
const holdAll = () => {
	before = new Map([
		["sancho", gate()],
		["mara", gate()],
	]);
	after = new Map([
		["sancho", gate()],
		["mara", gate()],
	]);
};
const letAllGo = () => {
	for (const each of [...before.values(), ...after.values()]) each.open();
	before = new Map();
	after = new Map();
};
const thread = agentMainThread("sancho");
const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));
const post = (value: string) =>
	api<Extract<Posted, { turn: number }>>("/messages", { id: randomUUID(), thread, text: value });
const idle = () =>
	until(async () => (await api<ChatRow[]>("/chats")).find((row) => row.chat === chat)?.state === "idle");

beforeAll(async () => {
	if (!hasChrome()) return;
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const faux = fauxProvider({ tokensPerSecond: 4000, tokenSize: { min: 40, max: 40 } });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 200 }, () => async (request) => {
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			const input = [...request.messages].reverse().find((message) => message.role === "user");
			const marker = [...text(input?.content).matchAll(/LINE_[A-Z0-9_]+/g)].at(-1)?.[0] ?? "request";
			const agent = JSON.stringify(request).includes("MARA_INSTRUCTIONS") ? "mara" : "sancho";
			const live = marker.endsWith("LIVE");
			if (last?.role === "toolResult") {
				const held = live ? after.get(agent) : undefined;
				if (held) {
					held.held++;
					await held.promise;
				}
				return fauxAssistantMessage("Done.");
			}
			const held = live ? before.get(agent) : undefined;
			if (held) {
				held.held++;
				await held.promise;
			}
			const group = getCurrentTools(request.messages).some((tool) => tool.name === "message_group");
			return fauxAssistantMessage(
				[fauxToolCall(group ? "message_group" : "message_user", { text: `Reply from ${agent}: ${marker}` })],
				{ stopReason: "toolUse" },
			);
		}),
	);
	daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), log: () => {} });
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
	chat = (await post("LINE_SEED")).chat;
	await idle();
	await api(
		"/agents/mara",
		{ text: "---\nname: Mara\ndescription: Helps\ntools: [read]\n---\nMARA_INSTRUCTIONS.\n", base: null },
		"PUT",
	);
	room = (await api<{ room: number }>("/groups", { members: ["sancho", "mara"], name: "Line group" })).room;
	web = await webServer({
		server: {
			proxy: {
				"/api": {
					target: `http://127.0.0.1:${daemon.port}`,
					changeOrigin: true,
					headers: { origin: `http://127.0.0.1:${daemon.port}` },
				},
			},
		},
	});
	base = web.origin;
}, 60_000);
afterAll(async () => {
	letAllGo();
	await web?.close();
	await daemon?.close();
});

/** A page whose waits fail inside the test's time, naming what never came. */
const withLinePage = (width: number, use: (page: Page) => Promise<void>) =>
	withPage(`${base}/#token=${token}`, { width, height: 900 }, (raw) =>
		use({ ...raw, until: (expression, ms = 20_000) => raw.until(expression, ms) }),
	);
const line = `document.querySelector('[data-working-line]')`;
const lineButton = `document.querySelector('[data-working-line] button')`;
const dialog = `document.querySelector('[role="dialog"]')`;
/** The header says nothing of work: no words, and no face moving. */
const headerQuiet = `!/working/i.test(document.querySelector('header').innerText) && !document.querySelector('header [data-state="working"]')`;
async function open(page: Page, hash: string) {
	await page.until(`localStorage.getItem('banda.token')`);
	await page.run(`location.hash=${JSON.stringify(hash)}`);
	await page.until(`document.querySelector('textarea[name="message"]')`);
}
async function close(page: Page) {
	await page.run(`document.querySelector('[data-slot="sheet-close"]').click()`);
	await page.until(`!${dialog}`);
}

for (const width of [1440, 390])
	it.skipIf(!hasChrome())(
		`a chat: face and Working… while it shows nothing, gone at its first content with the turn still running, at ${width}px`,
		async () => {
			holdAll();
			try {
				await withLinePage(width, async (page) => {
					await open(page, "#/a/sancho");
					const marker = `LINE_${width}_LIVE`;
					await post(marker);
					await until(() => Promise.resolve(before.get("sancho")?.held === 1));
					await page.until(`document.body.innerText.includes('${marker}') && ${lineButton}`);
					// the face and the words on one line, named for who works; the header says nothing of it
					expect(await page.run(`${lineButton}.getAttribute('aria-label')`)).toBe("Sancho is working");
					expect(await page.run(`${line}.innerText.trim()`)).toBe("Working…");
					expect(
						await page.run(
							`(()=>{const f=${line}.querySelector('[role="img"]').getBoundingClientRect(),w=[...${line}.querySelectorAll('span')].find(s=>s.textContent==='Working…').getBoundingClientRect();return Math.abs((f.top+f.height/2)-(w.top+w.height/2))<6 && w.left>f.right})()`,
						),
					).toBe(true);
					expect(await page.run(`${line}.querySelector('[role="img"]').dataset.state`)).toBe("working");
					expect(await page.run(`${lineButton}.getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
					expect(await page.run(headerQuiet)).toBe(true);
					// a tap opens the activity; closing it hands focus back to the line
					await page.run(`${lineButton}.focus()`);
					await page.run(`${lineButton}.click()`);
					await page.until(`${dialog}?.querySelector('[data-activity-timeline]')`);
					await close(page);
					await page.until(`document.activeElement === ${lineButton}`);
					// The first reply removes Working even while the agent continues. Other feed items can stay in place.
					before.get("sancho")?.open();
					await until(() => Promise.resolve(after.get("sancho")?.held === 1));
					await page.until(`document.body.innerText.includes('Reply from sancho: ${marker}')`);
					expect(await page.run(`!${line}`)).toBe(true);
					expect((await api<ChatRow[]>("/chats")).find((row) => row.chat === chat)?.state).not.toBe("idle");
					expect(await page.run(headerQuiet)).toBe(true);
					after.get("sancho")?.open();
					await idle();
					expect(await page.run(`!${line}`)).toBe(true);
					// no face on the reply, then or after a reload
					// the reply's own run in the feed's list: the part of the feed that holds it and not the owner's words before it
					const replyFaces = `(()=>{const of=(t)=>[...document.querySelectorAll('[data-message-bubble]')].find(b=>b.innerText.includes(t));const asked=of('${marker}');let n=of('Reply from sancho: ${marker}');while(!n.parentElement.contains(asked))n=n.parentElement;return n.querySelectorAll('[role="img"]').length})()`;
					expect(await page.run(replyFaces)).toBe(0);
					await page.run(`location.reload()`);
					await page.until(`document.body.innerText.includes('Reply from sancho: ${marker}')`);
					expect(await page.run(replyFaces)).toBe(0);
					expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				letAllGo();
				await idle();
			}
		},
		60_000,
	);

it.skipIf(!hasChrome())(
	"a group: one line with every member at work, each leaving it when its own content arrives",
	async () => {
		holdAll();
		try {
			await withLinePage(390, async (page) => {
				await open(page, `#/g/${room}`);
				await api(`/groups/${room}/messages`, {
					key: randomUUID(),
					text: "LINE_GROUP_LIVE",
					mentions: ["sancho", "mara"],
				});
				await until(() => Promise.resolve(before.get("sancho")?.held === 1 && before.get("mara")?.held === 1));
				await page.until(
					`${lineButton}?.getAttribute('aria-label') === 'Sancho and Mara are working' || ${lineButton}?.getAttribute('aria-label') === 'Mara and Sancho are working'`,
				);
				expect(await page.run(`document.querySelectorAll('[data-working-line]').length`)).toBe(1);
				expect(await page.run(`${line}.querySelectorAll('[data-slot="avatar"]').length`)).toBe(2);
				expect(await page.run(`${line}.innerText.trim()`)).toBe("Working…");
				expect(await page.run(headerQuiet)).toBe(true);
				// a tap opens both members' activity, one tab each; focus comes back to the line
				await page.run(`${lineButton}.focus()`);
				await page.run(`${lineButton}.click()`);
				await page.until(`document.querySelectorAll('[aria-label="Agent activity"] [role="tab"]').length === 2`);
				await close(page);
				await page.until(`document.activeElement === ${lineButton}`);
				// Mara says something and goes on working: she leaves the line, Sancho stays on it
				before.get("mara")?.open();
				await until(() => Promise.resolve(after.get("mara")?.held === 1));
				await page.until(`document.body.innerText.includes('Reply from mara: LINE_GROUP_LIVE')`);
				await page.until(`${lineButton}?.getAttribute('aria-label') === 'Sancho is working'`);
				expect(await page.run(`${line}.querySelectorAll('[data-slot="avatar"]').length`)).toBe(1);
				expect((await api<GroupView>(`/groups/${room}`)).working).toContain("mara");
				// then Sancho: nobody is left, and the line goes while both are still at work
				before.get("sancho")?.open();
				await until(() => Promise.resolve(after.get("sancho")?.held === 1));
				await page.until(`document.body.innerText.includes('Reply from sancho: LINE_GROUP_LIVE')`);
				await page.until(`!${line}`);
				expect((await api<GroupView>(`/groups/${room}`)).working.length).toBe(2);
				expect(await page.run(headerQuiet)).toBe(true);
				letAllGo();
				await until(async () => (await api<GroupView>(`/groups/${room}`)).working.length === 0);
				expect(await page.run(`!${line}`)).toBe(true);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			letAllGo();
		}
	},
	60_000,
);

it.skipIf(!hasChrome())(
	"the line's face moves while the agent works, and stays still under reduced motion",
	async () => {
		holdAll();
		try {
			await withLinePage(1440, async (page) => {
				await open(page, "#/a/sancho");
				await post("LINE_MOTION_LIVE");
				await until(() => Promise.resolve(before.get("sancho")?.held === 1));
				await page.until(line);
				const drawing = `${line}.querySelector('[role="img"]').innerHTML`;
				await page.until(`${line}.querySelector('[role="img"] canvas, [role="img"] svg')`);
				// waited on, since the live scene mounts only once the face is seen on screen; three drawings are the still
				// one, the live scene, and a pose it moved to
				await page.until(
					`(()=>{window.drawings??=new Set();window.drawings.add(${drawing});return window.drawings.size>=3})()`,
				);
				await page.input("Emulation.setEmulatedMedia", {
					features: [{ name: "prefers-reduced-motion", value: "reduce" }],
				});
				await page.run(`location.reload()`);
				await page.until(line);
				await page.until(`${line}.querySelector('[role="img"] canvas, [role="img"] svg')`);
				// past the swap from the still drawing to the live scene, nothing changes
				await new Promise((resolve) => setTimeout(resolve, 1000));
				const seen = new Set<string>();
				for (let n = 0; n < 12; n++) {
					seen.add(await page.run<string>(drawing));
					await new Promise((resolve) => setTimeout(resolve, 120));
				}
				expect(seen.size, "with reduced motion the face is still").toBe(1);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			letAllGo();
			await idle();
		}
	},
	60_000,
);

for (const width of [1440, 390])
	it.skipIf(!hasChrome())(
		`a message sent while the agent works appears above Working… at ${width}px`,
		async () => {
			holdAll();
			try {
				await withLinePage(width, async (page) => {
					await open(page, "#/a/sancho");
					await post(`LINE_${width}_ORDER_LIVE`);
					await page.until(lineButton);
					const followUp = `LINE_${width}_FOLLOW_UP`;
					await page.run(`(() => {
						const field = document.querySelector('textarea[name="message"]');
						Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '${followUp}');
						field.dispatchEvent(new Event('input', { bubbles: true }));
					})()`);
					const send = `document.querySelector('form button[aria-label="Send"]')`;
					await page.until(`${send} && !${send}.disabled`);
					await page.run(`${send}.click()`);
					const queued = `[...document.querySelectorAll('[data-message-bubble]')].find(b=>b.innerText === '${followUp}')`;
					await page.until(`${queued} && ${line}`);
					expect(
						await page.run(
							`${queued}.getBoundingClientRect().bottom <= ${line}.getBoundingClientRect().top && ${line}.parentElement.lastElementChild === ${line}`,
						),
					).toBe(true);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				letAllGo();
				await idle();
			}
		},
		60_000,
	);
