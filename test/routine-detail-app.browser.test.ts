/**
 * A routine's detail through the app, as a person uses it, against a throwaway daemon and a faux model (no provider,
 * no network, nothing written outside the temporary home): the owner's routines run now, one speaking, one quiet, one
 * failing; the row opens the detail with each run in words; a run that spoke or failed opens the chat at its own wake,
 * and one whose line the feed does not draw (a fixture written into the store) says so and shows what came after it;
 * Pause and Resume take effect at once; Edit puts the editor in its place and Back returns; a change the agent asked for
 * waits for the owner, so Edit waits too and the daemon refuses an edit over it. At phone and desktop width, light and
 * dark. `BANDA_ROUTINE_SHOTS=<dir>` saves a screenshot at each step.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { ROUTINE_SAID, type RoutineRecord, Routines } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ControlView, RoutineRunsPage } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const SHOTS = process.env.BANDA_ROUTINE_SHOTS;
const FIRST = "2 PRs need you: #34 has red checks";
const SECOND = "And #35 waits on a review.";

const visible = "el.getClientRects().length > 0";
const button = (text: string, within = "document") =>
	`[...${within}.querySelectorAll('button')].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(text)})`;
const named = (label: string) =>
	`[...document.querySelectorAll('[aria-label]')].find(el => ${visible} && el.getAttribute('aria-label') === ${JSON.stringify(label)})`;
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const runButton = (words: string) =>
	`[...document.querySelectorAll('button[data-run]')].find(el => ${visible} && el.innerText.includes(${JSON.stringify(words)}))`;
/** The feed's element marked found, its entry, and whether it is in view. */
const found = `(() => {const el=document.querySelector('[data-found]'); if(!el) return null; const r=el.getBoundingClientRect(); return {entry: Number(el.dataset.entry), inView: r.bottom > 0 && r.top < innerHeight};})()`;

