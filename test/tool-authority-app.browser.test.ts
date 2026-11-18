import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
} from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { ownerToken } from "../src/home.ts";
import { connectionDefinition } from "./fixtures/connected.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { startFakeMcp } from "./fixtures/mcp-server.ts";
import { skipShippedSkills, tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const Account = Type.Object({ key: Type.String(), generation: Type.String() });
const Status = Type.Object({
	waits: Type.Array(
		Type.Object({
			key: Type.String(),
			ask: Type.Object({
				args: Type.Object({
					title: Type.String(),
					account: Type.Optional(Account),
					as_account: Type.Optional(Account),
				}),
			}),
		}),
	),
});
const Grants = Type.Object({
	permissions: Type.Array(Type.Object({ id: Type.String(), scope: Type.String(), agent: Type.String() })),
});
const Capabilities = Type.Object({
	connections: Type.Array(Type.Object({ name: Type.String(), accepted: Type.Object({ version: Type.String() }) })),
});
const button = (text: string) =>
	`[...document.querySelectorAll('button')].find(el => el.getClientRects().length && el.textContent.trim() === ${JSON.stringify(text)})`;
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;

async function shot(page: Page, name: string) {
	const directory = process.env.BANDA_TOOL_AUTHORITY_SHOTS;
	if (directory === undefined) return;
	await mkdir(directory, { recursive: true });
	await page.shoot(join(directory, `${name}.png`));
}

async function fixture(respond: FauxResponseFactory, connection: string) {
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const shipped = join(home, "shipped");
	await mkdir(shipped);
	await writeFile(join(shipped, "cal.json"), connection);
	const token = await ownerToken(home);
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 100 }, () => respond));
	const daemon = await startDaemon({ home, port: 0, models, shipped, box: hostBox(home), log: () => {} });
	const base = `http://127.0.0.1:${daemon.port}`;
	const api = async <T extends TSchema>(schema: T, path: string, body?: object): Promise<Static<T>> => {
		const response = await fetch(`${base}/api${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
		const result: unknown = await response.json();
		assert.ok(Value.Check(schema, result), `Invalid response from ${path}`);
		return result;
	};
	await skipShippedSkills(daemon.port, token);
	const server = await webServer({
		server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
	});
	return {
		api,
		url: `${server.origin}/#token=${token}`,
		say: (text: string) => api(Type.Object({}), "/messages", { id: randomUUID(), thread: "agent:sancho", text }),
		close: async () => {
			await server.close();
			await daemon.close();
		},
	};
}

