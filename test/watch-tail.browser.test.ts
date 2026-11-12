/**
 * A pull request with more reviews and comments than a page holds, followed through the app against a throwaway daemon
 * and a fake GitHub that pages them oldest first as GitHub does (#34): the newest of each wakes the agent's chat, the
 * window moving on or sliding back never says one is gone, and every look reads a bounded number of pages. The store
 * and the requests GitHub got are what is asserted; the screenshots (`BANDA_WATCHES_SHOTS`) are for the eye.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import type { Item } from "../src/core/follow.ts";
import { context, openStore } from "../src/core/store.ts";
import { Routes } from "../src/core/turn.ts";
import { Followed, TELL, WAKE, type WatchWakeData } from "../src/core/watches.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { CapabilitiesView, WatchView } from "../src/server/api.ts";
import { githubObjectDefinition, startGithubObjects } from "./fixtures/github-objects.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, skipShippedSkills, tempHome, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

const SHOTS = process.env.BANDA_WATCHES_SHOTS;
const LINK = "https://github.com/acme/banda/pull/142";
const REPLY = "Read the newest review and comment on banda#142.";

const visible = "el.getClientRects().length > 0";
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
/** A feed line of the watch: the pull request as a reference, then the changes in the kind's words. */
const line = (...words: string[]) =>
	`[...document.querySelectorAll('p')].some(el => ${visible} && el.textContent.includes('Keep objects as data: ') && ${words
		.map((word) => `el.textContent.includes(${JSON.stringify(word)})`)
		.join(" && ")})`;

const comments = (from: number, to: number, login?: string): Item[] =>
	Array.from({ length: to - from + 1 }, (_, i) => ({
		id: from + i,
		user: { login: login ?? `c${from + i}` },
		body: `comment ${from + i}`,
		created_at: "2026-11-12T09:00:00Z",
	}));
const reviews = (from: number, to: number): Item[] =>
	Array.from({ length: to - from + 1 }, (_, i) => ({
		id: from + i,
		user: { login: `r${from + i}` },
		state: "COMMENTED",
	}));

/**
 * GitHub at each step: 160 comments and 160 reviews; then bob's comment and carol's approval, the newest; then a
 * hundred comments more from dana, so the reading moves on a page; then the seventy newest deleted, so it starts
 * again at the first page and the hundred oldest come back into it.
 */
