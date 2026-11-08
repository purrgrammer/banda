/**
 * A watch through the app, as a person uses it, against a throwaway daemon and a fake GitHub: the connection banda
 * ships is updated to the version that can follow, a pull request is followed from the agent's panel, its end is
 * edited, a change wakes the agent's chat, and the watch is paused, resumed and stopped. No live provider or network.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { CapabilitiesView } from "../src/server/api.ts";
import { world } from "./fault/watch-scenario.ts";
import { githubObjectFile, startGithubObjects } from "./fixtures/github-objects.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const SHOTS =
	"/private/tmp/claude-501/-Users-bandarra-sancho/8882dff8-743e-4ee2-9b72-9a6faaebc2f8/scratchpad/watches-shots";
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
		`(() => {const el=${expression}; const r=el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if(!el.contains(document.elementFromPoint(x,y))) throw new Error('Control is not hit-testable: '+el.outerHTML.slice(0,120)); return {x,y};})()`,
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

/** The objects of a GitHub connection file as they were before a watch could follow one: no `follow` anywhere. */
function withoutFollow(file: string): string {
	const strip = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(strip)
			: typeof value === "object" && value !== null
				? Object.fromEntries(Object.entries(value).flatMap(([k, v]) => (k === "follow" ? [] : [[k, strip(v)]])))
				: value;
	return file.replace(/```json\n([\s\S]*?)\n```/, (_, json: string) => {
		return `\`\`\`json\n${JSON.stringify(strip(JSON.parse(json)), null, 2)}\n\`\`\``;
	});
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`the owner follows a pull request and it wakes the agent, through the app at ${width}`,
		async () => {
			const phone = width < 768;
			const home = await tempHome();
			await mkdir(SHOTS, { recursive: true });
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
			const newer = githubObjectFile(github.url);
			const older = withoutFollow(newer);
			expect(older).not.toContain('"follow"');
			await writeFile(join(shipped, "github.md"), older);
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
				// the GitHub banda shipped before, added and signed in to as bandarra, switched on for Mara
				await api("/capabilities/connections/github/add", "POST", {});
				const started = await api<{ url: string }>("/capabilities/connections/github/signin", "POST", {
					agent: "mara",
				});
				const consent = await fetch(started.url, { redirect: "manual" });
				await fetch(consent.headers.get("location") as string, { redirect: "manual" });
				while ((await connection())?.state !== "connected") await new Promise((resolve) => setTimeout(resolve, 50));
				expect((await connection())?.accounts).toEqual([expect.objectContaining({ id: "bandarra", agents: ["mara"] })]);
				// this banda ships a newer GitHub: one that can follow a pull request
				await writeFile(join(shipped, "github.md"), newer);

				await withPage(`${base}/#token=${token}`, { width, height: 900 }, async (page) => {
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
						await page.shoot(join(SHOTS, `${width}-${name}.png`));
					};
					await page.until(shows("Mara"));
					await page.run(`location.hash='#/connections'`);
					await page.until(shows("banda has a newer GitHub"));
					await shot("1-update-offered");
					await click(page, button("Update"));
					await page.until(`!${shows("banda has a newer GitHub")}`);
					expect((await connection())?.state).toBe("connected");
					await shot("2-updated");

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

					step = 1;
					await click(page, button("Check now"));
					if (phone) await click(page, named("Close the panel"));
					await page.until(shows("lint failed"));
					await page.until(shows("Mara saw"));
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
					await page.until(shows("Follow a pull request or an issue: paste its link"));
					await shot("12-stopped");
				});
			} finally {
				await daemon.close();
				await github.close();
			}
		},
		120000,
	);
