/**
 * A routine's run opened in its agent's chat, through the app, against a throwaway daemon and a faux model (no
 * provider, no network, nothing outside the temporary home): the owner's routine runs now and speaks; its line in the
 * chat is closed and nothing of the run was read; opened, the app asks which run the line stands for and reads that
 * run's own conversation, which shows the routine's words as the owner's message and what the agent sent; closed
 * again, the box is gone; the chat stays live meanwhile; and the routine's name in the line opens the routine. At phone and desktop width. `BANDA_RUN_LINE_SHOTS=<dir>` saves a screenshot at each step.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { RoutineRunsPage } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const SHOTS = process.env.BANDA_RUN_LINE_SHOTS;
const ASK = "Tell me which pull requests need me, in a line each.";
const SAID = "2 pull requests need you: #34 has red checks, #35 waits on a review.";

/** The run's line in the chat: the routine's own, never one inside a run's box. */
const line = `[...document.querySelectorAll('button[data-run-toggle]')].find((el) => el.getClientRects().length > 0 && el.getAttribute('aria-label').includes('Morning brief') && el.closest('[data-routine-run]') === null)`;
/** The routine's name in that line: it alone opens the routine itself. */
const name = `[...(${line}).parentElement.querySelectorAll('button:not([data-run-toggle])')].find((el) => el.innerText.trim() === 'Morning brief')`;
const box = "document.querySelector('[data-routine-run]')";
/** The requests the page made for transcript items, as paths under /api. */
const read =
	"performance.getEntriesByType('resource').map((one) => one.name.replace(/^.*\\/api/, '')).filter((path) => /^\\/chats\\/\\d+\\/items/.test(path))";

/** Open or close the run as a person does who aims at the chevron: the line's end, clear of the routine's name. */
async function toggle(page: Page) {
	await page.until(`${line} !== undefined`);
	await page.run(`(${line}).scrollIntoView({ block: "center" })`);
	const point = await page.run<{ x: number; y: number }>(
		`(() => { const el = ${line}; const r = el.getBoundingClientRect(); const x = r.right - 10, y = r.y + r.height / 2; if (document.elementFromPoint(x, y) !== el) throw new Error("the line's end is covered"); return { x, y }; })()`,
	);
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`a routine's line opens its run's own conversation in the chat, read only then, at ${width}`,
		async () => {
			const home = await tempHome();
			if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const models = createModels();
			const faux = fauxProvider();
			models.setProvider(faux.provider);
			faux.setResponses(
				Array.from({ length: 40 }, () => async (ctx) => {
					const last = ctx.messages.filter((message) => message.role !== "system").at(-1);
					return last?.role === "toolResult"
						? fauxAssistantMessage("")
						: fauxAssistantMessage([fauxToolCall("message_user", { text: SAID })], { stopReason: "toolUse" });
				}),
			);
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
			try {
				await api("/routines", "POST", {
					agent: "sancho",
					description: "Morning brief",
					when: "cron 0 8 * * 1-5",
					ask: ASK,
				});
				await api("/routines/sancho/morning-brief/run", "POST", { key: "run-1" });
				const ran = await until(async () => {
					const page = await api<RoutineRunsPage>("/routines/sancho/morning-brief/runs");
					return page.runs[0]?.state === "said" ? page.runs[0] : undefined;
				}, 30_000);
				const chat = ran.line?.chat as number;
				const entry = ran.line?.entry as number;
				const { run } = await api<{ run: number }>(`/chats/${chat}/items/${entry}/run`);
				expect(run).not.toBe(chat);

				const server = await webServer({
					server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
				});
				try {
					await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
						const shot = async (name: string) => {
							expect(
								await page.run("document.documentElement.scrollWidth <= innerWidth"),
								`${name}: no sideways scroll`,
							).toBe(true);
							expect(page.errors(), `${name}: no page errors`).toEqual([]);
							if (SHOTS !== undefined) await page.shoot(join(SHOTS, `${width}-${name}.png`));
						};
						// the dev server's modules fill the browser's default record of requests: make room, and count from here
						await page.run("performance.setResourceTimingBufferSize(10000); performance.clearResourceTimings()");
						await page.goto(`${server.origin}/#/a/sancho`);
						await page.until(`${line} !== undefined`, 30_000);
						// closed: the line says so, there is no box, and nothing of the run was read
						expect(await page.run(`${line}.getAttribute('aria-expanded')`)).toBe("false");
						expect(await page.run(`${box} === null`)).toBe(true);
						expect((await page.run<string[]>(read)).some((path) => path.startsWith(`/chats/${run}/`))).toBe(false);
						await shot("1-closed");

						await toggle(page);
						await page.until(`${box}?.innerText.includes(${JSON.stringify(SAID)}) === true`, 30_000);
						expect(await page.run(`${line}.getAttribute('aria-expanded')`)).toBe("true");
						// the routine's words are the owner's message there, and the agent's message follows
						expect(await page.run(`${box}.innerText.includes(${JSON.stringify(ASK)})`)).toBe(true);
						const asked = await page.run<string[]>(read);
						expect(asked).toContain(`/chats/${chat}/items/${entry}/run`);
						expect(asked.some((path) => path.startsWith(`/chats/${run}/items`))).toBe(true);
						// settled: the box is as tall as what it holds, within its bound, and the chat still scrolls sideways nowhere
						await page.until(
							`${box}.getAnimations({ subtree: true }).length === 0 && ${box}.parentElement.closest('[id]').getAnimations().length === 0`,
						);
						await shot("2-open");

						// the chat on screen stays live with a run open: a second run's line arrives without a reload
						const lines = `[...document.querySelectorAll('button[data-run-toggle]')].filter((el) => el.closest('[data-routine-run]') === null).length`;
						expect(await page.run(lines)).toBe(1);
						await api("/routines/sancho/morning-brief/run", "POST", { key: "run-2" });
						await page.until(`${lines} === 2`, 30_000);

						await toggle(page);
						await page.until(`${box} === null`, 10_000);
						expect(await page.run(`${line}.getAttribute('aria-expanded')`)).toBe("false");
						await shot("3-closed-again");

						// the routine's name alone opens the routine itself, in the agent's panel; the run stays closed
						await page.click(name);
						await page.until(
							"document.querySelectorAll('[data-run]').length > 0 || [...document.querySelectorAll('[aria-label]')].some((el) => el.getClientRects().length > 0 && el.getAttribute('aria-label') === 'Morning brief')",
							20_000,
						);
						expect(await page.run(`${box} === null`)).toBe(true);
						await shot("4-routine");
					});
				} finally {
					await server.close();
				}
			} finally {
				await daemon.close();
			}
		},
		180_000,
	);
