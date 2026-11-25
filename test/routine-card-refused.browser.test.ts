/**
 * A routine's card when the daemon refuses the owner's answer (issue #154), through the app at phone and desktop
 * width: the card says what did not happen and why, in the daemon's words, and keeps its buttons and the owner's edit,
 * so a routine gone since reads apart from one changed since, and no click goes quiet. The refusals are the daemon's
 * own answers, played back by the page's `fetch` for the one request each, so the case is exact whatever the daemon's
 * timing; the last answer goes to the daemon itself, and the card settles. The panel's detail says a refused Pause in
 * the daemon's words, a row's menu (Run now) says it as a note with Try again, and the row and its buttons stay. `BANDA_SHOTS=<dir>`
 * saves shots.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ControlView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const SHOTS = process.env.BANDA_SHOTS;
const NAME = "weekly-summary-draft";

const visible = "el.getClientRects().length > 0";
const button = (text: string) =>
	`[...document.querySelectorAll('button')].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(text)})`;
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const problem = "document.querySelector('[data-routine-problem]')?.textContent ?? ''";
const named = (label: string) =>
	`[...document.querySelectorAll('[aria-label]')].find(el => ${visible} && el.getAttribute('aria-label') === ${JSON.stringify(label)})`;
const menuItem = (text: string) =>
	`[...document.querySelectorAll('[role="menuitem"]')].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(text)})`;

/** A native click through pointer events alone: a menu's trigger opens on press, so the release lands on the menu. */
async function click(page: Page, expression: string) {
	await page.until(expression);
	await page.run(`(${expression}).scrollIntoView({block:'center'})`);
	const point = await page.run<{ x: number; y: number }>(
		`(() => {const el=${expression}; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
	);
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

/** A daemon whose model schedules the routine when asked. */
async function daemonOn(home: string) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const respond = (ctx: ModelContext) => {
		const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
		if (last?.role === "toolResult" && last.toolName !== "tool_search") return fauxAssistantMessage("done");
		const input = [...ctx.messages].reverse().find((message) => message.role === "user");
		if (textOf(input?.content) !== "sancho schedules") return fauxAssistantMessage("nothing to say");
		if (!getCurrentTools(ctx.messages).some((tool) => tool.name === "schedule"))
			return fauxAssistantMessage([fauxToolCall("tool_search", { query: "schedule", limit: 1 })], {
				stopReason: "toolUse",
			});
		return fauxAssistantMessage(
			[
				fauxToolCall("schedule", {
					name: NAME,
					description: "Sancho weekly summary",
					cron: "30 8 * * 2",
					ask: "SANCHO ASK: draft it.",
				}),
			],
			{ stopReason: "toolUse" },
		);
	};
	faux.setResponses(Array.from({ length: 100 }, () => respond as never));
	const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), log: () => {} });
	const base = `http://127.0.0.1:${daemon.port}`;
	const token = (await readDaemonFile(home))!.token!;
	const api = async <T>(path: string, method = "GET", body?: object): Promise<T> => {
		const response = await fetch(`${base}/api${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
		return response.json() as Promise<T>;
	};
	return { daemon, base, token, api };
}

/** The page's next matching request is answered as the daemon would refuse it, once; every other goes through. */
const refuseOnce = (action: string, status: number, error: string) =>
	`(() => { const real = window.__realFetch ?? (window.__realFetch = window.fetch); let once = false;
		window.fetch = (input, init) => {
			const url = typeof input === 'string' ? input : input.url;
			if (!once && url.includes('/routines/') && url.endsWith('/${action}')) {
				once = true;
				return Promise.resolve(new Response(JSON.stringify({ error: ${JSON.stringify(error)} }), { status: ${status}, headers: { 'content-type': 'application/json' } }));
			}
			return real(input, init);
		}; return true; })()`;

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`a routine's card says a refused answer and keeps its buttons; gone reads apart from changed, at ${width}px`,
		async () => {
			const home = await tempHome();
			if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const { daemon, base, token, api } = await daemonOn(home);
			const routines = async () => (await api<ControlView>("/control")).routines;
			const workspace = join(home, "workspace");
			try {
				await skipShippedSkills(daemon.port, token);
				await until(async () => existsSync(join(workspace, "agents", "sancho.md")));
				await api("/messages", "POST", {
					id: randomUUID(),
					thread: "agent:sancho",
					agent: "sancho",
					text: "sancho schedules",
				});
				await until(
					async () => (await routines()).find((each) => each.id === `sancho/${NAME}`)?.change !== undefined,
					30_000,
				);
				const server = await webServer({
					server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
				});
				try {
					await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
						const shot = async (name: string) => {
							expect(await page.run("document.documentElement.scrollWidth <= innerWidth"), `${name}: sideways`).toBe(
								true,
							);
							expect(page.errors(), `${name}: page errors`).toEqual([]);
							// a note still fading in would shoot half-drawn
							await page.until(
								"document.getAnimations().every(a => a.playState !== 'running' || !(a.effect?.getComputedTiming().endTime < 2000))",
							);
							if (SHOTS !== undefined) await page.shoot(join(SHOTS, `${width}-${name}.png`));
						};
						await page.run(`location.hash='#/a/sancho'`);
						await page.until(button("Set it up"));
						await page.until(shows("SANCHO ASK"));

						// changed since: the daemon's 409, said on the card; the buttons stay
						await page.run(
							refuseOnce("accept", 409, `agents/sancho/routines/${NAME}.md changed since you saw it: look again`),
						);
						await page.click(button("Set it up"));
						await page.until(
							`(${problem}).includes("Couldn't set it up. Agents/sancho/routines/${NAME}.md changed since you saw it: look again")`,
						);
						await page.until(button("Set it up"));
						await page.until(button("Don't"));
						await shot("1-changed-since");

						// gone: the daemon's 404 reads apart, on the same card
						await page.run(
							refuseOnce("decline", 404, `there is no routine sancho/${NAME}: it is gone from the box and the store`),
						);
						await page.click(button("Don't"));
						await page.until(
							`(${problem}).includes("Couldn't decline it. There is no routine sancho/${NAME}: it is gone from the box and the store")`,
						);
						expect(await page.run<boolean>(`(${problem}).includes("changed since")`)).toBe(false);
						await page.until(button("Set it up"));
						await shot("2-gone");

						// the daemon itself answers the next: allowed, the card settles and the note goes
						await page.click(button("Set it up"));
						await until(
							async () => (await routines()).find((each) => each.id === `sancho/${NAME}`)?.change === undefined,
						);
						await page.until(shows("Set up"));
						await page.until(`document.querySelector('[data-routine-problem]') === null`);
						await shot("3-allowed");

						// the panel: its detail says a refused Pause in the daemon's words, and the button still says Pause
						await page.click(named("Sancho: open its panel"));
						await page.click(named("Weekly summary draft"));
						await page.until(button("Pause"));
						await page.run(
							refuseOnce("pause", 404, `there is no routine sancho/${NAME}: it is gone from the box and the store`),
						);
						await page.click(button("Pause"));
						await page.until(shows(`there is no routine sancho/${NAME}: it is gone from the box and the store`));
						await page.until(button("Pause"));
						expect(await page.run<boolean>(`${button("Resume")} !== undefined`)).toBe(false);
						await shot("4-detail-pause-refused");
						// a row's Run now refused reads as a note too; the row stays
						await page.click(button("Routines"));
						await page.until(named("Weekly summary draft: more"));
						await page.run(
							refuseOnce("run", 404, `there is no routine sancho/${NAME}: it is gone from the box and the store`),
						);
						await click(page, named("Weekly summary draft: more"));
						await click(page, menuItem("Run now"));
						await page.until(shows("Couldn't run it now"));
						await page.until(named("Weekly summary draft: more"));
						await shot("5-row-run-refused");
						// the daemon itself: the routine is still there, and it is paused as asked
						await page.until(`!${shows("Couldn't run it now")}`, 15_000);
						await click(page, named("Weekly summary draft: more"));
						await click(page, menuItem("Pause"));
						await until(
							async () => (await routines()).find((each) => each.id === `sancho/${NAME}`)?.paused === "owner",
						);
						expect(await page.run<boolean>(shows("Couldn't"))).toBe(false);
						expect(page.errors()).toEqual([]);
					});
				} finally {
					await server.close();
				}
			} finally {
				await daemon.close();
			}
		},
		120_000,
	);
