/** The working face in the actual app against a temporary daemon with a held faux model: 1:1, group, reduced motion. */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentMainThread } from "../src/core/gateway.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ChatRow, GroupView, Posted } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { freePort, skipShippedSkills, tempHome, until, viteCacheDir } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

let daemon: Daemon;
let web: ViteDevServer;
let base: string;
let token: string;
let chat: number;
let room: number;
let api: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
let release: () => void = () => {};
let gate: Promise<void> | undefined;
let held = 0;
const thread = agentMainThread("sancho");
const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));
const post = (value: string) =>
	api<Extract<Posted, { turn: number }>>("/messages", { id: randomUUID(), thread, text: value });
const hold = () => {
	held = 0;
	gate = new Promise((resolve) => {
		release = resolve;
	});
};
const letGo = () => {
	release();
	gate = undefined;
};
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
			const marker = [...text(input?.content).matchAll(/FACE_[A-Z0-9_]+/g)].at(-1)?.[0] ?? "request";
			if (last?.role === "toolResult") return fauxAssistantMessage("Done.");
			if (marker.endsWith("LIVE") && gate) {
				held++;
				await gate;
			}
			const group = getCurrentTools(request.messages).some((tool) => tool.name === "message_group");
			return fauxAssistantMessage(
				[fauxToolCall(group ? "message_group" : "message_user", { text: `Reply: ${marker}` })],
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
	chat = (await post("FACE_SEED")).chat;
	await idle();
	await api(
		"/agents/mara",
		{ text: "---\ndescription: Helps\ntools: [bash, read]\n---\nHelp the owner.\n", base: null },
		"PUT",
	);
	room = (await api<{ room: number }>("/groups", { members: ["sancho", "mara"], name: "Face group" })).room;
	web = await createServer({
		configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
		cacheDir: await viteCacheDir(),
		server: {
			host: "127.0.0.1",
			port: await freePort(),
			strictPort: true,
			open: false,
			proxy: {
				"/api": {
					target: `http://127.0.0.1:${daemon.port}`,
					changeOrigin: true,
					headers: { origin: `http://127.0.0.1:${daemon.port}` },
				},
			},
		},
	});
	await web.listen();
	const address = web.httpServer!.address();
	if (!address || typeof address === "string") throw new Error("web did not listen");
	base = `http://127.0.0.1:${address.port}`;
}, 60_000);
afterAll(async () => {
	letGo();
	await web?.close();
	await daemon?.close();
});

/** A page whose waits fail inside the test's time, naming what never came. */
const withFacePage = (width: number, use: (page: Page) => Promise<void>) =>
	withPage(`${base}/#token=${token}`, { width, height: 900 }, (raw) =>
		use({ ...raw, until: (expression, ms = 20_000) => raw.until(expression, ms) }),
	);
const face = (name: string) => `document.querySelector('button[aria-label="${name} is working"]')`;
const dialog = `document.querySelector('[role="dialog"]')`;
async function open(page: Page, hash: string) {
	await page.until(`localStorage.getItem('banda.token')`);
	await page.run(`location.hash=${JSON.stringify(hash)}`);
	await page.until(`document.querySelector('textarea[name="message"]')`);
}
async function close(page: Page) {
	await page.run(`document.querySelector('[data-slot="sheet-close"]').click()`);
	await page.until(`!${dialog}`);
}
/** The focus was handed back, after Radix's own tidying: the same element, a moment later. */
const focused = (page: Page, expression: string) =>
	page.until(`document.activeElement !== document.body && document.activeElement === ${expression}`);

