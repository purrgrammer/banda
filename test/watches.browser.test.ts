/**
 * A watch through the app, as a person uses it, against a throwaway daemon and a fake GitHub: the connection banda
 * ships, a pull request is followed from the agent's panel, its end is
 * edited, a change wakes the agent's chat, and the watch is paused, resumed and stopped. No live provider or network.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { CapabilitiesView } from "../src/server/api.ts";
import { world } from "./fault/watch-scenario.ts";
import { githubObjectDefinition, startGithubObjects } from "./fixtures/github-objects.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const SHOTS = process.env.BANDA_WATCHES_SHOTS;
const LINK = "https://github.com/acme/banda/pull/142";
const REPLY = "Lint failed on banda#142; I will look at it.";

const visible = "el.getClientRects().length > 0";
const button = (text: string, within = "document") =>
	`[...${within}.querySelectorAll('button')].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(text)})`;
const named = (label: string) =>
	`[...document.querySelectorAll('[aria-label]')].find(el => ${visible} && el.getAttribute('aria-label') === ${JSON.stringify(label)})`;
/** The watch's row in the panel, drawn as the pull request it follows. */
const row = `[...document.querySelectorAll('button[aria-label$=": open"]')].find(el => ${visible} && el.innerText.includes('Keep objects as data'))`;
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;

