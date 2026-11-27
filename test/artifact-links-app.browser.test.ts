/**
 * An artifact named in a message's words (DESIGN.md "Messages"), end to end: the model's call, checked against the
 * Library and stored, drawn by the app from a running daemon as the artifact's icon and its title there (never the
 * words the model wrote), a native link that opens it by mouse and keyboard, beside a card the same message asks for;
 * one removed since stays its words, marked unavailable; any other scheme stays as the markdown makes it safe.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { artifactId } from "../src/core/artifacts.ts";
import { startDaemon } from "../src/daemon.ts";
import { ownerToken } from "../src/home.ts";
import type { ChatRow, GroupView, Item } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

type Said = { role: string; content: unknown };
const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

/** Press a key natively, as a person's keyboard does. */
async function press(page: Page, key: string, code: string, keyCode: number, text?: string) {
	await page.input("Input.dispatchKeyEvent", {
		type: "keyDown",
		key,
		code,
		windowsVirtualKeyCode: keyCode,
		...(text === undefined ? {} : { text }),
	});
	await page.input("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
}

it.skipIf(!hasChrome())(
	"a message's artifact link is the Library's title, opens it by click and keyboard beside its card, and a removed one says so",
	async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const token = await ownerToken(home);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// the owner's words script the model: `publish <path> <title>` publishes; `say <n>` makes message_user's call
		// `calls[n]`, so the owner's own words hold no markdown of the model's
		const calls: Parameters<typeof fauxToolCall>[1][] = [];
		faux.setResponses(
			Array.from({ length: 200 }, () => (ctx: { messages: readonly Said[] }) => {
				const last = ctx.messages.at(-1);
				const said = last?.role === "user" ? textOf(last.content) : "";
				const whole = /^say (\d+)$/.exec(said);
				if (whole !== null)
					return fauxAssistantMessage([fauxToolCall("message_user", calls[Number(whole[1])] ?? {})], {
						stopReason: "toolUse",
					});
				const published = /^publish (\S+) (.+)$/.exec(said);
				if (published !== null)
					return fauxAssistantMessage(
						[fauxToolCall("publish", { path: published[1] ?? "", title: (published[2] ?? "").trim() })],
						{ stopReason: "toolUse" },
					);
				return fauxAssistantMessage("done");
			}) as never,
		);
		const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home) });
		const base = `http://127.0.0.1:${daemon.port}`;
		const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const response = await fetch(`${base}/api${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
			});
			if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
			return (await response.json()) as T;
		};
		try {
			const box = (path: string) => join(home, "workspace", path);
			await mkdir(join(home, "workspace"), { recursive: true });
			await writeFile(box("plan.md"), "# Lisbon\n\nFriday: the 09:10 train.\n");
			await writeFile(box("old.md"), "# Old notes\n");
			const plan = artifactId(box("plan.md"));
			const old = artifactId(box("old.md"));
			// the lead's main chat, which the app opens at #/a/sancho
			const thread = "main";
			let chat: number | undefined;
			/** The chat's whole transcript, page after page. */
			const items = async () => {
				const all: Item[] = [];
				let after: number | undefined = chat === undefined ? undefined : 0;
				while (after !== undefined) {
					const page: { items: Item[]; next?: number } = await api(`/chats/${chat}/items?after=${after}`);
					all.push(...page.items);
					after = page.next;
				}
				return all;
			};
			const say = async (text: string) => {
				const before = (await items()).length;
				const posted = await api<{ chat: number }>("/messages", {
					method: "POST",
					body: JSON.stringify({ id: randomUUID(), text, ...(chat === undefined ? { thread } : { chat }) }),
				});
				chat = posted.chat;
				await until(async () => {
					const row = (await api<ChatRow[]>("/chats")).find((one) => one.chat === chat);
					return (await items()).length > before + 2 && row?.state === "idle";
				});
			};
			/** The model's message_user call with `args`, by the owner's word for it. */
			const speak = (args: Parameters<typeof fauxToolCall>[1]) => say(`say ${calls.push(args) - 1}`);
			const lastResult = async () => (await items()).filter((item) => item.role === "tool").at(-1);

			await say("publish plan.md Lisbon trip plan");
			await say("publish old.md Old notes");
			// linked in the words with a label of the model's own, and shown as a card by the same message
			await speak({ text: `Here is [my scribbles](artifact:${plan}), and its card below.`, artifacts: [plan] });
			expect(await lastResult()).toMatchObject({
				error: false,
				text: "Sent. The owner sees “Lisbon trip plan” as its card, at version 1; “Lisbon trip plan” as a link in your words.",
			});
			// linked while it was in the Library, removed since
			await speak({ text: `Earlier: [the old notes](artifact:${old}).` });
			// other schemes stay as the markdown makes them safe, as before
			await speak({ text: "Not links: [run](javascript:alert(1)), [page](data:text/html,<b>x</b>)." });
			// an id the Library never held is refused before anything is sent
			await speak({ text: "Missing: [gone](artifact:0123456789abcdef)." });
			expect(await lastResult()).toMatchObject({ error: true });
			// the owner's own words are never checked: a link that names no artifact is their words, marked unavailable
			await say("Mine: [a guess](artifact:not-an-id) and [x](artifact:javascript:alert(1)).");
			await api(`/artifacts/${old}`, { method: "DELETE" });

			const server = await webServer({
				server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
			});
			try {
				for (const width of [390, 1440])
					await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
						const link = `document.querySelector('[data-artifact-link=""] a')`;
						await page.until("document.body.innerText.includes('Sancho')");
						await page.run("location.hash = '#/a/sancho'");
						await page.until(`document.body.innerText.includes('its card below') && ${link} !== null`);
						await page.until(`document.body.innerText.includes('Mine:')`);
						// the Library's title and kind, never the model's label; a native, in-app link to the artifact
						expect(
							await page.run(
								`[...document.querySelectorAll('[data-artifact-link=""] a')].map(a => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-label'), a.target])`,
							),
						).toEqual([["Lisbon trip plan", `#/artifact/${plan}`, "Lisbon trip plan, document", ""]]);
						expect(await page.run("document.body.innerText.includes('my scribbles')")).toBe(false);
						// the card the message asked for is drawn too, beside the publish's own card: no implicit card for a link
						expect(
							await page.run(
								`[...document.querySelectorAll('[data-tile]')].filter(tile => tile.textContent.includes('Lisbon trip plan')).length`,
							),
						).toBe(2);
						// removed since, or no id (whatever follows the scheme): the words, struck, unavailable, opening nothing
						expect(
							await page.run(
								`[...document.querySelectorAll('[data-artifact-link="unavailable"]')].map(el => [el.textContent, el.querySelector('a')])`,
							),
						).toEqual([
							["the old notes(unavailable)", null],
							["a guess(unavailable)", null],
							["x(unavailable)", null],
						]);
						// nothing navigates by another scheme, and no artifact scheme reaches an href
						expect(
							await page.run(
								`[...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(href => /^(javascript|data|artifact|sha256):/i.test(href))`,
							),
						).toEqual([]);
						expect(await page.run("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
						const shots = process.env.BANDA_ARTIFACT_LINK_SHOTS;
						if (shots !== undefined) {
							await mkdir(shots, { recursive: true });
							await page.run(`${link}.scrollIntoView({ block: 'center' })`);
							await page.shoot(join(shots, `${width}-chat.png`));
						}
						// the keyboard: focused, it shows its ring; Enter opens the artifact in place
						await page.run(`${link}.focus()`);
						expect(
							await page.run(`document.activeElement === ${link} && getComputedStyle(${link}).outlineStyle`),
						).not.toBe("none");
						if (shots !== undefined) await page.shoot(join(shots, `${width}-focused.png`));
						await press(page, "Enter", "Enter", 13, "\r");
						await page.until(`location.hash === '#/artifact/${plan}'`);
						await page.until(`document.body.innerText.includes('Friday: the 09:10 train.')`);
						if (shots !== undefined) await page.shoot(join(shots, `${width}-opened.png`));
						// back, and a click opens it the same way
						await page.run("history.back()");
						await page.until(`location.hash !== '#/artifact/${plan}' && ${link} !== null`);
						await page.click(link);
						await page.until(`location.hash === '#/artifact/${plan}'`);
						expect(page.errors()).toEqual([]);
					});
			} finally {
				await server.close();
			}
		} finally {
			await daemon.close();
		}
	},
	120_000,
);