for (const width of [1440, 390]) {
	it.skipIf(!hasChrome())(
		`a changed tool refuses old authority and asks again in the app at ${width}px`,
		async () => {
			const fake = await startFakeMcp({ auth: "oauth" });
			fake.user = "ana";
			const originalTools = fake.tools.map((tool) =>
				tool.name !== "create_event"
					? tool
					: {
							...tool,
							inputSchema: {
								...tool.inputSchema,
								properties: { title: { type: "string" }, day: { type: "string" }, account: { type: "object" } },
							},
						},
			);
			fake.tools = originalTools;
			let provider = { key: "ana", generation: "fixture-discovery" };
			let field: "account" | "as_account" = "account";
			const sent: { args: unknown; token: string }[] = [];
			const refused: string[] = [];
			fake.onCall = async (_tool, args, authorization) => {
				sent.push({ args, token: authorization.slice(7) });
				return { text: "Created the invented event." };
			};
			const app = await fixture(
				(request) => {
					const last = request.messages.filter((message) => message.role !== "system").at(-1);
					if (last?.role === "toolResult" && last.toolName === "message_user") return fauxAssistantMessage("Done.");
					if (last?.role === "toolResult" && last.isError) refused.push(JSON.stringify(last.content));
					if (last?.role === "toolResult" && last.toolName !== "tool_search")
						return fauxAssistantMessage([fauxToolCall("message_user", { text: "The request finished." })], {
							stopReason: "toolUse",
						});
					const user = [...request.messages].reverse().find((message) => message.role === "user");
					const text = JSON.stringify(user?.content);
					const title = text.includes("old draft") ? "Old tea" : text.includes("Discover") ? "Discovery" : "Tea";
					const offered = getCurrentTools(request.messages);
					return fauxAssistantMessage(
						[
							offered.some((tool) => tool.name === "cal__create_event")
								? fauxToolCall("cal__create_event", { title, day: "mon", [field]: provider })
								: fauxToolCall("tool_search", { query: "cal__create_event", limit: 5 }),
						],
						{ stopReason: "toolUse" },
					);
				},
				connectionDefinition({ url: fake.url, auth: "oauth", account: "get_me.login", reads: ["list_events"] }),
			);
			try {
				await app.api(Type.Object({}), "/capabilities/connections/cal/add", {});
				const signIn = async (again: boolean) => {
					const started = await app.api(Type.Object({ url: Type.String() }), "/capabilities/connections/cal/signin", {
						agent: "sancho",
						...(again ? { account: "ana" } : {}),
					});
					const consent = await fetch(started.url, { redirect: "manual" });
					const callback = consent.headers.get("location");
					assert.ok(callback);
					expect((await fetch(callback, { redirect: "manual" })).status).toBe(302);
				};
				const enableTool = async () => {
					const cal = (await app.api(Capabilities, "/capabilities")).connections.find((item) => item.name === "cal");
					assert.ok(cal);
					await app.api(Type.Object({}), "/capabilities/connections/cal/tools", {
						version: cal.accepted.version,
						settings: { create_event: "ask" },
					});
				};
				await signIn(false);
				await enableTool();
				const originalTokens = new Set(fake.tokens);
				await withPage(app.url, { width, height: 900 }, async (page) => {
					await page.until(shows("Sancho"));
					await page.run("location.hash='#/a/sancho'");
					await app.say("Discover the fixture account generation.");
					await page.until(button("Allow"));
					const discovery = await until(async () => (await app.api(Status, "/status")).waits[0]);
					assert.ok(discovery.ask.args.as_account);
					provider = { ...discovery.ask.args.as_account };
					await page.click(button("Don't allow"));
					await page.until(shows("The request finished."));
					expect(sent).toEqual([]);
					await app.say("Create tea.");
					await page.until(button("Allow"));
					const first = await until(async () => (await app.api(Status, "/status")).waits[0]);
					expect(first.ask.args.account).toEqual(provider);
					await app.api(Type.Object({ chat: Type.Number() }), `/waits/${first.key}`, {
						answer: "approve",
						type: "approval",
						via: "web",
						permission: { scope: "always" },
					});
					await until(() => sent.length === 1);
					await page.until(`document.body.innerText.split('The request finished.').length === 3`);
					expect(sent[0]?.args).toEqual({ title: "Tea", day: "mon", account: provider });
					assert.ok(sent[0]);
					expect(originalTokens.has(sent[0].token)).toBe(true);
					const granted = (await app.api(Grants, "/control")).permissions;
					expect(granted).toHaveLength(1);
					expect(granted[0]).toMatchObject({ scope: "always", agent: "sancho" });
					await app.say("Prepare an old draft.");
					await page.until(button("Allow"));
					const pending = await until(async () => (await app.api(Status, "/status")).waits[0]);
					expect(pending.ask.args.as_account).toEqual(provider);
					await shot(page, `${width}-old-draft`);
					fake.tools = originalTools.filter((tool) => tool.name !== "create_event");
					await app.api(Type.Object({}), "/capabilities/connections/cal/refresh", {});
					fake.tools = originalTools.map((tool) =>
						tool.name !== "create_event"
							? tool
							: {
									...tool,
									inputSchema: {
										...tool.inputSchema,
										properties: { title: { type: "string" }, day: { type: "string" }, as_account: { type: "object" } },
									},
								},
					);
					await app.api(Type.Object({}), "/capabilities/connections/cal/refresh", {});
					await enableTool();
					expect((await app.api(Grants, "/control")).permissions).toEqual([]);
					await signIn(true);
					await page.click("[...document.querySelectorAll('[role=checkbox]')].find(el => el.getClientRects().length)");
					await page.click(button("Allow"));
					await page.until(shows("Couldn't allow"));
					await page.until("document.body.innerText.toLowerCase().includes('connection tool changed')");
					await page.until(
						"[...document.querySelectorAll('[data-sonner-toast]')].some(el => el.textContent.toLowerCase().includes('connection tool changed') && getComputedStyle(el).opacity === '1' && el.getBoundingClientRect().bottom <= innerHeight)",
					);
					expect(sent).toHaveLength(1);
					expect((await app.api(Grants, "/control")).permissions).toEqual([]);
					expect((await app.api(Status, "/status")).waits.map((wait) => wait.key)).toEqual([pending.key]);
					await shot(page, `${width}-old-authority-refused`);
					await page.click(button("Don't allow"));
					await page.until(`document.body.innerText.split('The request finished.').length === 4`);
					await page.until("!document.querySelector('[data-sonner-toast]')");
					field = "as_account";
					refused.length = 0;
					await app.say("Create tea after the tool changed.");
					const fresh = await until(async () => {
						const waiting = (await app.api(Status, "/status")).waits[0];
						assert.equal(sent.length, 1, "The changed tool sent before fresh owner approval");
						expect(refused, "A fresh request must reach its own approval").toEqual([]);
						return waiting;
					});
					expect(fresh.key).not.toBe(pending.key);
					expect(fresh.ask.args.as_account).toEqual(provider);
					assert.ok(fresh.ask.args.account);
					expect(fresh.ask.args.account.key).toBe("ana");
					expect(fresh.ask.args.account.generation).not.toBe(provider.generation);
					await page.until(button("Allow"));
					if (await page.run(`Boolean(${button("Latest")})`)) await page.click(button("Latest"));
					await page.until(`(() => {
						const el = ${button("Allow")};
						if (!el) return false;
						const rect = el.getBoundingClientRect();
						return rect.top >= 48 && rect.bottom <= innerHeight;
					})()`);
					await shot(page, `${width}-fresh-approval`);
					await page.click(button("Allow"));
					await until(() => sent.length === 2);
					await page.until(`document.body.innerText.split('The request finished.').length === 5`);
					expect(sent[1]?.args).toEqual({ title: "Tea", day: "mon", as_account: provider });
					assert.ok(sent[1]);
					expect(originalTokens.has(sent[1].token)).toBe(false);
					expect(fake.tokens.has(sent[1].token)).toBe(true);
					expect((await app.api(Status, "/status")).waits).toEqual([]);
					expect((await app.api(Grants, "/control")).permissions).toEqual([]);
					expect(await page.run("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
					expect(page.errors()).toEqual([]);
					await shot(page, `${width}-approved-once`);
				});
			} finally {
				await app.close();
				await fake.close();
			}
		},
		110000,
	);
}
