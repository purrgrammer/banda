/**
 * What the app shows of an agent's work around an ask, in the actual app against a temporary daemon with a held faux
 * model and a held effect: an approval allowed on its card, one declined, one allowed whose run then fails, a question
 * answered on its card, one answered by typing, and one whose run was stopped. While the ask is open the agent waits
 * on the owner and no line says it works; once the owner answered, the working line says it works again, with its
 * words until it shows something and as its face alone after, until its turn ends. The band's row says the same with
 * its face. Each run is held where the page is looked at, so nothing here waits on a clock. The effect only waits;
 * nothing leaves the machine.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EffectTool } from "../src/core/ask.ts";
import { agentMainThread } from "../src/core/gateway.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ChatRow, Posted } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until, type WebServer, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

let daemon: Daemon;
let web: WebServer;
let base = "";
let token = "";
let chat = 0;
let api: <T>(path: string, body?: unknown, method?: string) => Promise<T>;

/** A hold on a run: what reaches it waits while it is closed, and `held` counts what waits or waited there. */
type Gate = { promise: Promise<void>; open: () => void; held: number };
const gate = (): Gate => {
	let open: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open, held: 0 };
};
/**
 * Where a run is held: `effect`, the approved effect while it runs; `after`, the model's request once the ask ended;
 * `ending`, its request after it said something, before its turn ends.
 */
type Stage = "effect" | "after" | "ending";
let gates = new Map<Stage, Gate>();
const holdAll = () => {
	gates = new Map([
		["effect", gate()],
		["after", gate()],
		["ending", gate()],
	]);
};
const letAllGo = () => {
	for (const each of gates.values()) each.open();
	gates = new Map();
};
const reach = async (stage: Stage) => {
	const held = gates.get(stage);
	if (held === undefined) return;
	held.held++;
	await held.promise;
};
const reached = (stage: Stage) => until(() => Promise.resolve(gates.get(stage)?.held === 1));
const release = (stage: Stage) => gates.get(stage)?.open();

const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));
const state = async () => (await api<ChatRow[]>("/chats")).find((row) => row.chat === chat)?.state;
const post = async (value: string) => {
	const posted = await api<Extract<Posted, { turn: number }>>("/messages", {
		id: randomUUID(),
		thread: agentMainThread("sancho"),
		text: value,
	});
	chat = posted.chat;
};

const sendParameters = Type.Object({ to: Type.String(), text: Type.String() });
/** An effect the owner approves, held while it runs. */
const heldSend: EffectTool<typeof sendParameters> = {
	name: "send_message",
	description: "Send a message to someone on the owner's behalf.",
	parameters: sendParameters,
	effect: "unsafe",
	describe: (args) => `send a message to ${args.to}`,
	run: async (args) => {
		await reach("effect");
		return { output: [{ type: "text", text: `Sent to ${args.to}.` }] };
	},
};

/**
 * The model: `STATE_SEND` asks to send a message (an approval), `STATE_ASK` asks a question with two choices. Once the
 * ask ended, however it ended, it says what came after it, and then ends its turn.
 */
