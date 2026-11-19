/**
 * An agent creates an agent and a group and changes itself from its chat, in the app against a running daemon on a
 * throwaway home (#58): each is in effect when the call ends, and the chat shows a row that links to what was made,
 * opening into a card with nothing to answer. The model is pi-ai's faux provider; nothing leaves the machine.
 * `BANDA_BAND_SHOTS=<dir>` keeps screenshots.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { AgentView, Item } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until as untilEver, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

async function until<T>(read: () => Promise<T | undefined | false | null>, what = read.toString()): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out waiting for ${what.slice(0, 300)}`)), 45_000);
	});
	try {
		return await Promise.race([untilEver(read), late]);
	} finally {
		clearTimeout(timer);
	}
}

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

/** What the lead does for each thing the owner says: one call. */
const PLANS: { readonly [said: string]: readonly [string, object] } = {
	"hire a writer": [
		"create_agent",
		{ id: "writer", name: "Writer", description: "Writes the owner's drafts", instructions: "Write plainly." },
	],
	"team up": ["create_group", { name: "Writing room", members: ["sancho", "writer"] }],
	"rename yourself": ["update_agent", { description: "The lead, renamed by itself" }],
};

/** The row whose words match `pattern` (a regex source), found afresh each time, as the feed may draw it anew. */
const row = (pattern: string) =>
	`[...document.querySelectorAll('[data-done]')].find(r => new RegExp(${JSON.stringify(pattern)}).test(r.innerText.replace(/\\s+/g, ' ')))`;

for (const [width, height] of [
	[1440, 1000],
	[390, 844],
] as const)
	it.skipIf(!hasChrome())(
		`the lead makes an agent and a group and changes itself; the app shows rows that link to them, at ${width}px`,
		async () => {
			const shots = process.env.BANDA_BAND_SHOTS;
			const home = await tempHome();
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const heard: { tool: string; text: string }[] = [];
			const answer = () =>
				fauxAssistantMessage([fauxToolCall("message_user", { text: "Done." })], { stopReason: "toolUse" });
			const respond = (ctx: ModelContext) => {
				const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
				if (last?.role === "toolResult" && last.toolName === "message_user") return fauxAssistantMessage("Done.");
				if (last?.role === "toolResult") {
					heard.unshift({ tool: last.toolName, text: textOf(last.content) });
					return answer();
				}
				const said = [...ctx.messages].reverse().find((m) => m.role === "user");
				const plan = PLANS[textOf(said?.content)];
				if (plan === undefined) return answer();
				return fauxAssistantMessage([fauxToolCall(plan[0], plan[1] as never)], { stopReason: "toolUse" });
			};
			faux.setResponses(Array.from({ length: 200 }, () => respond as never));
			const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), log: () => {} });
			const base = `http://127.0.0.1:${daemon.port}`;
			const token = (await readDaemonFile(home))?.token as string;
			await skipShippedSkills(daemon.port, token);
			const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
				const response = await fetch(`${base}/api${path}`, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
				});
				if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
				return (await response.json()) as T;
			};
			const say = (text: string) =>
				api<{ chat: number }>("/messages", {
					method: "POST",
					body: JSON.stringify({ id: randomUUID(), thread: "agent:sancho", text }),
				});
			const items = async (chat: number) => (await api<{ items: Item[] }>(`/chats/${chat}/items?after=0`)).items;
			const server = await webServer({
				server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
			});
			try {
				await withPage(`${server.origin}/#token=${token}`, { width, height }, async (page) => {
					const snap = async (name: string, at?: string) => {
						if (shots === undefined) return;
						await mkdir(shots, { recursive: true });
						if (at !== undefined) await page.run(`(${at})?.scrollIntoView({ block: 'center' })`);
						await page.run("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
						await page.shoot(`${shots}/app-${width}-${name}.png`);
					};
					await page.until(`document.body.textContent.includes('Sancho')`);
					await page.run(`location.hash = '#/a/sancho'`);

					// ---- a new agent: in effect when the call ends, a row linking its chat, a card with nothing to answer
					const { chat } = await say("hire a writer");
					const made = row("Created Writer");
					await page.until(made, 60_000);
					const writer = await until(async () =>
						(await api<AgentView[]>("/agents")).find((view) => view.name === "writer" && view.accepted !== undefined),
					);
					expect(writer.accepted?.agent).toMatchObject({ name: "Writer", state: "active", tools: [] });
					expect(writer.change).toBeUndefined();
					expect(await readFile(join(home, "workspace", "agents", "writer.md"), "utf8")).toContain("name: Writer");
					// the model heard what it did, and the daemon's receipt reached the app's transcript
					expect(heard.find((h) => h.tool === "create_agent")?.text).toContain('Created the agent "Writer" (writer)');
					const result = (await items(chat)).find(
						(i): i is Extract<Item, { role: "tool" }> => i.role === "tool" && i.name === "create_agent",
					);
					expect(result?.receipt).toMatchObject({ kind: "agent", change: "created", id: "writer" });
					expect(await page.run(`${made}.querySelector('a[href="#/a/writer"]') !== null`)).toBe(true);
					expect(
						await page.run(
							`[...document.querySelectorAll('button')].some(b => /^(Create agent|Accept)$/.test(b.textContent.trim()))`,
						),
					).toBe(false);
					await snap("created-row", made);
					await page.run(`${made}.querySelector('[aria-label="Show details"]').click()`);
					const card = `document.querySelector('[data-band-change][aria-label="New agent"]')`;
					await page.until(card);
					expect(await page.run<string>(`${card}.innerText`)).toContain("yours to give");
					expect(await page.run(`${card}.querySelector('button')`)).toBe(null);
					await snap("created-card", card);

					// ---- a group of the two: a row linking its room
					await say("team up");
					const grouped = row("Created the group Writing room");
					await page.until(grouped, 60_000);
					const href = await page.run<string>(`${grouped}.querySelector('a[href^="#/g/"]').getAttribute('href')`);
					expect(href).toMatch(/^#\/g\/\d+$/);
					await snap("group-row", grouped);

					// ---- the lead changes its own description: in effect; the row says which field where the row is wide enough
					await say("rename yourself");
					const changed = row("Updated Sancho");
					await page.until(changed, 60_000);
					if (width >= 768) expect(await page.run<string>(`${changed}.innerText`)).toContain("description");
					const lead = await until(async () =>
						(await api<AgentView[]>("/agents")).find(
							(view) => view.name === "sancho" && view.accepted?.agent?.description === "The lead, renamed by itself",
						),
					);
					expect(lead.change).toBeUndefined();
					await snap("updated-row", changed);

					// the group's room opens from its row; the new agent's chat from its mention
					await page.run(`location.hash = ${JSON.stringify(href)}`);
					await page.until(`document.body.innerText.includes('Writing room')`);
					await page.run(`location.hash = '#/a/writer'`);
					await page.until(`document.querySelector('header')?.innerText.includes('Writer')`);
					await snap("writer-chat");
					expect(page.errors().filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
				});
			} finally {
				await server.close();
				await daemon.close();
			}
		},
		240_000,
	);
