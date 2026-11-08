/**
 * Slack through the app, as a person uses it, against a throwaway daemon and a fake Slack: the owner connects Slack from
 * Settings (its access chosen, Slack's page stood in for by the callback it would make), the agent names a channel and
 * its card is drawn, then drafts a reply in a thread, which the owner edits and sends once. No live provider or network.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createServer } from "vite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentMainThread } from "../src/core/gateway.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { CapabilitiesView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { fakeSlack, ROOT_TS } from "./fixtures/slack.ts";
import { freePort, skipShippedSkills, tempHome, viteCacheDir } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const SHOTS = process.env.BANDA_SLACK_SHOTS;
const CHANNEL = "https://acme.slack.com/archives/C0GENERAL";

const visible = "el.getClientRects().length > 0";
const button = (text: string, within = "document") =>
	`[...${within}.querySelectorAll('button')].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(text)})`;
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const dialog = `document.querySelector('[role="dialog"]')`;
/** Slack's tile in Settings → Connections. */
const tile = `[...document.querySelectorAll('li')].find(el => ${visible} && el.querySelector('span')?.innerText.includes('Slack') && el.innerText.includes('Channels'))`;

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
	// a developer's own Slack app: the throwaway daemon listens on a port the shipped app did not register
	process.env.BANDA_SLACK_CLIENT_ID = "dev.slack";
});
afterEach(() => {
	delete process.env.BANDA_SLACK_CLIENT_ID;
});

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`the owner connects Slack, sees a channel's card and sends a reply drafted in a thread, at ${width}`,
		async () => {
			const home = await tempHome();
			if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
			const slack = fakeSlack();
			const shipped = join(home, "shipped");
			await mkdir(shipped, { recursive: true });
			await writeFile(
				join(shipped, "slack.md"),
				await readFile(new URL("../shipped/connections/slack.md", import.meta.url), "utf8"),
			);
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const models = createModels();
			const faux = fauxProvider();
			models.setProvider(faux.provider);
			faux.setResponses([
				() =>
					fauxAssistantMessage(
						[
							fauxToolCall("message_user", {
								text: `Here is what's new in [#general](${CHANNEL}).`,
								objects: [CHANNEL],
							}),
						],
						{ stopReason: "toolUse" },
					),
				() => fauxAssistantMessage(""),
				// a connection's tools load on demand: the model finds the post with tool_search first
				() =>
					fauxAssistantMessage([fauxToolCall("tool_search", { query: "slack post message" })], {
						stopReason: "toolUse",
					}),
				() =>
					fauxAssistantMessage(
						[
							fauxToolCall("slack__post_message", {
								channel: "C0GENERAL",
								thread_ts: ROOT_TS,
								text: "<!here> <@U0BOB> I'll look",
							}),
						],
						{ stopReason: "toolUse" },
					),
				() => fauxAssistantMessage([fauxToolCall("message_user", { text: "Sent." })], { stopReason: "toolUse" }),
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
			const server = await createServer({
				configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
				cacheDir: await viteCacheDir(),
				server: {
					host: "127.0.0.1",
					port: await freePort(),
					strictPort: true,
					open: false,
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
			const say = (text: string) =>
				api("/messages", "POST", { id: randomUUID(), thread: agentMainThread("mara"), text });
			try {
				await skipShippedSkills(daemon.port, token);
				await api("/agents/mara", "PUT", {
					base: null,
					text: "---\nname: Mara\ndescription: Works in Slack\nconnections: [slack]\n---\nHelp the owner in Slack.\n",
				});
				await server.listen();
				const address = server.httpServer!.address();
				if (!address || typeof address === "string") throw new Error("No app port");
				await withPage(`http://127.0.0.1:${address.port}/#token=${token}`, { width, height: 900 }, async (page) => {
					const shot = async (name: string) => {
						expect(
							await page.run("document.documentElement.scrollWidth <= innerWidth"),
							`${name}: no sideways scroll`,
						).toBe(true);
						expect(page.errors(), `${name}: no page errors`).toEqual([]);
						await page.until(
							"document.getAnimations().every(a => a.playState !== 'running' || !(a.effect?.getComputedTiming().endTime < 2000))",
						);
						if (SHOTS !== undefined) await page.shoot(join(SHOTS, `${width}-${name}.png`));
					};
					await page.until(shows("Mara"));
					// Slack's page is not reached: the tab the app opens for it is caught, and its address read
					await page.run(
						"window.open = () => ({ opener: null, close() {}, location: { replace(url) { window.__slackPage = url; } } })",
					);
					await page.run(`location.hash='#/connections'`);
					await click(
						page,
						`${tile} && [...${tile}.querySelectorAll('button')].find(el => el.textContent.trim() === 'Connect')`,
					);
					await page.until(`${dialog} && ${dialog}.innerText.includes('Send messages as you')`);
					await click(
						page,
						`[...${dialog}.querySelectorAll('label')].find(el => el.innerText.includes('Send messages as you'))`,
					);
					await shot("1-access");
					await click(page, button("Save and sign in", dialog));
					await page.until("typeof window.__slackPage === 'string'");
					const signIn = new URL(await page.run<string>("window.__slackPage"));
					expect(`${signIn.origin}${signIn.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
					expect(signIn.searchParams.get("user_scope")?.split(",")).toContain("chat:write");
					expect(signIn.searchParams.has("scope")).toBe(false);
					// what Slack's page sends the browser back to, once the owner allows it
					const back = await fetch(
						`${base}/oauth/callback?state=${signIn.searchParams.get("state")}&code=one-use-code`,
						{ redirect: "manual" },
					);
					expect(back.headers.get("location")).toBe("/#/connections");
					await page.until(`${dialog}?.innerText.includes('@ana at Acme')`);
					await shot("2-signed-in");
					const account = (await connection())?.accounts?.[0];
					expect(account?.label).toBe("@ana at Acme");
					if (!account?.agents.includes("mara"))
						await api(
							`/capabilities/connections/slack/accounts/${encodeURIComponent(account?.account ?? "")}/switch`,
							"POST",
							{ agent: "mara", on: true },
						);
					await page.run(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);

					await page.run(`location.hash='#/a/mara'`);
					await say("what's new in #general?");
					await page.until(`document.querySelector('[data-slack-card="channel"]')?.innerText.includes('Company-wide')`);
					expect(await page.run<string>(`document.querySelector('[data-slack-card="channel"]').innerText`)).toContain(
						"@deploybot [bot]",
					);
					await shot("3-channel-card");

					await say("reply in that thread saying I'll look");
					await page.until(shows("Reply in thread in #general"));
					await page.until(shows("Notifies @here (everyone active in the channel), @bob"));
					await page.until(`document.querySelector('[data-slack-card="thread"]')`);
					expect(await page.run(shows("Don't ask again"))).toBe(false);
					await shot("4-thread-draft");
					await page.run(
						`(() => {const el=document.querySelector('textarea[aria-label="Slack message"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,"<@U0BOB> I'll look after lunch"); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
					);
					await page.until(shows("Notifies @bob"));
					await click(page, button("Send"));
					await page.until(shows("Sent."));
					await shot("5-sent");
				});
				expect(slack.posts()).toEqual([
					{ channel: "C0GENERAL", text: "<@U0BOB> I'll look after lunch", thread_ts: ROOT_TS, ts: "1700001000.000000" },
				]);
			} finally {
				await server.close();
				await daemon.close();
			}
		},
		120000,
	);
