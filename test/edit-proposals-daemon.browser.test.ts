/**
 * The owner edits what an agent wrote before accepting it (#53), in the app against a running daemon on a throwaway
 * home, as a person would: a pull request's title, an agent proposal and a change to the lead, and a routine's schedule
 * and ask. What reaches the service, the accepted files and the box is the owner's text, exactly and once; what is not
 * text, or not theirs to edit, is refused by the daemon whatever the page sends. The model is pi-ai's faux provider and
 * GitHub a fake MCP server: nothing leaves the machine. `BANDA_EDIT_SHOTS=<dir>` keeps screenshots, light and dark.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createServer as createViteServer } from "vite";
import { expect, it } from "vitest";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ControlView, Item } from "../src/server/api.ts";
import { githubObjectDefinition, startGithubObjects } from "./fixtures/github-objects.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until as untilEver, viteCacheDir } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

/** `untilEver`, bounded: a state that never comes fails naming what it waited on, well before the test's own timeout. */
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

/** The tools a request offers: each system message's additions and removals, replayed in order. */
function toolsOf(ctx: ModelContext): string[] {
	const tools = new Set<string>();
	for (const message of ctx.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
	}
	return [...tools];
}

/** What the lead does for each thing the owner says: one call. */
const PLANS: { readonly [said: string]: readonly [string, object] } = {
	"open a pull request": [
		"github__create_pull_request",
		{
			owner: "acme",
			repo: "banda",
			title: "Drafted title",
			body: "Drafted description.",
			head: "edits",
			base: "main",
		},
	],
	"hire a writer": [
		"propose_agent",
		{
			id: "writer",
			name: "Writer",
			face: JSON.parse(JSON.stringify(defaultAvatarFace())),
			description: "Writes drafts",
			instructions: "Write clearly.",
		},
	],
	"change yourself": ["propose_agent_change", { instructions: "Proposed lead instructions." }],
	"tea routine": [
		"schedule",
		{ name: "tea", description: "Tea time", cron: "0 16 * * *", ask: "Remind the owner to drink tea." },
	],
	"tea again": [
		"schedule",
		{ name: "tea", description: "Tea time", cron: "0 16 * * *", ask: "Remind the owner to drink green tea." },
	],
};

/** The card (a tile) holding a button whose words are `words`. */
const cardWith = (words: string) =>
	`([...document.querySelectorAll('button')].filter(b => b.textContent.trim() === ${JSON.stringify(words)}).at(-1)?.closest('.rounded-tile'))`;