it.skipIf(!hasChrome())(
	"a card a publish of the same run drew is drawn once, as the model is told",
	async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const token = await ownerToken(home);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// the owner's `go`: one run publishes, then shows by its id what that publish just drew
		faux.setResponses(
			Array.from({ length: 20 }, () => (ctx: { messages: readonly Said[] }) => {
				const last = ctx.messages.at(-1);
				const made = /its id is ([0-9a-f]{16})/.exec(textOf(last?.content))?.[1];
				if (last?.role === "toolResult" && made !== undefined)
					return fauxAssistantMessage([fauxToolCall("message_user", { text: "Shown again.", artifacts: [made] })], {
						stopReason: "toolUse",
					});
				if (last?.role === "user" && textOf(last.content) === "go")
					return fauxAssistantMessage([fauxToolCall("publish", { path: "same.md", title: "Same run" })], {
						stopReason: "toolUse",
					});
				return fauxAssistantMessage("done");
			}) as never,
		);
		const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home) });
		const base = `http://127.0.0.1:${daemon.port}`;
		const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const response = await fetch(`${base}/api${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
			});
			if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
			return (await response.json()) as T;
		};
		try {
			await mkdir(join(home, "workspace"), { recursive: true });
			await writeFile(join(home, "workspace", "same.md"), "# Same run\n");
			const { chat } = await api<{ chat: number }>("/messages", {
				method: "POST",
				body: JSON.stringify({ id: randomUUID(), text: "go", thread: "main" }),
			});
			const shown = await until(async () => {
				const items = (await api<{ items: Item[] }>(`/chats/${chat}/items?after=0`)).items;
				return items.find((item) => item.role === "tool" && item.name === "message_user");
			});
			expect(shown).toMatchObject({
				error: false,
				text: "Sent. The owner sees “Same run” at version 1 as the card your publish drew in this run, not a second one.",
			});
			const server = await webServer({
				server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
			});
			try {
				for (const width of [390, 1440])
					await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
						await page.until("document.body.innerText.includes('Sancho')");
						await page.run("location.hash = '#/a/sancho'");
						await page.until("document.body.innerText.includes('Shown again.')");
						const tiles = `[...document.querySelectorAll('[data-tile]')].filter(tile => tile.textContent.includes('Same run')).length`;
						await page.until(`${tiles} > 0`);
						expect(await page.run(tiles)).toBe(1);
						const shots = process.env.BANDA_ARTIFACT_LINK_SHOTS;
						if (shots !== undefined) {
							await mkdir(shots, { recursive: true });
							await page.shoot(join(shots, `${width}-same-run.png`));
						}
						expect(page.errors()).toEqual([]);
					});
			} finally {
				await server.close();
			}
		} finally {
			await daemon.close();
		}
	},
	120_000,
);

it.skipIf(!hasChrome())(
	"in a group's room, a member's artifact link whose words name the member it asks stays a link beside the mention",
	async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const token = await ownerToken(home);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const results: string[] = [];
		// the researcher, asked: publishes, then names it in a link whose words mention the writer it asks
		faux.setResponses(
			Array.from({ length: 40 }, () => (ctx: { messages: readonly Said[] }) => {
				const researcher = JSON.stringify(ctx.messages.filter((m) => m.role === "system")).includes("RESEARCHER");
				const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
				if (last?.role === "toolResult") {
					const said = textOf(last.content);
					results.push(said);
					const made = /its id is ([0-9a-f]{16})/.exec(said)?.[1];
					if (made !== undefined)
						return fauxAssistantMessage(
							[
								fauxToolCall("message_group", {
									text: `[@Writer see](artifact:${made}) before Friday.`,
									ask: ["Writer"],
								}),
							],
							{ stopReason: "toolUse" },
						);
					return fauxAssistantMessage("done");
				}
				if (researcher && textOf(last?.content).includes("PUBLISH"))
					return fauxAssistantMessage([fauxToolCall("publish", { path: "draft.md", title: "Launch post" })], {
						stopReason: "toolUse",
					});
				return fauxAssistantMessage([fauxToolCall("message_group", { text: "On it." })], { stopReason: "toolUse" });
			}) as never,
		);
		const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home) });
		const base = `http://127.0.0.1:${daemon.port}`;
		const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const response = await fetch(`${base}/api${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
			});
			if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
			return (await response.json()) as T;
		};
		try {
			await until(async () => existsSync(join(home, "workspace", "agents", "sancho.md")));
			for (const [id, name] of [
				["researcher", "Researcher"],
				["writer", "Writer"],
			] as const)
				await api(`/agents/${id}`, {
					method: "PUT",
					body: JSON.stringify({
						text: `---\nname: ${name}\ndescription: ${name} things\ntools: [read]\n---\n${name.toUpperCase()} INSTRUCTIONS.\n`,
						base: null,
					}),
				});
			await writeFile(join(home, "workspace", "draft.md"), "# Launch\n\nFriday.\n");
			const { room } = await api<{ room: number }>("/groups", {
				method: "POST",
				body: JSON.stringify({ members: ["researcher", "writer"] }),
			});
			await api(`/groups/${room}/messages`, {
				method: "POST",
				body: JSON.stringify({ key: randomUUID(), text: "PUBLISH", mentions: ["researcher"] }),
			});
			const posted = await until(async () =>
				(await api<GroupView>(`/groups/${room}`)).messages.find((m) => m.text.includes("before Friday")),
			);
			expect(posted.mentions).toEqual(["writer"]);
			await until(() => results.includes("Posted to the group. The owner sees “Launch post” as a link in your words."));
			const server = await webServer({
				server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
			});
			try {
				for (const width of [390, 1440])
					await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
						await page.until("document.body.innerText.includes('Sancho')");
						await page.run(`location.hash = '#/g/${room}'`);
						await page.until("document.body.innerText.includes('before Friday')");
						const link = `document.querySelector('[data-artifact-link=""] a')`;
						await page.until(`${link} !== null`);
						// the link is whole: the Library's title, opening it; the writer's mention stands before the words
						expect(await page.run(`[${link}.textContent, ${link}.getAttribute('href')]`)).toEqual([
							"Launch post",
							expect.stringMatching(/^#\/artifact\/[0-9a-f]{16}$/),
						]);
						expect(await page.run("document.body.innerText.includes('[@Writer see]')")).toBe(false);
						expect(await page.run("document.body.innerText.includes('Writer see')")).toBe(false);
						const shots = process.env.BANDA_ARTIFACT_LINK_SHOTS;
						if (shots !== undefined) {
							await mkdir(shots, { recursive: true });
							await page.run(`${link}.scrollIntoView({ block: 'center' })`);
							await page.shoot(join(shots, `${width}-group-mention.png`));
						}
						expect(page.errors()).toEqual([]);
					});
			} finally {
				await server.close();
			}
		} finally {
			await daemon.close();
		}
	},
	120_000,
);