/** A click as a person makes one: on the control's centre, which must be the control and not something over it. */
async function click(page: Page, expression: string) {
	await page.until(expression);
	await page.run(`(${expression}).scrollIntoView({block:'center'})`);
	await page.until(
		`(() => {const el=${expression}; const moving=el.closest('[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper]'); return !moving || moving.getAnimations({subtree:true}).every(a => a.playState !== 'running');})()`,
	);
	const point = await page.run<{ x: number; y: number }>(
		`(() => {const el=${expression}; const r=el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if(!el.contains(document.elementFromPoint(x,y))) throw new Error('Control is not hit-testable: '+el.outerHTML.slice(0,120)); window.__watchClick={el,expression:${JSON.stringify(expression)},point:{x,y},before:{x:r.x,y:r.y,width:r.width,height:r.height}}; return {x,y};})()`,
	);
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
/** Paste `value` into the field labelled `label`, as the browser's own input would. */
async function paste(page: Page, label: string, value: string) {
	await page.until(named(label));
	await page.run(
		`(() => {const el=${named(label)}; el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
	);
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`the owner follows a pull request and it wakes the agent, through the app at ${width}`,
		async () => {
			const phone = width < 768;
			const home = await tempHome();
			if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
			let step = 0;
			const github = await startGithubObjects({ auth: "oauth" });
			github.user = "bandarra";
			github.onCall = async (tool, args) => {
				if (tool !== "pull_request_read") return { text: "not in this world", isError: true };
				const answer = world(step)[String(args.method)];
				return answer === undefined
					? { text: `no ${String(args.method)}`, isError: true }
					: { text: JSON.stringify(answer) };
			};
			const shipped = join(home, "shipped");
			await mkdir(shipped, { recursive: true });
			await writeFile(join(shipped, "github.json"), githubObjectDefinition(github.url));
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const models = createModels();
			const faux = fauxProvider();
			models.setProvider(faux.provider);
			// each run: the reply to the owner, then the run's end
			faux.setResponses(
				Array.from({ length: 10 }, () => [
					() => fauxAssistantMessage([fauxToolCall("message_user", { text: REPLY })], { stopReason: "toolUse" }),
					() => fauxAssistantMessage(""),
				]).flat(),
			);
			const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), shipped, log: () => {} });
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
				(await api<CapabilitiesView>("/capabilities")).connections.find((each) => each.name === "github");
			try {
				await skipShippedSkills(daemon.port, token);
				await api("/agents/mara", "PUT", {
					base: null,
					text: "---\nname: Mara\ndescription: Follows things\nconnections: [github]\n---\nFollow things for the owner.\n",
				});
				// GitHub, added and signed in to as bandarra, switched on for Mara
				await api("/capabilities/connections/github/add", "POST", {});
				const started = await api<{ url: string }>("/capabilities/connections/github/signin", "POST", {
					agent: "mara",
				});
				const consent = await fetch(started.url, { redirect: "manual" });
				await fetch(consent.headers.get("location") as string, { redirect: "manual" });
				while ((await connection())?.state !== "connected") await new Promise((resolve) => setTimeout(resolve, 50));
				expect((await connection())?.accounts).toEqual([expect.objectContaining({ id: "bandarra", agents: ["mara"] })]);

				await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (raw) => {
					await raw.run(`(() => {
						window.__watchClicks=[];
						for(const type of ['pointerdown','pointerup','mousedown','mouseup','click']) addEventListener(type,event=>{
							const planned=window.__watchClick;if(!planned)return;
							const r=planned.el.getBoundingClientRect();
							window.__watchClicks.push({type,expression:planned.expression,point:planned.point,before:planned.before,after:{x:r.x,y:r.y,width:r.width,height:r.height},correct:planned.el.contains(event.target),connected:planned.el.isConnected,target:event.target.outerHTML?.slice(0,240)});
						},true);
					})()`);
					const page: Page = {
						...raw,
						until: async (...args) => {
							try {
								await raw.until(...args);
							} catch (error) {
								const trace = await raw.run("window.__watchClicks.slice(-20)");
								throw new Error(`${String(error)}; input trace: ${JSON.stringify(trace)}`);
							}
						},
					};
					const shot = async (name: string) => {
						expect(
							await page.run("document.documentElement.scrollWidth <= innerWidth"),
							`${name}: no sideways scroll`,
						).toBe(true);
						expect(page.errors(), `${name}: no page errors`).toEqual([]);
						// what a person sees once things settle: no transition caught halfway (a face's slow loops go on)
						await page.until(
							"document.getAnimations().every(a => a.playState !== 'running' || !(a.effect?.getComputedTiming().endTime < 2000))",
						);
						if (SHOTS !== undefined) await page.shoot(join(SHOTS, `${width}-${name}.png`));
					};
					await page.until(shows("Mara"));
					await page.run(`location.hash='#/connections'`);
					await page.until(shows("Pull requests, issues, checks"));
					expect((await connection())?.state).toBe("connected");
					await shot("1-connections");

					await page.run(`location.hash='#/a/mara'`);
					await click(page, named("Mara: open its panel"));
					await click(page, button("Routines"));
					await page.until(shows("Watching"));
					await shot("3-watching-empty");
					await click(page, button("Add"));
					await paste(page, "Link to follow", LINK);
					await page.until(`!${button("Follow")}.disabled`);
					await shot("4-add-link");
					await click(page, button("Follow"));
					await page.until(row);
					await shot("5-followed");

					await click(page, row);
					await click(page, button("Edit"));
					await click(page, named("Ends"));
					await click(
						page,
						`[...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === 'When merged')`,
					);
					await shot("6-editing");
					await click(page, button("Save"));
					await page.until(button("Edit"));
					await page.until(shows("merged"));
					await shot("7-ends-merged");

					// its first look is its baseline: GitHub changing before it would be no change at all
					await page.until(shows("nothing new"));
					const watchFile = (await readdir(join(home, "workspace/watches"))).find((file) => file.endsWith(".md"));
					if (watchFile === undefined) throw new Error("the followed watch has no file");
					const watchName = watchFile.slice(0, -3);
					const controlY = () => page.run<number>(`(${button("Check now")}).getBoundingClientRect().y`);
					const beforeStatus = await controlY();
					await api(`/watches/${watchName}/pause`, "POST", {});
					await page.until(button("Resume"));
					expect(await controlY(), "status rows do not move the owner's controls").toBe(beforeStatus);
					await api(`/watches/${watchName}/resume`, "POST", {});
					await page.until(button("Pause"));
					expect(await controlY()).toBe(beforeStatus);
					step = 1;
					await click(page, button("Check now"));
					if (phone) await click(page, named("Close the panel"));
					await page.until(shows("lint failed"));
					// the wake's line: the pull request drawn as a reference (a link in a flex box, which innerText breaks
					// a line at), then the change in the kind's words
					await page.until(
						`[...document.querySelectorAll('p')].some(el => el.textContent.includes('Keep objects as data: ') && el.textContent.includes('lint failed'))`,
					);
					await page.until(shows(REPLY));
					await shot("8-woken");

					if (phone) {
						await click(page, named("Mara: open its panel"));
						await page.until(`${button("Pause")} || ${row}`);
						if (!(await page.run<boolean>(`Boolean(${button("Pause")})`))) await click(page, row);
					}
					// the wake is a feed item, no card beneath it; the watch's own card, drawn before the change, is current
					await page.until(
						`[...document.querySelectorAll('[data-object-previews]')].filter(el => ${visible} && el.innerText.includes('Approved by ana')).length === 1`,
					);
					await shot("9-detail-current");
					await click(page, button("Pause"));
					await page.until(button("Resume"));
					await shot("10-paused");
					await click(page, button("Resume"));
					await page.until(button("Pause"));
					await click(page, button("Stop"));
					await page.until(
						`document.querySelector('[role="alertdialog"]')?.getAnimations({subtree:true}).every(a => a.playState !== 'running')`,
					);
					await shot("11-stop-asked");
					await click(page, button("Stop", `document.querySelector('[role="alertdialog"]')`));
					await page.until(`!document.querySelector('[role="alertdialog"]')`);
					await page.until(`!${row}`);
					// back where the owner was: the Routines tab, its Watching empty again
					await page.until(`${button("Routines")}?.getAttribute('aria-selected') === 'true'`);
					await page.until(shows("Paste a link to follow it"));
					await shot("12-stopped");
				});
			} finally {
				await server.close();
				await daemon.close();
				await github.close();
			}
		},
		120000,
	);