const button = (scope: string, words: string) =>
	`[...(${scope}).querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;

/** The last card (a tile) whose words include `words`: found afresh each time, as the feed may draw it anew. */
const tile = (words: string) =>
	`([...document.querySelectorAll('.rounded-tile')].filter(t => t.innerText.includes(${JSON.stringify(words)})).at(-1))`;

/** Type `text` into the field focused in `scope`, as a person does: select what is there, and type over it. */
async function typeOver(page: Page, field: string, text: string): Promise<void> {
	await page.run(`(() => { const el = ${field}; el.focus(); el.select(); })()`);
	if (text === "")
		await page.input("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Backspace",
			code: "Backspace",
			windowsVirtualKeyCode: 8,
		});
	else await page.input("Input.insertText", { text });
}

for (const [width, height] of [
	[1440, 1000],
	[390, 844],
] as const)
	it.skipIf(!hasChrome())(
		`the owner edits a pull request, an agent, a change to the lead and a routine before accepting them, at ${width}px`,
		async () => {
			const shots = process.env.BANDA_EDIT_SHOTS;
			const fake = await startGithubObjects();
			// the upstream server's tool (github-mcp-server, pull_requests.go): the fixture lists only the object writes
			fake.tools.push({
				name: "create_pull_request",
				description: "Create a new pull request in a GitHub repository.",
				inputSchema: {
					type: "object",
					properties: {
						owner: { type: "string" },
						repo: { type: "string" },
						title: { type: "string" },
						body: { type: "string" },
						head: { type: "string" },
						base: { type: "string" },
						draft: { type: "boolean" },
						maintainer_can_modify: { type: "boolean" },
					},
					required: ["owner", "repo", "title", "head", "base"],
				},
				readOnlyHint: false,
			});
			const home = await tempHome();
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const shipped = join(home, "shipped");
			await mkdir(shipped, { recursive: true });
			await writeFile(join(shipped, "github.json"), githubObjectDefinition(fake.url));
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			/** What each tool's result said to the model, last first. */
			const heard: { tool: string; text: string }[] = [];
			const answer = () =>
				fauxAssistantMessage([fauxToolCall("message_user", { text: "Done." })], { stopReason: "toolUse" });
			const respond = (ctx: ModelContext) => {
				const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
				if (last?.role === "toolResult" && last.toolName === "message_user") return fauxAssistantMessage("Done.");
				if (last?.role === "toolResult" && last.toolName !== "tool_search") {
					heard.unshift({ tool: last.toolName, text: textOf(last.content) });
					return answer();
				}
				// what the owner said last: a nudge, or a notice, is no plan
				const said = [...ctx.messages].reverse().find((m) => m.role === "user");
				const plan = PLANS[textOf(said?.content)];
				if (plan === undefined) return answer();
				if (!toolsOf(ctx).includes(plan[0])) {
					if (last?.role === "toolResult") return answer();
					return fauxAssistantMessage([fauxToolCall("tool_search", { query: plan[0], limit: 5 })], {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage([fauxToolCall(plan[0], plan[1] as never)], { stopReason: "toolUse" });
			};
			faux.setResponses(Array.from({ length: 400 }, () => respond as never));
			const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), shipped, log: () => {} });
			const base = `http://127.0.0.1:${daemon.port}`;
			const token = (await readDaemonFile(home))?.token as string;
			await skipShippedSkills(daemon.port, token);
			const call = async (path: string, init: RequestInit = {}) =>
				fetch(`${base}/api${path}`, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
				});
			const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
				const response = await call(path, init);
				if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
				return (await response.json()) as T;
			};
			/** A request the daemon must refuse: its status and words. */
			const refused = async (path: string, body: object) => {
				const response = await call(path, { method: "POST", body: JSON.stringify(body) });
				return `${response.status} ${await response.text()}`;
			};
			// GitHub signed in for the lead, as the owner's browser would
			await api("/capabilities/connections/github/add", { method: "POST", body: "{}" });
			fake.user = "alice";
			const started = await api<{ url: string }>("/capabilities/connections/github/signin", {
				method: "POST",
				body: JSON.stringify({ agent: "sancho" }),
			});
			const consent = await fetch(started.url, { redirect: "manual" });
			await fetch(consent.headers.get("location") ?? "", { redirect: "manual" });
			const thread = "agent:sancho";
			const say = (text: string) =>
				api<{ chat: number }>("/messages", {
					method: "POST",
					body: JSON.stringify({ id: randomUUID(), thread, text }),
				});
			const items = async (chat: number) => (await api<{ items: Item[] }>(`/chats/${chat}/items?after=0`)).items;

			let vite: Awaited<ReturnType<typeof createViteServer>>;
			const listener = createServer((req, res) => vite.middlewares(req, res));
			vite = await createViteServer({
				configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
				cacheDir: await viteCacheDir(),
				server: {
					middlewareMode: true,
					hmr: { server: listener },
					proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } },
				},
			});
			try {
				await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
				const address = listener.address();
				if (!address || typeof address === "string") throw new Error("No app port");
				const app = `http://127.0.0.1:${address.port}`;
				await withPage(`${app}/#token=${token}`, { width, height }, async (page) => {
					/** Light and dark, of what is on screen now, with `card` in view. */
					const snap = async (name: string, card?: string) => {
						if (shots === undefined) return;
						await mkdir(shots, { recursive: true });
						if (card !== undefined) await page.run(`(${card})?.scrollIntoView({ block: 'center' })`);
						for (const theme of ["light", "dark"]) {
							await page.run(
								`document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`,
							);
							await page.run("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
							await page.shoot(`${shots}/${width}-${theme}-${name}.png`);
						}
						await page.run(`document.documentElement.classList.remove('light', 'dark')`);
					};
					await page.until(`document.body.textContent.includes('Sancho')`);
					await page.run(`location.hash = '#/a/sancho'`);

					// ---- a pull request: the title edited, the description edited and undone, opened once as edited
					const { chat } = await say("open a pull request");
					await page.until(`${cardWith("Open")}?.querySelector('[aria-label="Edit title"]')`, 60_000);
					const pr = tile("Open a pull request on acme/banda");
					expect(await page.run(`${pr}.innerText`)).toContain("Drafted title");
					await snap("pr-drafted", pr);
					// the daemon refuses what is not text, or not offered as text, whatever the page sends
					const wait = await until(async () =>
						(await api<{ waits: { key: string; chat: number }[] }>("/status")).waits.find((w) => w.chat === chat),
					);
					for (const edits of [{ owner: "evil" }, { repo: "other" }, { head: "evil" }, { base: "release" }])
						expect(
							await refused(`/waits/${wait.key}`, { answer: "approve", type: "approval", via: "web", edits }),
						).toMatch(/cannot be edited/);
					expect(
						await refused(`/waits/${wait.key}`, {
							answer: "approve",
							type: "approval",
							via: "web",
							edits: { title: 7 },
						}),
					).toMatch(/^4\d\d /);
					expect(
						await refused(`/waits/${wait.key}`, {
							answer: "deny",
							type: "approval",
							via: "web",
							edits: { title: "Declined anyway" },
						}),
					).toMatch(/only an approval, approved, carries edits/);
					expect(fake.calls.filter((c) => c.tool === "create_pull_request")).toEqual([]);

					await page.run(`${pr}.querySelector('[aria-label="Edit title"]').click()`);
					await page.until(`${pr}.querySelector('input')`);
					await typeOver(page, `${pr}.querySelector('input')`, "Owner's title");
					await page.run(`${pr}.querySelector('[aria-label="Done editing title"]').click()`);
					await page.run(`${pr}.querySelector('[aria-label="Edit description"]').click()`);
					await page.until(`${pr}.querySelector('textarea')`);
					await typeOver(page, `${pr}.querySelector('textarea')`, "A description the owner then undid.");
					await page.run(`${pr}.querySelector('[aria-label="Done editing description"]').click()`);
					await page.until(`${pr}.innerText.includes('A description the owner then undid.')`);
					// each edited field says so and offers Undo
					expect(await page.run(`[...${pr}.querySelectorAll('[data-edited]')].length`)).toBe(2);
					await snap("pr-edited", pr);
					await page.run(
						`[...${pr}.querySelectorAll('[data-edited]')].find(f => f.innerText.includes('undid')).querySelector('button').click()`,
					);
					await page.until(`!${pr}.innerText.includes('undid') && ${pr}.innerText.includes('Drafted description.')`);
					expect(await page.run(`[...${pr}.querySelectorAll('[data-edited]')].length`)).toBe(1);
					await page.run(`${button(pr, "Open")}.click()`);
					await page.until(
						`[...document.querySelectorAll('.rounded-tile')].some(t => t.innerText.includes('Approved as you edited it'))`,
					);
					await until(async () => heard.find((h) => h.tool === "github__create_pull_request"));
					// once, with the owner's title and the agent's description, which the owner put back
					expect(fake.calls.filter((c) => c.tool === "create_pull_request")).toEqual([
						{
							tool: "create_pull_request",
							args: {
								owner: "acme",
								repo: "banda",
								title: "Owner's title",
								body: "Drafted description.",
								head: "edits",
								base: "main",
							},
						},
					]);
					// the agent hears what ran: the owner's title, not its own
					const result = heard.find((h) => h.tool === "github__create_pull_request")?.text ?? "";
					expect(result).toContain("The owner edited title before approving");
					expect(result).toContain("Owner's title");
					expect(result).not.toContain("body:");
					// the answered card reads what ran, and says whose the title is
					const answered = `[...document.querySelectorAll('.rounded-tile')].find(t => t.innerText.includes('Approved as you edited it'))`;
					expect(await page.run(`${answered}.innerText`)).toContain("Owner's title");
					expect(await page.run(`${answered}.innerText.includes('Drafted title')`)).toBe(false);
					expect(await page.run(`${answered}.innerText`)).toContain("Edited by you");
					expect(await page.run(`${answered}.querySelector('input, textarea, [aria-label^="Edit "]')`)).toBe(null);
					await snap("pr-answered", answered);

					// ---- a new agent: its description and instructions are the owner's to edit; a blank holds the button back
					await say("hire a writer");
					await page.until(`${cardWith("Create agent")}?.querySelector('[aria-label="Edit description"]')`, 60_000);
					const writer = tile("Create Writer");
					const proposal = await until(async () =>
						(await items(chat)).find(
							(i): i is Extract<Item, { role: "proposal" }> => i.role === "proposal" && i.proposal.kind === "agent",
						),
					);
					for (const [body, why] of [
						[{ action: "accept", edits: { name: "Mallory" } }, /name cannot be edited/],
						[{ action: "accept", edits: { tools: ["bash"] } }, /tools cannot be edited/],
						[{ action: "accept", edits: { description: "two\nlines" } }, /one line/],
						[
							{ action: "decline", edits: { description: "Declined anyway" } },
							/only an accepted proposal carries edits/,
						],
					] as const)
						expect(await refused(`/proposals/${encodeURIComponent(proposal.proposal.id)}`, body)).toMatch(why);
					await page.run(`${writer}.querySelector('[aria-label="Edit description"]').click()`);
					await typeOver(page, `${writer}.querySelector('input')`, "Writes the owner's drafts");
					await page.run(`${writer}.querySelector('[aria-label="Done editing description"]').click()`);
					await page.run(`${writer}.querySelector('details').open = true`);
					await page.run(`${writer}.querySelector('[aria-label="Edit instructions"]').click()`);
					await typeOver(page, `${writer}.querySelector('textarea')`, "");
					await page.until(`${writer}.querySelector('[role="alert"]')?.textContent.includes('not empty')`);
					expect(await page.run(`${button(writer, "Create agent")}.disabled`)).toBe(true);
					await snap("agent-invalid", writer);
					await typeOver(page, `${writer}.querySelector('textarea')`, "Write plainly, and ask before sending.");
					await page.until(`!${writer}.querySelector('[role="alert"]')`);
					await snap("agent-edited", writer);
					await page.run(`${button(writer, "Create agent")}.click()`);
					await page.until(`${writer}.innerText.includes('Accepted · Edited by you')`);
					const written = await until(async () => {
						const text = await readFile(join(home, "workspace", "agents", "writer.md"), "utf8").catch(() => "");
						return text.includes("Write plainly") ? text : undefined;
					});
					expect(written).toContain("description: Writes the owner's drafts");
					expect(written).toContain("Write plainly, and ask before sending.");
					expect(written).not.toContain("Write clearly.");
					expect(written).toContain("name: Writer");
					await snap("agent-accepted", writer);

					// ---- a change to the lead: only what it proposes is editable
					await say("change yourself");
					await page.until(`${cardWith("Update agent")}?.querySelector('details')`, 60_000);
					const lead = tile("Update sancho");
					// what it proposes for the instructions is two disclosures deep: Agent details, then Instructions
					await page.run(`${lead}.querySelectorAll('details').forEach((d) => { d.open = true; })`);
					await page.until(`${lead}.querySelector('[aria-label="Edit proposed instructions"]')`);
					expect(await page.run(`${lead}.querySelector('[aria-label="Edit description"]')`)).toBe(null);
					const change = await until(async () =>
						(await items(chat)).find(
							(i): i is Extract<Item, { role: "proposal" }> =>
								i.role === "proposal" && i.proposal.kind === "agentChange" && i.proposal.state === "pending",
						),
					);
					expect(
						await refused(`/proposals/${encodeURIComponent(change.proposal.id)}`, {
							action: "accept",
							edits: { description: "Not proposed" },
						}),
					).toMatch(/description is not part of this change/);
					await page.run(`${lead}.querySelector('[aria-label="Edit proposed instructions"]').click()`);
					await typeOver(page, `${lead}.querySelector('textarea')`, "The owner's lead instructions.");
					await snap("lead-edited", lead);
					await page.run(`${button(lead, "Update agent")}.click()`);
					// the card says it, or has folded into its row already: the chat moved on as the lead changed
					await page.until(
						`(${lead})?.innerText.includes('Accepted · Edited by you') || /Updated\\s+sancho/.test(document.body.innerText)`,
					);
					const sancho = await until(async () => {
						const text = await readFile(join(home, "workspace", "agents", "sancho.md"), "utf8").catch(() => "");
						return text.includes("The owner's lead instructions.") ? text : undefined;
					});
					expect(sancho).not.toContain("Proposed lead instructions.");

					// ---- a routine: when it runs and what it asks
					await say("tea routine");
					await page.until(`${cardWith("Set it up")}?.querySelector('[aria-label="Edit when"]')`, 60_000);
					const tea = tile("asks to set up a routine");
					await snap("routine-proposed", tea);
					// an edit of the words the owner saw: the agent writing it again starts the card afresh
					await page.run(`${tea}.querySelector('[aria-label="Edit each run"]').click()`);
					await typeOver(page, `${tea}.querySelector('textarea')`, "An edit of the first version.");
					await page.until(`${tea}.innerText.includes('Edited by you')`);
					await say("tea again");
					await page.until(
						`[...document.querySelectorAll('.rounded-tile')].some(t => t.innerText.includes('green tea'))`,
						60_000,
					);
					const cards = `[...document.querySelectorAll('.rounded-tile')].filter(t => [...t.querySelectorAll('button')].some(b => b.textContent.trim() === 'Set it up'))`;
					expect(await page.run(`${cards}.some(t => t.innerText.includes('Edited by you'))`)).toBe(false);
					expect(
						await page.run(
							`${cards}.some(t => t.querySelector('textarea')?.value === 'An edit of the first version.')`,
						),
					).toBe(false);
					// a schedule that is no schedule holds the button back
					await page.run(`${tea}.querySelector('[aria-label="Edit when"]').click()`);
					await typeOver(page, `${tea}.querySelector('input')`, "teatime");
					await page.until(`${tea}.querySelector('[role="alert"]')?.textContent.includes('Not a schedule')`);
					expect(await page.run(`${button(tea, "Set it up")}.disabled`)).toBe(true);
					await snap("routine-invalid", tea);
					// a time that has passed reads as a schedule here, and the daemon refuses it: said, the edit kept
					await typeOver(page, `${tea}.querySelector('input')`, "at 2001-01-01 09:00");
					await page.until(`!${tea}.querySelector('[role="alert"]')`);
					await page.run(`${button(tea, "Set it up")}.click()`);
					await page.until(`document.body.innerText.includes("Couldn't set it up")`);
					expect(await page.run(`${tea}.querySelector('input')?.value`)).toBe("at 2001-01-01 09:00");
					await snap("routine-refused", tea);
					await typeOver(page, `${tea}.querySelector('input')`, "every 2h");
					await page.run(`${tea}.querySelector('[aria-label="Done editing when"]').click()`);
					await page.until(`${tea}.innerText.includes('Every 2 hours')`);
					await page.run(`${tea}.querySelector('[aria-label="Edit each run"]').click()`);
					await typeOver(page, `${tea}.querySelector('textarea')`, "Brew the owner a pot of tea, kindly.");
					await snap("routine-edited", tea);
					const waiting = await until(async () =>
						(await api<ControlView>("/control")).routines.find(
							(r) =>
								r.name === "tea" &&
								r.change !== undefined &&
								"routine" in r.change &&
								r.change.routine?.ask.includes("green"),
						),
					);
					const sha = (waiting.change as { sha: string }).sha;
					await page.run(`${button(tea, "Set it up")}.click()`);
					await page.until(
						`[...document.querySelectorAll('.rounded-tile')].some(t => t.innerText.includes('Set up · Edited by you'))`,
					);
					const set = await until(async () =>
						(await api<ControlView>("/control")).routines.find((r) => r.name === "tea" && r.accepted !== undefined),
					);
					expect(set).toMatchObject({
						state: "active",
						accepted: {
							routine: { schedule: "every 2h", ask: "Brew the owner a pot of tea, kindly.", description: "Tea time" },
						},
						edited: [sha],
					});
					expect(set.change).toBeUndefined();
					// the box holds the owner's version
					const box = await readFile(join(home, "workspace", "routines", "tea.md"), "utf8");
					expect(box).toContain("every: 2h");
					expect(box).toContain("Brew the owner a pot of tea, kindly.");
					expect(box).not.toContain("green tea");
					await snap(
						"routine-set",
						`[...document.querySelectorAll('.rounded-tile')].find(t => t.innerText.includes('Set up · Edited by you'))`,
					);
					// opened again, each answered card is a row that reads what is in effect: the owner's words, said to be theirs
					await page.run("location.reload()");
					await page.until(`document.body.textContent.includes('Sancho')`);
					await page.run(`location.hash = '#/a/sancho'`);
					await page.until(`/Created\\s+Writer/.test(document.body.innerText)`);
					const feed = await page.run<string>("document.body.innerText");
					expect(feed).not.toContain("Writes drafts");
					expect(feed).toMatch(/Opened a pull request/);
					// a narrow row keeps only what was done and to what; opening the row shows the card, which says the rest
					if (width >= 768) {
						expect(feed).toMatch(/Created\s+Writer\s+Writes the owner's drafts/);
						expect(feed.match(/as you edited it/g)?.length).toBe(4);
					}
					await snap("folded");
					await page.run(
						`[...document.querySelectorAll('[data-done]')].find(row => /Created\\s+Writer/.test(row.innerText)).querySelector('[aria-label="Show details"]').click()`,
					);
					await page.until(`document.body.innerText.includes('Accepted · Edited by you')`);
					await snap("folded-open", tile("Create Writer"));
					expect(page.errors().filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
				});
			} finally {
				await vite.close();
				await new Promise<void>((resolve) => listener.close(() => resolve()));
				await daemon.close();
				await fake.close();
			}
		},
		240_000,
	);
