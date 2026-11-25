/**
 * A routine's card says what runs, through the app at phone and desktop width: Curro's plain `write` into Sancho's
 * folder is a card in Curro's chat that says Curro asks and Sancho runs it, and allowing it there runs it as Sancho;
 * the lead's write into Curro's folder runs as Curro, with Curro's instructions and none of the lead's; a target archived
 * before Allow is refused; Sancho's own routine beside a shared one that wakes Sancho too says both will run, and
 * Curro's beside it (another agent's) does not. `BANDA_SHOTS=<dir>` saves shots.
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
import { shaOf } from "../src/core/agents.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ControlView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const SHOTS = process.env.BANDA_SHOTS;
const NAME = "weekly-summary-draft";
const CURRO =
	"---\nname: Curro\ndescription: Drafts summaries\ntools: [read, write]\n---\nCURRO INSTRUCTIONS: be brief.\n";
const SHARED = "---\ndescription: Weekly summary draft\ncron: 0 7 * * 1\n---\nSHARED ASK: the old shared one.\n";
const PROBE = "---\ndescription: Probe by Curro\ncron: 0 6 * * 1\n---\nPROBE ASK written by Curro.\n";

const visible = "el.getClientRects().length > 0";
const button = (text: string, within = "document") =>
	`[...((${within})?.querySelectorAll('button') ?? [])].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(text)})`;
const _named = (label: string) =>
	`[...document.querySelectorAll('[aria-label]')].find(el => ${visible} && el.getAttribute('aria-label') === ${JSON.stringify(label)})`;
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;

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

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

async function daemonOn(home: string) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const requests: { system: string; text: string }[] = [];
	const plans: { [said: string]: { tool: string; args: object } } = {
		"sancho schedules": {
			tool: "schedule",
			args: { name: NAME, description: "Sancho weekly summary", cron: "30 8 * * 2", ask: "SANCHO ASK: draft it." },
		},
		"curro schedules": {
			tool: "schedule",
			args: { name: NAME, description: "Curro weekly summary", cron: "30 9 * * *", ask: "CURRO ASK: draft it." },
		},
		"sancho writes into curro": {
			tool: "write",
			args: {
				path: "agents/curro/routines/probe2.md",
				content: "---\ndescription: Probe by Sancho\ncron: 0 5 * * 1\n---\nPROBE2 ASK written by Sancho.\n",
			},
		},
		"sancho writes into curro again": {
			tool: "write",
			args: {
				path: "agents/curro/routines/probe3.md",
				content: "---\ndescription: Probe three\ncron: 0 4 * * 1\n---\nPROBE3 ASK.\n",
			},
		},
		"curro writes into sancho": {
			tool: "write",
			args: { path: "agents/sancho/routines/probe.md", content: PROBE },
		},
	};
	const respond = (ctx: ModelContext) => {
		const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
		requests.push({
			system: JSON.stringify(ctx.messages.filter((m) => m.role === "system")),
			text: textOf(last?.content),
		});
		if (last?.role === "toolResult" && last.toolName !== "tool_search") return fauxAssistantMessage("done");
		const input = [...ctx.messages].reverse().find((message) => message.role === "user");
		const plan = plans[textOf(input?.content)];
		if (plan === undefined) return fauxAssistantMessage("nothing to say");
		if (!getCurrentTools(ctx.messages).some((tool) => tool.name === plan.tool))
			return fauxAssistantMessage([fauxToolCall("tool_search", { query: plan.tool, limit: 1 })], {
				stopReason: "toolUse",
			});
		return fauxAssistantMessage([fauxToolCall(plan.tool, plan.args as never)], { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 300 }, () => respond as never));
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
	return { daemon, base, token, api, requests };
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`a routine's card names whom it runs as, and allowing it runs it as that agent, at ${width}px`,
		async () => {
			const home = await tempHome();
			if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const { daemon, base, token, api, requests } = await daemonOn(home);
			const routines = async () => (await api<ControlView>("/control")).routines;
			const say = (text: string, agent: string) =>
				api("/messages", "POST", { id: randomUUID(), thread: `agent:${agent}`, agent, text });
			const workspace = join(home, "workspace");
			try {
				await skipShippedSkills(daemon.port, token);
				await until(async () => existsSync(join(workspace, "agents", "sancho.md")));
				await api("/agents/curro", "PUT", { text: CURRO, base: null });
				// a shared routine of the name, allowed: it runs as the lead, Sancho
				await mkdir(join(workspace, "routines"), { recursive: true });
				await writeFile(join(workspace, "routines", `${NAME}.md`), SHARED);
				await until(async () => (await routines()).find((each) => each.id === NAME)?.change !== undefined);
				await api(`/routines/${NAME}/accept`, "POST", { sha: shaOf(SHARED), id: NAME });
				await say("curro writes into sancho", "curro");
				await say("sancho schedules", "sancho");
				await until(
					async () => (await routines()).find((each) => each.id === "sancho/probe")?.change !== undefined,
					30_000,
				);
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
							await page.until(
								"document.getAnimations().every(a => a.playState !== 'running' || !(a.effect?.getComputedTiming().endTime < 2000))",
							);
							if (SHOTS !== undefined) await page.shoot(join(SHOTS, `${width}-${name}.png`));
						};
						await page.until(shows("Sancho"));

						// in Curro's chat: Curro asks, Sancho runs it, and its findings land in Sancho's chat
						await page.run(`location.hash='#/a/curro'`);
						await page.until(button("Set it up"));
						await page.until(shows("PROBE ASK"));
						await page.until(shows("Curro asks to set up a routine for Sancho"));
						await page.until(shows("Sancho's own routine"));
						await page.until(shows("It wakes Sancho on its own, with Sancho's instructions and access"));
						expect(await page.run<boolean>(shows("It wakes Curro"))).toBe(false);
						await shot("1-probe-card-in-curro-chat");
						await click(page, button("Set it up"));
						await until(
							async () => (await routines()).find((each) => each.id === "sancho/probe")?.change === undefined,
						);
						await shot("2-probe-allowed");
						// what the card said is what runs: Sancho, never Curro
						await api("/routines/sancho/probe/run", "POST", { key: "probe" });
						const probe = await until(async () => requests.find((each) => each.text.includes("PROBE ASK")), 30_000);
						expect(probe.system).not.toContain("CURRO INSTRUCTIONS");
						// Sancho is the lead: its prompt is the lead's
						expect(probe.system).toContain("You are the owner's lead agent");
						expect(probe.system).toContain("Your stable agent id is sancho");

						// in Sancho's chat: its own beside the shared one that wakes it too, and the card says both will run
						await page.run(`location.hash='#/a/sancho'`);
						await page.until(shows("SANCHO ASK"));
						await page.until(shows("A shared routine of this name also runs as Sancho: both will run."));
						await shot("3-sancho-twin-card");

						// Curro's own routine of the name beside the shared one, which runs as Sancho: no twins, no warning
						await say("curro schedules", "curro");
						await until(
							async () => (await routines()).find((each) => each.id === `curro/${NAME}`)?.change !== undefined,
							30_000,
						);
						expect((await routines()).find((each) => each.id === `curro/${NAME}`)?.twins).toBeUndefined();
						await page.run(`location.hash='#/a/curro'`);
						await page.until(shows("CURRO ASK"));
						await page.until(shows("Curro's own routine"));
						expect(await page.run<boolean>(shows("both will run"))).toBe(false);
						await shot("4-curro-no-twin");

						// the other way: the lead writes into Curro's folder; its card in Sancho's chat says Curro, and it runs as
						// Curro, with none of the lead's prompt
						const pending = (await routines()).find((each) => each.id === `sancho/${NAME}`)?.change as { sha: string };
						await api(`/routines/sancho/${NAME}/accept`, "POST", { sha: pending.sha });
						await say("sancho writes into curro", "sancho");
						await until(
							async () => (await routines()).find((each) => each.id === "curro/probe2")?.change !== undefined,
							30_000,
						);
						await page.run(`location.hash='#/a/sancho'`);
						await page.until(shows("PROBE2 ASK"));
						await page.until(shows("Sancho asks to set up a routine for Curro"));
						await page.until(shows("Curro's own routine"));
						await page.until(shows("It wakes Curro on its own, with Curro's instructions and access"));
						await shot("5-lead-writes-into-curro");
						await click(page, button("Set it up"));
						await until(
							async () => (await routines()).find((each) => each.id === "curro/probe2")?.change === undefined,
						);
						await api("/routines/curro/probe2/run", "POST", { key: "probe2" });
						const probe2 = await until(async () => requests.find((each) => each.text.includes("PROBE2 ASK")), 30_000);
						expect(probe2.system).toContain("CURRO INSTRUCTIONS");
						expect(probe2.system).toContain("Your stable agent id is curro");
						expect(probe2.system).not.toContain("You are the owner's lead agent");

						// its agent archived between the card and Allow: refused, and nothing is accepted
						await say("sancho writes into curro again", "sancho");
						const third = await until(
							async () => (await routines()).find((each) => each.id === "curro/probe3" && each.change),
							30_000,
						);
						const agents = await api<{ accepted?: { agent?: { id: string }; text: string; sha: string } }[]>("/agents");
						const curro = agents.find((each) => each.accepted?.agent?.id === "curro")?.accepted;
						if (curro === undefined) throw new Error("Curro is not in effect");
						const archived = curro.text.replace("---\nCURRO", "state: archived\n---\nCURRO");
						expect(archived).not.toBe(curro.text);
						await api("/agents/curro", "PUT", { text: archived, base: curro.sha });
						await expect(
							api("/routines/curro/probe3/accept", "POST", { sha: (third.change as { sha: string }).sha }),
						).rejects.toThrow(/409/);
						expect((await routines()).find((each) => each.id === "curro/probe3")?.accepted).toBeUndefined();
					});
				} finally {
					await server.close();
				}
			} finally {
				await daemon.close();
			}
		},
		240_000,
	);