for (const width of [1440, 390])
	it.skipIf(!hasChrome())(
		`a chat: the face alone while the agent works, its sheet, then the reply beside the same face at ${width}px`,
		async () => {
			hold();
			try {
				await withFacePage(width, async (page) => {
					await open(page, "#/a/sancho");
					const marker = `FACE_${width}_LIVE`;
					await post(marker);
					await until(() => Promise.resolve(held === 1));
					// the owner's words are in the feed: the run the face stands on is the one the reply will come to
					await page.until(`document.body.innerText.includes('${marker}') && ${face("Sancho")}`);
					const slot = `${face("Sancho")}.parentElement`;
					await page.run(`(window.slot=${slot},true)`);
					// one face in the whole feed: earlier replies stay as they were
					expect(await page.run(`document.querySelectorAll('[data-run-face]').length`)).toBe(1);
					// the face alone: 28px, no words and no dots in its run
					expect(await page.run(`window.slot.parentElement.innerText.trim()`)).toBe("");
					await page.until(`window.slot.querySelector('[role="img"]').getBoundingClientRect().width === 28`);
					expect(await page.run(`window.slot.querySelector('[role="img"]').dataset.state`)).toBe("working");
					// a comfortable target, the face at the foot of the feed, and the header still says the work
					expect(await page.run(`${face("Sancho")}.getBoundingClientRect().width`)).toBeGreaterThanOrEqual(44);
					await page.until(`document.querySelector('header').innerText.includes('…')`);
					await page.run(`${face("Sancho")}.focus()`);
					await page.run(`${face("Sancho")}.click()`);
					await page.until(`${dialog}?.querySelector('[data-activity-timeline]')`);
					expect(await page.run(`${dialog}.innerText.includes('Activity')`)).toBe(true);
					await close(page);
					await focused(page, face("Sancho"));
					// again, and the work ends behind the open sheet: focus has the face's slot to come back to
					await page.run(`${face("Sancho")}.click()`);
					await page.until(`${dialog}?.querySelector('[data-activity-timeline]')`);
					letGo();
					await idle();
					await page.until(`!${face("Sancho")}`);
					await close(page);
					await focused(page, "window.slot");
					// no jump: the reply came to the very element the indicator was, resting now
					await page.until(
						`window.slot.isConnected && window.slot.parentElement.innerText.includes('Reply: ${marker}')`,
					);
					expect(await page.run(`window.slot.querySelector('[role="img"]').dataset.state`)).toBe("idle");
					expect(await page.run(`document.querySelectorAll('[data-run-face="working"]').length`)).toBe(0);
					const beside = await page.run<{ face: number; bubble: number }>(
						`(()=>{const f=window.slot.getBoundingClientRect(),b=window.slot.parentElement.querySelector('[data-message-bubble]').getBoundingClientRect();return {face:f.right,bubble:b.left}})()`,
					);
					expect(beside.face).toBeLessThanOrEqual(beside.bubble);
					expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				letGo();
			}
		},
		60_000,
	);

it.skipIf(!hasChrome())(
	"a group: one face for each member at work, each opening its own activity",
	async () => {
		hold();
		try {
			await withFacePage(390, async (page) => {
				await open(page, `#/g/${room}`);
				await api(`/groups/${room}/messages`, {
					key: randomUUID(),
					text: "FACE_GROUP_LIVE",
					mentions: ["sancho", "mara"],
				});
				await until(() => Promise.resolve(held === 2));
				await page.until(`${face("Sancho")} && ${face("mara")}`);
				await page.run(`(window.slot=${face("mara")}.parentElement,true)`);
				await page.run(`${face("mara")}.focus()`);
				await page.run(`${face("mara")}.click()`);
				await page.until(`${dialog}?.querySelector('[data-activity-timeline]')`);
				expect(await page.run(`${dialog}.innerText.includes('mara')`)).toBe(true);
				expect(await page.run(`!!document.querySelector('[aria-label="Agent activity"]')`)).toBe(false);
				await close(page);
				await focused(page, face("mara"));
				letGo();
				await until(async () => (await api<GroupView>(`/groups/${room}`)).working.length === 0);
				await page.until(`!${face("Sancho")} && !${face("mara")}`);
				// no jump: mara's reply is the element its face was
				await page.until(
					`window.slot.isConnected && window.slot.closest('[data-entry]')?.innerText.includes('Reply: FACE_GROUP_LIVE')`,
				);
				expect(await page.run(`window.slot.closest('[data-entry]').innerText.includes('mara')`)).toBe(true);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			letGo();
		}
	},
	60_000,
);

const frames = async (page: Page, expression: string) => {
	// past the swap from the still drawing to the live scene: the same pose in other markup
	await new Promise((resolve) => setTimeout(resolve, 1000));
	const seen = new Set<string>();
	for (let n = 0; n < 12; n++) {
		seen.add(await page.run<string>(expression));
		await new Promise((resolve) => setTimeout(resolve, 120));
	}
	return seen.size;
};

it.skipIf(!hasChrome())(
	"the face moves while the agent works, and stays still under reduced motion",
	async () => {
		hold();
		try {
			await withFacePage(1440, async (page) => {
				await open(page, "#/a/sancho");
				await post("FACE_MOTION_LIVE");
				await until(() => Promise.resolve(held === 1));
				await page.until(face("Sancho"));
				const drawing = `${face("Sancho")}.parentElement.querySelector('[role="img"]').innerHTML`;
				await page.until(`${face("Sancho")}.parentElement.querySelector('[role="img"] canvas, [role="img"] svg')`);
				expect(await frames(page, drawing), "without the preference the face moves").toBeGreaterThan(1);
				await page.input("Emulation.setEmulatedMedia", {
					features: [{ name: "prefers-reduced-motion", value: "reduce" }],
				});
				await page.run(`location.reload()`);
				await page.until(face("Sancho"));
				await page.until(`${face("Sancho")}.parentElement.querySelector('[role="img"] canvas, [role="img"] svg')`);
				expect(await frames(page, drawing), "with reduced motion the face is still").toBe(1);
				expect(await page.run(`${face("Sancho")}.parentElement.querySelector('[role="img"]').dataset.state`)).toBe(
					"working",
				);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			letGo();
			await idle();
		}
	},
	60_000,
);