function scripted() {
	const faux = fauxProvider({ tokensPerSecond: 4000 });
	const models = createModels();
	models.setProvider(faux.provider);
	type Said = { role: string; content: unknown };
	const respond = async (context: { messages: readonly Said[] }) => {
		const said = context.messages.filter((message) => message.role !== "system");
		const last = said.at(-1);
		const tool = (name: string, args: object) =>
			fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
		const asked = text(said.filter((message) => message.role === "user").at(-1)?.content);
		const marker = [...asked.matchAll(/STATE_[A-Z0-9_]+/g)].at(-1)?.[0] ?? "";
		if (last?.role === "user") {
			if (marker.startsWith("STATE_SEND")) return tool("tool_search", { query: "send_message" });
			if (marker.startsWith("STATE_ASK"))
				return tool("message_user", { question: `Which train? ${marker}`, options: ["Morning", "Evening"] });
			return tool("message_user", { text: "ok" });
		}
		if (last?.role !== "toolResult") return fauxAssistantMessage("Done.");
		// what it called last says where its turn is
		const calls = (
			said.filter((message) => message.role === "assistant").at(-1)?.content as
				| readonly { type: string; name?: string; arguments?: { [key: string]: unknown } }[]
				| undefined
		)?.filter((block) => block.type === "toolCall");
		const call = calls?.at(-1);
		if (call?.name === "tool_search") return tool("send_message", { to: "ana@example.test", text: "On my way." });
		if (call?.name === "send_message" || (call?.name === "message_user" && call.arguments?.question !== undefined)) {
			await reach("after");
			if (marker.endsWith("_FAILS")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" });
			return tool("message_user", { text: `After the ask: ${marker}` });
		}
		if (call?.name === "message_user" && marker !== "") await reach("ending");
		return fauxAssistantMessage("Done.");
	};
	faux.setResponses(Array.from({ length: 500 }, () => respond as never));
	return models;
}

beforeAll(async () => {
	if (!hasChrome()) return;
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	daemon = await startDaemon({
		home,
		port: 0,
		models: scripted(),
		box: hostBox(home),
		effects: [heldSend],
		log: () => {},
	});
	token = (await readDaemonFile(home))?.token ?? "";
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
	await post("hello");
	await until(async () => (await state()) === "idle");
	await api(
		"/agents/mara",
		{ text: "---\nname: Mara\ndescription: Helps\ntools: [read]\n---\nHelps.\n", base: null },
		"PUT",
	);
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

const line = `document.querySelector('[data-working-line]')`;
/** The line with its words: the agent works, and nothing says more of what it does. */
const saying = `(${line}?.innerText.trim() === 'Working…')`;
/** The line below what the agent showed, its words and its moving face still with it: it works on. */
const worksOnSaying = `(${saying} && ${line}.querySelector('[role="img"]')?.dataset.state === 'working' && [...document.querySelectorAll('[data-message-bubble]')].every((b) => b.getBoundingClientRect().bottom <= ${line}.getBoundingClientRect().top))`;
const button = (words: string) =>
	`[...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === ${JSON.stringify(words)}).at(-1)`;
const field = `document.querySelector('textarea[name="message"]')`;
const header = `document.querySelector('header')`;
/** Sancho's row in the band (a tile, as the lead is pinned): its words, and what its face says. */
const row = `[...document.querySelectorAll('button[aria-label^="Sancho"]')].find((b) => !b.closest('[data-working-line]') && b.querySelector('[role="img"][data-state]'))`;
const rowWaits = `(${row}?.getAttribute('aria-label')?.includes('waiting on you') === true)`;
const rowFace = (state: "working" | "idle") => `(${row}?.querySelector('[role="img"]')?.dataset.state === '${state}')`;

/** Whether `expression` comes true in the page within `ms`: what a wait would say, as a value to check. */
const seen = (page: Page, expression: string, ms = 5_000) =>
	page.until(expression, ms).then(
		() => true,
		() => false,
	);

/** A screenshot of the stage, when a folder for them is named: the proof a change to these states posts. */
async function shot(page: Page, name: string, width: number) {
	const shots = process.env.BANDA_STATE_SHOTS;
	if (shots === undefined) return;
	await mkdir(shots, { recursive: true });
	await page.shoot(join(shots, `${name}-${width}.png`));
}

/** The page on Sancho's chat. */
const onChat = (width: number, use: (page: Page) => Promise<void>) =>
	withPage(`${base}/#token=${token}`, { width, height: 900 }, async (raw) => {
		const page: Page = { ...raw, until: (expression, ms = 20_000) => raw.until(expression, ms) };
		await page.until(`localStorage.getItem('banda.token')`);
		await page.run(`location.hash='#/a/sancho'`);
		await page.until(`!!${field}`);
		await use(page);
	});

/** From the ask's end to the turn's: the line with its words, still with them beneath what the agent said, then gone. */
async function worksOn(page: Page, marker: string, width: number, name: string) {
	const desktop = width >= 768;
	await reached("after");
	expect(await state()).toBe("running");
	// the owner answered, and the agent works on: the line says so
	expect.soft(await seen(page, saying), "the line says it works once the ask ended").toBe(true);
	expect.soft(await page.run(`/working/i.test(${header}.innerText)`), "the header says nothing of work").toBe(false);
	if (desktop) expect.soft(await seen(page, rowFace("working")), "the row's face works").toBe(true);
	await shot(page, `${name}-2-working`, width);
	release("after");
	await reached("ending");
	await page.until(`document.body.innerText.includes('After the ask: ${marker}')`);
	expect(await state()).toBe("running");
	// it said something and works on: the line keeps its words, beneath what it said
	expect
		.soft(await seen(page, worksOnSaying), "the line stays, with its words, once the agent said something")
		.toBe(true);
	await shot(page, `${name}-3-said`, width);
	// read again from the daemon, the page shows the same: a reload, and another chat and back
	await page.reload();
	await page.until(`document.body.innerText.includes('After the ask: ${marker}')`);
	expect.soft(await seen(page, worksOnSaying), "the same after a reload").toBe(true);
	await page.run(`location.hash='#/a/mara'`);
	await page.until(`document.querySelector('header h1')?.getAttribute('aria-label') === 'Mara'`);
	expect.soft(await page.run(`!${line}`), "another agent's chat says nothing of it").toBe(true);
	await page.run(`location.hash='#/a/sancho'`);
	await page.until(`document.body.innerText.includes('After the ask: ${marker}')`);
	expect.soft(await seen(page, worksOnSaying), "the same after another chat").toBe(true);
	release("ending");
	await until(async () => (await state()) === "idle");
	expect.soft(await seen(page, `!${line}`), "the line goes when the turn ends").toBe(true);
	if (desktop) expect.soft(await seen(page, rowFace("idle")), "the row's face rests").toBe(true);
	await shot(page, `${name}-4-ended`, width);
	expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
	expect(page.errors()).toEqual([]);
}

/** The ask open: the agent waits on the owner, and nothing says it works. */
async function waitsOnOwner(page: Page, width: number, name: string) {
	await until(async () => (await state()) === "waiting");
	await page.until(`!!document.querySelector('[data-open-ask]')`);
	expect.soft(await page.run(`!${line}`), "no working line while it waits on the owner").toBe(true);
	expect
		.soft(await seen(page, `${header}.innerText.includes('Waiting on you')`), "the header says it waits")
		.toBe(true);
	if (width >= 768) expect.soft(await seen(page, rowWaits), "the row says it waits").toBe(true);
	await shot(page, `${name}-1-waiting`, width);
}

for (const width of [1440, 390])
	it.skipIf(!hasChrome())(
		`an approval allowed on its card: the agent works on, and the feed and the row say so until its turn ends, at ${width}px`,
		async () => {
			holdAll();
			try {
				await onChat(width, async (page) => {
					const marker = `STATE_SEND_${width}`;
					await post(marker);
					await waitsOnOwner(page, width, "allowed");
					await page.click(button("Allow"));
					// the approved effect runs, held: the agent is at work, having shown only the ask the owner answered
					await reached("effect");
					await until(async () => (await state()) === "running");
					expect.soft(await seen(page, saying), "the line says it works while the approved effect runs").toBe(true);
					if (width >= 768) expect.soft(await seen(page, rowFace("working")), "the row's face works").toBe(true);
					await shot(page, "allowed-2-effect", width);
					release("effect");
					await worksOn(page, marker, width, "allowed");
				});
			} finally {
				letAllGo();
				await until(async () => (await state()) === "idle");
			}
		},
		90_000,
	);

it.skipIf(!hasChrome())(
	"an approval declined on its card: the agent hears it and works on, and the feed says so",
	async () => {
		holdAll();
		try {
			await onChat(390, async (page) => {
				const marker = "STATE_SEND_DECLINED";
				await post(marker);
				await waitsOnOwner(page, 390, "declined");
				await page.click(button("Don't allow"));
				await worksOn(page, marker, 390, "declined");
			});
		} finally {
			letAllGo();
			await until(async () => (await state()) === "idle");
		}
	},
	90_000,
);

for (const how of ["its card", "typing"] as const)
	it.skipIf(!hasChrome())(
		`a question answered on ${how}: the agent works on, and the feed says so the same way`,
		async () => {
			holdAll();
			try {
				await onChat(390, async (page) => {
					const marker = how === "typing" ? "STATE_ASK_TYPED" : "STATE_ASK_CARD";
					await post(marker);
					await waitsOnOwner(page, 390, how === "typing" ? "typed" : "answered");
					if (how === "typing") {
						await page.run(`${field}.focus()`);
						await page.input("Input.insertText", { text: "Evening" });
						await page.run(`document.querySelector('button[aria-label="Send"]').click()`);
					} else await page.click(button("Evening"));
					await worksOn(page, marker, 390, how === "typing" ? "typed" : "answered");
				});
			} finally {
				letAllGo();
				await until(async () => (await state()) === "idle");
			}
		},
		90_000,
	);

it.skipIf(!hasChrome())(
	"an approval allowed, and the model fails after it: the line goes with the run, and the feed says what failed",
	async () => {
		holdAll();
		try {
			await onChat(390, async (page) => {
				await post("STATE_SEND_FAILS");
				await waitsOnOwner(page, 390, "failed");
				await page.click(button("Allow"));
				release("effect");
				await reached("after");
				expect.soft(await seen(page, saying), "the line says it works once the ask ended").toBe(true);
				release("after");
				await until(async () => (await state()) === "idle");
				await page.until(`document.body.innerText.includes("Couldn't get a reply")`);
				expect.soft(await seen(page, `!${line}`), "no working line once the run failed").toBe(true);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			letAllGo();
			await until(async () => (await state()) === "idle");
		}
	},
	60_000,
);

it.skipIf(!hasChrome())(
	"an ask whose run was stopped: nothing works, and nothing says it does",
	async () => {
		holdAll();
		try {
			await onChat(1440, async (page) => {
				await post("STATE_ASK_STOPPED");
				await waitsOnOwner(page, 1440, "stopped");
				await api(`/chats/${chat}/stop`, {});
				await until(async () => (await state()) === "idle");
				await page.until(`!document.querySelector('[data-open-ask]')`);
				expect.soft(await seen(page, `!${line}`), "no working line once it was stopped").toBe(true);
				expect.soft(await seen(page, rowFace("idle")), "the row's face rests").toBe(true);
				expect
					.soft(
						await seen(page, `!${header}.innerText.includes('Waiting on you')`),
						"the header no longer says it waits",
					)
					.toBe(true);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			letAllGo();
			await until(async () => (await state()) === "idle");
		}
	},
	60_000,
);
