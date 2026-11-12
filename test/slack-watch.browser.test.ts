/**
 * Following a Slack channel through the app, as a person does, against a throwaway daemon and a fake Slack: the agent
 * names #general and its card is drawn; the owner opens the card's actions, reads what following does (a mention wakes,
 * the rest tells) and follows it; a colleague's message draws a tell line with no run, and a mention of the owner wakes
 * the agent, whose reply follows the event line. No live provider or network.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentMainThread } from "../src/core/gateway.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { CapabilitiesView, WatchView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { fakeSlack } from "./fixtures/slack.ts";
import { skipShippedSkills, tempHome, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const SHOTS = process.env.BANDA_SLACK_SHOTS;
const CHANNEL = "https://acme.slack.com/archives/C0GENERAL";
const REPLY = "Bob says the deploy failed; I am looking.";

const visible = "el.getClientRects().length > 0";
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const item = (text: string) =>
	`[...document.querySelectorAll('[role="menuitem"]')].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(text)})`;

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

beforeEach(() => {
	process.env.BANDA_SLACK_CLIENT_ID = "dev.slack";
});
afterEach(() => {
	delete process.env.BANDA_SLACK_CLIENT_ID;
});

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`the owner follows a Slack channel from its card: a message tells, a mention wakes, at ${width}`,
		async () => {
			const home = await tempHome();
			if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
			const slack = fakeSlack();
			const shipped = join(home, "shipped");
			await mkdir(shipped, { recursive: true });
			await writeFile(
				join(shipped, "slack.json"),
				await readFile(new URL("../shipped/connections/slack.json", import.meta.url), "utf8"),
			);
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const models = createModels();
			const faux = fauxProvider();
			models.setProvider(faux.provider);
			faux.setResponses([
				() =>
					fauxAssistantMessage(
						[fauxToolCall("message_user", { text: `Here is [#general](${CHANNEL}).`, objects: [CHANNEL] })],
						{ stopReason: "toolUse" },
					),
				() => fauxAssistantMessage(""),
				// the mention's wake: the agent answers the owner
				() => fauxAssistantMessage([fauxToolCall("message_user", { text: REPLY })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage(""),
			]);
			const daemon = await startDaemon({
				home,
				port: 0,
				models,
				box: hostBox(home),
				shipped,
				fetch: slack.fetch,
				log: () => {},
			});
			const base = `http://127.0.0.1:${daemon.port}`;
			const token = (await readDaemonFile(home))!.token!;
			const server = await webServer({
				server: {
					proxy: {
						"/api": { target: base, changeOrigin: true, headers: { origin: base } },
						"^/(?:icon(?:-maskable)?\\.svg|icon-(?:192|512|maskable-512)\\.png|apple-touch-icon\\.png|manifest\\.webmanifest)$":
							{ target: base, changeOrigin: true },
					},
				},
			});
			const api = async <T>(path: string, method = "GET", body?: object): Promise<T> => {
				const response = await fetch(`${base}/api${path}`, {
					method,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
				if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
				return response.json() as Promise<T>;
			};
			const connection = async () =>
				(await api<CapabilitiesView>("/capabilities")).connections.find((each) => each.name === "slack");
			/** A message in #general, newest first as Slack keeps them. */
			const post = (ts: string, user: string, text: string) =>
				slack.history.C0GENERAL?.unshift({ type: "message", ts, user, team: "T0ACME", text });
			try {
				await skipShippedSkills(daemon.port, token);
				await api("/agents/mara", "PUT", {
					base: null,
					text: "---\nname: Mara\ndescription: Works in Slack\nconnections: [slack]\n---\nHelp the owner in Slack.\n",
				});
				// signed in to Slack as @ana at Acme, switched on for Mara: Slack's page stood in for by its callback
				await api("/capabilities/connections/slack/add", "POST", {});
				const started = await api<{ url: string }>("/capabilities/connections/slack/signin", "POST", {
					agent: "mara",
				});
				const state = new URL(started.url).searchParams.get("state");
				await fetch(`${base}/oauth/callback?state=${state}&code=one-use-code`, { redirect: "manual" });
				while ((await connection())?.accounts?.[0]?.agents.includes("mara") !== true)
					await new Promise((resolve) => setTimeout(resolve, 50));

				await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
					const shot = async (name: string) => {
						expect(
							await page.run("document.documentElement.scrollWidth <= innerWidth"),
							`${name}: no sideways scroll`,
						).toBe(true);
						expect(page.errors(), `${name}: no page errors`).toEqual([]);
						await page.until(
							"document.getAnimations().every(a => a.playState !== 'running' || !(a.effect?.getComputedTiming().endTime < 2000))",
						);
						if (SHOTS !== undefined) await page.shoot(join(SHOTS, `${width}-follow-${name}.png`));
					};
					await page.until(shows("Mara"));
					await page.run(`location.hash='#/a/mara'`);
					await api("/messages", "POST", { id: randomUUID(), thread: agentMainThread("mara"), text: "show #general" });
					await page.until(`document.querySelector('[data-slack-card="channel"]')?.innerText.includes('12 members')`);

					// the card's quiet actions, opened from the keyboard as the trigger shows on hover or focus
					const trigger = `[...document.querySelectorAll('button[aria-label^="Actions for"]')].find(el => el.closest('[data-object]')?.querySelector('[data-slack-card="channel"]'))`;
					await page.until(trigger);
					await page.run(
						`(() => { const el = ${trigger}; el.scrollIntoView({block:'center'}); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true})); })()`,
					);
					await page.until(`document.querySelector('[data-follow-says]')`);
					const says = await page.run<string>(`document.querySelector('[data-follow-says]').innerText`);
					expect(says).toContain("A message that mentions you wakes Mara; every other message only tells.");
					expect(says).toContain("slack/search/in:#general");
					await shot("1-follow-offered");
					await click(page, item("Follow"));
					await page.until(shows("Following"));
					await shot("2-following");
					// the watch is named after what it follows, and its first look (the baseline) came before it was live
					const name = "a-channel-in-slack";
					const check = async () => {
						const { watches } = await api<{ watches: WatchView[] }>(`/watches/${name}/check`, "POST", {
							key: randomUUID(),
						});
						return watches.find((each) => each.name === name);
					};

					post("1700000500.000600", "U0BOB", "lunch at one?");
					expect((await check())?.saw).toEqual(["@bob: lunch at one?"]);
					await page.until(
						`[...document.querySelectorAll('p')].some(el => ${visible} && el.textContent.includes('@bob: lunch at one?'))`,
					);
					await shot("3-told");

					post("1700000600.000700", "U0BOB", "<@U0ANA> the deploy failed");
					expect((await check())?.saw).toEqual(["@bob mentioned you"]);
					await page.until(
						`[...document.querySelectorAll('p')].some(el => ${visible} && el.textContent.includes('@bob mentioned you'))`,
					);
					await page.until(shows(REPLY));
					await shot("4-woken");
				});
				// the tell ran no model: the four scripted answers are the first message's two and the mention's two
				expect(faux.getPendingResponseCount()).toBe(0);
			} finally {
				await server.close();
				await daemon.close();
			}
		},
		120000,
	);
