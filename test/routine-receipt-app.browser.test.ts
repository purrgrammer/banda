import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import type { BoxEgress } from "../src/box/box.ts";
import { AgentChats, LEAD } from "../src/core/agents.ts";
import type { HeldRequest } from "../src/core/egress.ts";
import { RoutineRuns } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { ownerToken } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

const REPORT = "The retained request finished.";
const Waits = Type.Object({ waits: Type.Array(Type.Object({ key: Type.String(), chat: Type.Number() })) });

for (const { width, action } of [390, 1440].flatMap((width) =>
	["approve", "archive"].map((action) => ({ width, action })),
))
	it.skipIf(!hasChrome())(
		`a recovered routine approval supports ${action} in its parent's chat at ${width}px`,
		async () => {
			const home = await tempHome();
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const token = await ownerToken(home);
			const models = createModels();
			const faux = fauxProvider();
			models.setProvider(faux.provider);
			faux.setResponses(
				Array.from({ length: 100 }, () => (request) => {
					const last = request.messages.filter((message) => message.role !== "system").at(-1);
					if (last?.role !== "user") return fauxAssistantMessage("Done.");
					const report = JSON.stringify(last.content).includes("<held-request-result>");
					return fauxAssistantMessage(
						[fauxToolCall("message_user", { text: report ? REPORT : "The routine checked the request." })],
						{ stopReason: "toolUse" },
					);
				}),
			);
			const call = async <T extends TSchema>(
				daemon: Daemon,
				path: string,
				schema: T,
				body?: object,
				method = body === undefined ? "GET" : "POST",
			): Promise<Static<T>> => {
				const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
					method,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
				expect(response.ok, `${path}: ${response.status}`).toBe(true);
				const value: unknown = await response.json();
				assert.ok(Value.Check(schema, value));
				return value;
			};
			const start = (egress?: BoxEgress) =>
				startDaemon({
					home,
					port: 0,
					models,
					log: () => {},
					box: { ...hostBox(home), ...(egress === undefined ? {} : { egress }) },
				});
			const first = await start();
			try {
				await skipShippedSkills(first.port, token);
				if (action === "archive")
					await call(
						first,
						"/agents/mara",
						Type.Unknown(),
						{
							base: null,
							text: "---\nname: Mara\ndescription: A second active agent\n---\nBrief and careful.\n",
						},
						"PUT",
					);
				await call(first, "/routines", Type.Object({ name: Type.String() }), {
					agent: LEAD,
					description: "Receipt check",
					when: "every 24h",
					ask: "Check the request.",
				});
				await call(first, `/routines/${LEAD}/receipt-check/run`, Type.Unknown(), { key: "run-once" });
				const Runs = Type.Object({ runs: Type.Array(Type.Object({ state: Type.String() })) });
				await until(async () =>
					(await call(first, `/routines/${LEAD}/receipt-check/runs`, Runs)).runs.some((run) => run.state === "said"),
				);
			} finally {
				await first.close();
			}
			const stored = await openStore(home, { models, registry: createRegistry() });
			let execution: number;
			try {
				const runs = Object.entries((await stored.snapshot(RoutineRuns, context))?.runs ?? {});
				expect(runs).toHaveLength(1);
				const [run] = runs;
				assert.ok(run);
				execution = Number(run[0]);
				expect((await stored.snapshot(AgentChats, context))?.chats[execution]).toBeUndefined();
			} finally {
				await stored.close(context);
			}
			const request: HeldRequest = {
				ticket: "t0000000042",
				chat: execution,
				at: Date.now(),
				method: "POST",
				scheme: "https",
				host: "example.com",
				port: 443,
				path: "/routine-receipt",
				headers: [["content-type", "text/plain"]],
				body: Buffer.from("Invented retained request").toString("base64"),
			};
			let pending = [request];
			const sent: HeldRequest[] = [];
			const egress: BoxEgress = {
				env: () => ({}),
				source: () => {},
				configure: async () => "told",
				pass: async () => {},
				receiptChats: async () => (pending.length === 0 ? [] : [execution]),
				take: async () => ({ held: [...pending], reads: [], readBytes: 0 }),
				ack: async (_chat, _bytes, ids) => {
					pending = pending.filter((one) => !ids.includes(one.ticket));
				},
				replay: async (request) => {
					sent.push(request);
					return { status: 200, reason: "OK", headers: [], body: Buffer.from("Accepted").toString("base64") };
				},
			};
			const second = await start(egress);
			try {
				await until(async () => (await call(second, "/status", Waits)).waits.length === 1);
				const base = `http://127.0.0.1:${second.port}`;
				const server = await webServer({
					server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
				});
				try {
					await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
						const click = async (element: string) => {
							await page.run(`${element}.scrollIntoView({ block: 'center' })`);
							const point = await page.run<{ x: number; y: number }>(
								`(() => { const el = ${element}; const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; if (!el.contains(document.elementFromPoint(x, y))) throw new Error('Control is obscured'); return { x, y }; })()`,
							);
							for (const type of ["mousePressed", "mouseReleased"])
								await page.input("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point });
						};
						await page.until("document.body.innerText.includes('Sancho')");
						await page.run("location.hash = '#/a/sancho'");
						await page.until("document.body.innerText.includes('send POST https://example.com/routine-receipt')");
						const allow =
							"[...document.querySelectorAll('button')].filter(el => el.getClientRects().length > 0 && el.textContent.trim() === 'Allow')";
						await page.until(`${allow}.length === 1`);
						const [wait] = (await call(second, "/status", Waits)).waits;
						assert.ok(wait);
						expect(await page.run("document.body.innerText.includes('Invented retained request')")).toBe(true);
						expect(await page.run("document.querySelector('[role=checkbox]') === null")).toBe(true);
						expect(sent).toEqual([]);
						const shots = process.env.BANDA_ROUTINE_RECEIPT_SHOTS;
						if (shots !== undefined) {
							await mkdir(shots, { recursive: true });
							await page.shoot(join(shots, `${width}-${action}-approval.png`));
						}
						if (action === "archive") {
							await click("document.querySelector('button[aria-label=\"Sancho: open its panel\"]')");
							const about = "[...document.querySelectorAll('[role=tab]')].find(el => el.textContent === 'About')";
							await page.until(`${about} !== undefined`);
							await click(about);
							const archive =
								"[...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Archive Sancho')";
							await page.until(`${archive} !== undefined && !${archive}.disabled`);
							await click(archive);
							await page.until("document.querySelector('[role=alertdialog]') !== null");
							await click(
								"[...document.querySelectorAll('[role=alertdialog] button')].find(el => el.textContent.trim() === 'Archive')",
							);
							await until(async () => (await call(second, "/status", Waits)).waits.length === 0);
							await page.until(width < 600 ? "location.hash === '#/'" : "location.hash === '#/a/mara'");
							await page.run("location.hash = '#/a/sancho'");
							await page.until("document.body.innerText.includes('Sancho is archived.')");
							const stale = await fetch(`${base}/api/waits/${wait.key}`, {
								method: "POST",
								headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
								body: JSON.stringify({ answer: "approve", type: "approval", via: "web" }),
							});
							expect(stale.ok).toBe(false);
							expect(await stale.json()).toEqual({ error: "no open ask has this id" });
							expect(sent).toEqual([]);
							expect(await page.run(`${allow}.length`)).toBe(0);
							expect(await page.run(`document.body.innerText.includes(${JSON.stringify(REPORT)})`)).toBe(false);
							if (shots !== undefined) await page.shoot(join(shots, `${width}-archived.png`));
							await page.reload();
							await page.until("document.body.innerText.includes('Sancho is archived.')");
							expect(sent).toEqual([]);
							expect(page.errors()).toEqual([]);
							return;
						}
						await click(`${allow}[0]`);
						await until(() => sent.length === 1);
						await page.until(`document.body.innerText.includes(${JSON.stringify(REPORT)}) && ${allow}.length === 0`);
						expect(sent).toEqual([request]);
						expect((await call(second, "/status", Waits)).waits).toEqual([]);
						expect(await page.run("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
						expect(page.errors()).toEqual([]);
						if (shots !== undefined) await page.shoot(join(shots, `${width}-reported.png`));
						await page.reload();
						await page.until(`document.body.innerText.includes(${JSON.stringify(REPORT)})`);
						expect(await page.run(`${allow}.length`)).toBe(0);
						expect(sent).toEqual([request]);
					});
				} finally {
					await server.close();
				}
			} finally {
				await second.close();
			}
		},
	);