const BOB = { id: 161, user: { login: "bob" }, body: "The newest comment", created_at: "2026-11-12T10:00:00Z" };
const CAROL = { id: 10_161, user: { login: "carol" }, state: "APPROVED" };
function world(step: number): { comments: Item[]; reviews: Item[] } {
	const all = [...comments(1, 160), BOB, ...comments(162, 261, "dana")];
	const count = [160, 161, 261, 191][Math.min(step, 3)] ?? 160;
	return { comments: all.slice(0, count), reviews: [...reviews(10_001, 10_160), ...(step >= 1 ? [CAROL] : [])] };
}

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`more reviews and comments than a page: the newest wake and none is said gone, through the app at ${width}`,
		async () => {
			const phone = width < 768;
			const home = await tempHome();
			if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
			let step = 0;
			/** Each page GitHub was asked, by step and method. */
			const asked: { step: number; method: string; page: number }[] = [];
			const github = await startGithubObjects({ auth: "oauth" });
			github.user = "bandarra";
			github.onCall = async (tool, args) => {
				if (tool !== "pull_request_read") return { text: "not in this world", isError: true };
				const at = world(step);
				const method = String(args.method);
				const paged = (items: Item[]) => {
					const size = Number(args.perPage ?? 30);
					const page = Number(args.page ?? 1);
					asked.push({ step, method, page });
					return { text: JSON.stringify(items.slice((page - 1) * size, page * size)) };
				};
				if (method === "get_comments") return paged(at.comments);
				if (method === "get_reviews") return paged(at.reviews);
				if (method === "get_check_runs")
					return {
						text: JSON.stringify({
							total_count: 1,
							check_runs: [{ id: 1, name: "unit", status: "completed", conclusion: "success" }],
						}),
					};
				if (method === "get")
					return {
						text: JSON.stringify({
							number: 142,
							title: "Keep objects as data",
							state: "open",
							draft: false,
							merged: false,
							user: { login: "ana" },
							head: { ref: "objects", sha: "a1" },
							additions: 42,
							deletions: 6,
							comments: at.comments.length,
							html_url: LINK,
						}),
					};
				return { text: `no ${method}`, isError: true };
			};
			const shipped = join(home, "shipped");
			await mkdir(shipped, { recursive: true });
			await writeFile(join(shipped, "github.json"), githubObjectDefinition(github.url));
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const models = createModels();
			const faux = fauxProvider();
			models.setProvider(faux.provider);
			faux.setResponses(
				Array.from({ length: 10 }, () => [
					() => fauxAssistantMessage([fauxToolCall("message_user", { text: REPLY })], { stopReason: "toolUse" }),
					() => fauxAssistantMessage(""),
				]).flat(),
			);
			const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), shipped, log: () => {} });
			let closed = false;
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
			/** Pages asked of `method` at `at`. */
			const pages = (at: number, method: string) =>
				asked.filter((each) => each.step === at && each.method === method).map((each) => each.page);
			try {
				await skipShippedSkills(daemon.port, token);
				await api("/agents/mara", "PUT", {
					base: null,
					text: "---\nname: Mara\ndescription: Follows things\nconnections: [github]\n---\nFollow things for the owner.\n",
				});
				await api("/capabilities/connections/github/add", "POST", {});
				const started = await api<{ url: string }>("/capabilities/connections/github/signin", "POST", {
					agent: "mara",
				});
				const consent = await fetch(started.url, { redirect: "manual" });
				await fetch(consent.headers.get("location") as string, { redirect: "manual" });
				while ((await connection())?.state !== "connected") await new Promise((resolve) => setTimeout(resolve, 50));

				// the owner follows it; its first look is the baseline: 160 of each, the newest in it, no wake
				const made = await api<{ name: string }>("/watches", "POST", { agent: "mara", object: LINK });
				const name = made.name;
				const check = async (key: string) =>
					(
						await api<{ looked: unknown; watches: WatchView[] }>(`/watches/${name}/check`, "POST", { key })
					).watches.find((each) => each.name === name);
				// the baseline's look runs on its own; a look now waits for it, and changes nothing (the world has not moved)
				const deadline = Date.now() + 20_000;
				while (pages(0, "get_reviews").length < 2) {
					// a tail read the daemon refuses (its page not taken as the definition's) never reaches GitHub
					if (Date.now() > deadline) throw new Error(`the baseline read no pages of reviews: ${JSON.stringify(asked)}`);
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				expect((await check("k0"))?.saw ?? []).toEqual([]);
				expect(pages(0, "get_comments")).toEqual([1, 2, 1, 2]);
				expect(pages(0, "get_reviews")).toEqual([1, 2, 1, 2]);

				await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
					const shot = async (shotName: string) => {
						expect(
							await page.run("document.documentElement.scrollWidth <= innerWidth"),
							`${shotName}: no sideways scroll`,
						).toBe(true);
						expect(page.errors(), `${shotName}: no page errors`).toEqual([]);
						await page.until(
							"document.getAnimations().every(a => a.playState !== 'running' || !(a.effect?.getComputedTiming().endTime < 2000))",
						);
						if (SHOTS !== undefined) await page.shoot(join(SHOTS, `tail-${width}-${shotName}.png`));
					};
					await page.until(shows("Mara"));
					await page.run(`location.hash='#/a/mara'`);

					// the newest comment and review: one wake, for them alone
					step = 1;
					const first = await check("k1");
					expect(first?.behind).toBeUndefined();
					await page.until(line("bob commented", "carol approved"));
					await page.until(shows(REPLY));
					await shot("1-newest-wake");
					expect(pages(1, "get_comments")).toEqual([1, 2]);
					expect(pages(1, "get_reviews")).toEqual([1, 2]);

					// a hundred more: the reading moves on to the last pages, its oldest hundred pushed off, not gone
					step = 2;
					const second = await check("k2");
					expect(second?.behind).toBeUndefined();
					await page.until(line("dana commented"));
					await shot("2-window-moved");
					expect(pages(2, "get_comments")).toEqual([2, 3]);

					// the seventy newest deleted: the reading starts at the first page again, and nothing wakes or tells
					step = 3;
					const third = await check("k3");
					expect(third?.behind).toBeUndefined();
					expect(pages(3, "get_comments")).toEqual([1, 2]);
					if (!phone) await page.until(shows("Keep objects as data"));
					await shot("3-window-slid-back");
					expect(asked.length).toBeLessThanOrEqual(4 * (2 + 3 + 3));
				});
				await server.close();
				await daemon.close();
				closed = true;

				// the store, as the daemon left it: what woke, what told, and what the reading holds
				const harness = await openStore(home, { models: echoModels().models, registry: createRegistry() });
				try {
					const routes = (await harness.snapshot(Routes, context))?.routes ?? {};
					const wakes: WatchWakeData[] = [];
					const tells: WatchWakeData[] = [];
					for (const { chat } of Object.values(routes) as { chat: number }[]) {
						const entries = await (await harness.conversation(chat as ConversationId, context))!.entries(
							{ order: "ascending" },
							1000,
							undefined,
							context,
						);
						for (const entry of entries.items) {
							if (entry.kind === WAKE) wakes.push(entry.data as unknown as WatchWakeData);
							if (entry.kind === TELL) tells.push(entry.data as unknown as WatchWakeData);
						}
					}
					expect(wakes.map((wake) => [...wake.changes].sort())).toEqual([
						["bob commented", "carol approved"],
						["dana commented"],
					]);
					expect(wakes.some((wake) => wake.gap === true)).toBe(false);
					expect(tells).toEqual([]);
					const readings = Object.values((await harness.snapshot(Followed, context))?.objects ?? {});
					expect(readings).toHaveLength(1);
					const reading = readings[0]!;
					const ids = (list: unknown) => (list as Item[]).map((item) => item.id);
					// the newest reading: the first two pages of 191 comments, every review (161) from the first page on
					expect(ids(reading.answers.comments)).toEqual([...Array.from({ length: 191 }, (_, i) => i + 1)]);
					expect(ids(reading.answers.reviews)).toHaveLength(161);
					expect(ids(reading.answers.reviews).at(-1)).toBe(10_161);
					expect(reading.lengths).toEqual({ comments: 191, reviews: 161 });
					// the reading before it held the window moved on: 101..261, never the first hundred
					const before = reading.earlier?.at(-1)?.answers.comments as Item[] | undefined;
					expect(before?.[0]?.id).toBe(101);
					expect(before?.at(-1)?.id).toBe(261);
				} finally {
					await harness.close(context).catch(() => {});
				}
			} finally {
				await server.close().catch(() => {});
				if (!closed) await daemon.close();
				await github.close();
			}
		},
		120000,
	);