/** A click as a person makes one: on the control's centre, which must be the control and not something over it. */
async function click(page: Page, expression: string) {
	await page.until(expression);
	await page.run(`(${expression}).scrollIntoView({block:'center'})`);
	await page.until(
		`(() => {const el=${expression}; const moving=el.closest('[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper]'); return !moving || moving.getAnimations({subtree:true}).every(a => a.playState !== 'running');})()`,
	);
	const point = await page.run<{ x: number; y: number }>(
		`(() => {const el=${expression}; const r=el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if(!el.contains(document.elementFromPoint(x,y))) throw new Error('Control is not hit-testable: '+el.outerHTML.slice(0,120)); return {x,y};})()`,
	);
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

/** A daemon on `home` whose faux model speaks twice, stays quiet or fails, by the marker its routine's wake carries. */
async function daemonOn(home: string) {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 60 }, () => async (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
			const said = ctx.messages.filter((m) => m.role !== "system");
			const last = said.at(-1);
			if (last?.role === "toolResult") {
				// after its first message, the speaking run sends a second, then ends
				const before = JSON.stringify([...said].reverse().find((m) => m.role === "assistant")?.content ?? "");
				return before.includes(FIRST)
					? fauxAssistantMessage([fauxToolCall("message_user", { text: SECOND })], { stopReason: "toolUse" })
					: fauxAssistantMessage("");
			}
			const text = JSON.stringify(last?.content ?? "");
			if (text.includes("SPEAK"))
				return fauxAssistantMessage([fauxToolCall("message_user", { text: FIRST })], { stopReason: "toolUse" });
			if (text.includes("FAIL"))
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request: FAIL fixture" });
			return fauxAssistantMessage("nothing to say");
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
	return { daemon, base, token, api };
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`a routine's runs open the chat at their line, and it is paused and edited from its detail, at ${width}`,
		async () => {
			const phone = width < 768;
			const home = await tempHome();
			if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			let { daemon, base, token, api } = await daemonOn(home);
			const runs = () => api<RoutineRunsPage>("/routines/morning-brief/runs");
			const ended = async (name: string, count: number) =>
				until(async () => {
					const page = await api<RoutineRunsPage>(`/routines/${name}/runs`);
					return page.runs.length >= count && page.runs.every((run) => !["waiting", "running"].includes(run.state));
				}, 30_000);
			try {
				await skipShippedSkills(daemon.port, token);
				// the owner's own routines, in effect at once; each run now, one after the other in Sancho's chat
				const make = (description: string, ask: string) =>
					api<{ name: string }>("/routines", "POST", { agent: "sancho", description, when: "cron 0 8 * * 1-5", ask });
				expect((await make("Morning brief", "SPEAK about my pull requests.")).name).toBe("morning-brief");
				await make("Quiet check", "Look, and stay quiet.");
				await make("Flaky check", "FAIL on purpose.");
				const runNow = async (name: string, key: string, count: number) => {
					await api(`/routines/${name}/run`, "POST", { key });
					await ended(name, count);
				};
				await runNow("morning-brief", "speak-1", 1);
				await runNow("quiet-check", "quiet-1", 1);
				await runNow("flaky-check", "fail-1", 1);
				await runNow("morning-brief", "speak-2", 2);
				const real = await runs();
				expect(real.runs.map((run) => run.state)).toEqual(["said", "said"]);
				expect((await api<RoutineRunsPage>("/routines/quiet-check/runs")).runs).toEqual([
					expect.objectContaining({ state: "quiet" }),
				]);
				expect(real.runs[0]?.said).toBe(FIRST);
				const failed = (await api<RoutineRunsPage>("/routines/flaky-check/runs")).runs[0];
				expect(failed?.state).toBe("failed");
				expect(failed?.line).toBeDefined();

				// a fixture: a run whose line the feed does not draw, as a record the store could hold, saying its second
				// message (read in its own conversation after its first message's result); the chat holds an entry it does
				// not draw and the run's next message after it; the daemon stops for it and starts again on the same home
				await daemon.close();
				const store = await openStore(home, { models: createModels(), registry: createRegistry() });
				const said = real.runs[1];
				const chat = said?.line?.chat as number;
				const records = (await store.snapshot(Routines, context))?.routines["morning-brief"]?.runs ?? [];
				const copied = records.find((run) => run.line === said?.line?.entry);
				const ran = await (await store.conversation(copied?.run as ConversationId, context))!.entries(
					{ order: "ascending" },
					50,
					undefined,
					context,
				);
				const result = Number(ran.items.find((entry) => entry.model?.[0]?.role === "toolResult")?.id);
				let missing = 0;
				let after = 0;
				await store.commit(async (tx) => {
					missing = Number((await tx.appendEntry(chat as ConversationId, { kind: "test.undrawn", data: {} })).id);
					after = Number(
						(
							await tx.appendEntry(chat as ConversationId, {
								kind: ROUTINE_SAID,
								data: { routine: "morning-brief", run: copied?.run ?? 0, call: "fixture", text: SECOND, at: 1 },
							})
						).id,
					);
					const record = (await tx.doc(Routines)).routines["morning-brief"] as RoutineRecord;
					record.runs = [
						...(record.runs ?? []),
						{ ...copied, at: (record.runs?.at(-1)?.at ?? 0) + 1, entry: result, line: missing } as NonNullable<
							RoutineRecord["runs"]
						>[number],
					];
				}, context);
				await store.close(context);
				({ daemon, base, token, api } = await daemonOn(home));
				expect(missing).toBeGreaterThan(0);
				expect((await runs()).runs[0]).toMatchObject({ state: "said", said: SECOND, line: { entry: missing } });

				const server = await webServer({
					server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
				});
				try {
					await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
						let scheme = "light";
						const shot = async (name: string) => {
							expect(
								await page.run("document.documentElement.scrollWidth <= innerWidth"),
								`${name}: no sideways scroll`,
							).toBe(true);
							expect(page.errors(), `${name}: no page errors`).toEqual([]);
							await page.until(
								"document.getAnimations().every(a => a.playState !== 'running' || !(a.effect?.getComputedTiming().endTime < 2000))",
							);
							if (SHOTS !== undefined) await page.shoot(join(SHOTS, `${width}-${scheme}-${name}.png`));
						};
						const darkToo = async (name: string) => {
							scheme = "dark";
							await page.input("Emulation.setEmulatedMedia", {
								features: [{ name: "prefers-color-scheme", value: "dark" }],
							});
							await shot(name);
							scheme = "light";
							await page.input("Emulation.setEmulatedMedia", {
								features: [{ name: "prefers-color-scheme", value: "light" }],
							});
						};

						await page.until(shows("Sancho"));
						await page.run(`location.hash='#/a/sancho'`);
						await page.until(shows("You ran Morning brief"));
						await click(page, named("Sancho: open its panel"));
						await page.until(named("Morning brief"));
						await shot("1-routines");
						await click(page, named("Morning brief"));
						await page.until(`document.querySelectorAll('[data-run]').length === 3`);
						await page.until(shows(`Said: ${FIRST}`));
						// it spoke each time: each run opens its line; the fixture's run, newest, says its second message
						expect(await page.run<number>(`document.querySelectorAll('button[data-run]').length`)).toBe(3);
						expect(await page.run<boolean>(shows(`Said: ${SECOND}`))).toBe(true);
						await shot("2-detail");
						await darkToo("2-detail");

						// a run that spoke opens the chat at its own wake, in view
						const target = real.runs[0]?.line?.entry as number;
						await click(page, runButton(FIRST));
						await page.until(`location.hash.endsWith('?at=${target}')`);
						await page.until(`${found}?.entry === ${target}`);
						expect(await page.run<{ inView: boolean }>(found)).toMatchObject({ inView: true });
						// on the phone the sheet closed so the chat shows
						if (phone) await page.until(`![...document.querySelectorAll('button[data-run]')].some(el => ${visible})`);
						// focus stays on the run, beside the chat
						else expect(await page.run<string>(`document.activeElement?.innerText ?? ''`)).toContain(FIRST);
						await shot("3-feed-at-run");
						await darkToo("3-feed-at-run");

						// focus comes back to it when the detail shows again
						if (phone) {
							await click(page, named("Sancho: open its panel"));
							await page.until(`document.activeElement?.innerText?.includes(${JSON.stringify(FIRST)})`);
						}

						// a run whose line the feed does not draw: told so, and what came after it shown
						await click(page, runButton(SECOND));
						await page.until(`location.hash.endsWith('?at=${missing}')`);
						await page.until(shows("That run's line isn't in the chat"));
						await page.until(`${found}?.entry === ${after}`);
						await shot("4-missing-line");
						// a quiet note: it leaves on its own
						await page.until(`!${shows("That run's line isn't in the chat")}`, 15_000);

						// a quiet run is said in words and opens nothing
						if (phone) await click(page, named("Sancho: open its panel"));
						await click(page, button("Routines"));
						await click(page, named("Quiet check"));
						await page.until(shows("Said nothing"));
						expect(await page.run<number>(`document.querySelectorAll('[data-run]').length`)).toBe(1);
						expect(await page.run<number>(`document.querySelectorAll('button[data-run]').length`)).toBe(0);
						await shot("5-quiet-run");
						await darkToo("5-quiet-run");

						// the failed run of another routine opens at its own wake too
						await click(page, button("Routines"));
						await click(page, named("Flaky check"));
						await page.until(shows("Failed: invalid request: FAIL fixture"));
						await click(page, runButton("Failed"));
						await page.until(`${found}?.entry === ${failed?.line?.entry}`);
						await shot("6-failed-run");

						// Pause and Resume, in effect at once
						if (phone) await click(page, named("Sancho: open its panel"));
						await click(page, button("Routines"));
						await click(page, named("Morning brief"));
						await click(page, button("Pause"));
						await page.until(button("Resume"));
						await page.until(shows("Paused"));
						const pausedNow = await api<ControlView>("/control");
						expect(pausedNow.routines.find((each) => each.name === "morning-brief")?.paused).toBe("owner");
						await shot("7-paused");
						await click(page, button("Resume"));
						await page.until(button("Pause"));
						expect(
							(await api<ControlView>("/control")).routines.find((each) => each.name === "morning-brief")?.paused,
						).toBeUndefined();

						// Edit puts the editor in its place; Back returns to the detail, Save too, as the owner's own edit
						await click(page, button("Edit"));
						await page.until(shows("What it's for"));
						await shot("8-editing");
						await click(page, named("Back"));
						await page.until(button("Pause"));
						await click(page, button("Edit"));
						await page.run(
							`(() => {const el=[...document.querySelectorAll('input')].find(i => i.value === 'Morning brief'); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'Morning digest'); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
						);
						await click(page, button("Save"));
						// its title is its file's name; what it is for changed, in effect at once
						await page.until(`${button("Pause")} && ${button("Edit")}`);
						expect(
							(await api<ControlView>("/control")).routines.find((each) => each.name === "morning-brief")?.accepted
								?.routine?.description,
						).toBe("Morning digest");

						// the agent asks to change it: that waits for the owner, so Edit waits, and the daemon refuses one
						const sha = (await api<ControlView>("/control")).routines.find((each) => each.name === "morning-brief")
							?.accepted?.sha as string;
						await writeFile(
							join(home, "workspace", "routines", "morning-brief.md"),
							"---\ndescription: Morning brief, longer\ncron: 0 9 * * 1-5\n---\nSPEAK about everything.\n",
						);
						await page.until(shows("Waiting for you: Sancho asks to change it"), 30_000);
						expect(await page.run<boolean>(`${button("Edit")}.disabled`)).toBe(true);
						await expect(api("/routines/morning-brief/edit", "POST", { sha, description: "Sneaky" })).rejects.toThrow(
							/409/,
						);
						await shot("9-change-waits");
						await darkToo("9-change-waits");
						await api("/routines/morning-brief/decline", "POST", {});
						await page.until(`!${shows("Waiting for you")} && !${button("Edit")}.disabled`);

						// Back: the list, on the Routines tab
						await click(page, button("Routines"));
						await page.until(`${button("Routines")}?.getAttribute('aria-selected') === 'true'`);
						await page.until(named("Quiet check"));
						await shot("10-back-to-list");
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
