import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { Connected } from "../src/core/connections.ts";
import { Permissions } from "../src/core/permissions.ts";
import { context, openStore } from "../src/core/store.ts";
import { startDaemon } from "../src/daemon.ts";
import { ownerToken } from "../src/home.ts";
import { connectionDefinition } from "./fixtures/connected.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { startFakeMcp } from "./fixtures/mcp-server.ts";
import { skipShippedSkills, tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const Account = Type.Object({ key: Type.String(), generation: Type.String() });
const Status = Type.Object({
	waits: Type.Array(Type.Object({ key: Type.String(), ask: Type.Object({ args: Type.Object({ account: Account }) }) })),
});
const Grants = Type.Object({
	permissions: Type.Array(Type.Object({ id: Type.String(), scope: Type.String(), agent: Type.String() })),
});
const Agents = Type.Array(
	Type.Object({
		name: Type.String(),
		accepted: Type.Optional(Type.Object({ sha: Type.String(), text: Type.String() })),
		change: Type.Optional(Type.Object({ kind: Type.String(), sha: Type.Optional(Type.String()) })),
	}),
);
const History = Type.Object({
	items: Type.Array(Type.Object({ retained: Type.Array(Type.Object({ kind: Type.String(), path: Type.String() })) })),
});
const button = (text: string) =>
	`[...document.querySelectorAll('button')].find(el => el.getClientRects().length && el.textContent.trim() === ${JSON.stringify(text)})`;
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;

async function shot(page: Page, name: string) {
	const directory = process.env.BANDA_HARDENING_SHOTS;
	if (directory === undefined) return;
	await mkdir(directory, { recursive: true });
	await page.shoot(join(directory, `${name}.png`));
}

async function fixture(respond: FauxResponseFactory, connection?: string) {
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const shipped = join(home, "shipped");
	await mkdir(shipped);
	if (connection !== undefined) await writeFile(join(shipped, "cal.json"), connection);
	const token = await ownerToken(home);
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 100 }, () => respond));
	const daemon = await startDaemon({ home, port: 0, models, shipped, box: hostBox(home), log: () => {} });
	const base = `http://127.0.0.1:${daemon.port}`;
	const api = async <T extends TSchema>(schema: T, path: string, body?: object, method = body ? "POST" : "GET") => {
		const response = await fetch(`${base}/api${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
		const result: unknown = await response.json();
		assert.ok(Value.Check(schema, result), `Invalid response from ${path}`);
		return result satisfies Static<T>;
	};
	await skipShippedSkills(daemon.port, token);
	const server = await webServer({
		server: { proxy: { "/api": { target: base, changeOrigin: true, headers: { origin: base } } } },
	});
	return {
		home,
		models,
		api,
		url: `${server.origin}/#token=${token}`,
		say: (text: string) => api(Type.Unknown(), "/messages", { id: randomUUID(), thread: "agent:sancho", text }),
		close: async () => {
			await server.close();
			await daemon.close();
		},
	};
}

for (const width of [1440, 390]) {
	it.skipIf(!hasChrome())(
		`replacement sign-in keeps permission but refuses an old draft in the app at ${width}px`,
		async () => {
			const fake = await startFakeMcp({ auth: "oauth" });
			fake.user = "ana";
			const sent: { title: unknown; token: string }[] = [];
			const refused: string[] = [];
			fake.onCall = async (_tool, args, authorization) => {
				sent.push({ title: args.title, token: authorization.slice(7) });
				return { text: "Created the invented event." };
			};
			const app = await fixture(
				(request) => {
					const last = request.messages.filter((message) => message.role !== "system").at(-1);
					if (last?.role === "toolResult" && last.toolName === "message_user") return fauxAssistantMessage("Done.");
					if (last?.role === "toolResult" && last.isError) refused.push(JSON.stringify(last.content));
					if (last?.role === "toolResult" && last.toolName !== "tool_search")
						return fauxAssistantMessage(
							[
								fauxToolCall("message_user", {
									text: last.isError
										? "The old draft could not run. The sign-in changed."
										: "The invented event was created.",
								}),
							],
							{ stopReason: "toolUse" },
						);
					const user = [...request.messages].reverse().find((message) => message.role === "user");
					const title = JSON.stringify(user?.content).includes("old draft") ? "Old tea" : "Tea";
					const offered = new Set<string>();
					for (const message of request.messages)
						if (message.role === "system") {
							for (const tool of message.toolsAdded ?? []) offered.add(tool.name);
							for (const tool of message.toolsRemoved ?? []) offered.delete(tool.name);
						}
					return fauxAssistantMessage(
						[
							offered.has("cal__create_event")
								? fauxToolCall("cal__create_event", { title, day: "mon" })
								: fauxToolCall("tool_search", { query: "cal__create_event", limit: 5 }),
						],
						{ stopReason: "toolUse" },
					);
				},
				connectionDefinition({ url: fake.url, auth: "oauth", account: "get_me.login", reads: ["list_events"] }),
			);
			let oldGeneration = "";
			let permissionId = "";
			try {
				await app.api(Type.Unknown(), "/capabilities/connections/cal/add", {});
				const signIn = async (again: boolean) => {
					const started = await app.api(Type.Object({ url: Type.String() }), "/capabilities/connections/cal/signin", {
						agent: "sancho",
						...(again ? { account: "ana" } : {}),
					});
					const consent = await fetch(started.url, { redirect: "manual" });
					const callback = consent.headers.get("location");
					assert.ok(callback);
					const result = await fetch(callback, { redirect: "manual" });
					expect(result.status).toBe(302);
				};
				await signIn(false);
				const listed = await app.api(
					Type.Object({
						connections: Type.Array(
							Type.Object({ name: Type.String(), accepted: Type.Object({ version: Type.String() }) }),
						),
					}),
					"/capabilities",
				);
				const cal = listed.connections.find((connection) => connection.name === "cal");
				assert.ok(cal);
				await app.api(Type.Unknown(), "/capabilities/connections/cal/tools", {
					version: cal.accepted.version,
					settings: { create_event: "ask" },
				});
				const originalTokens = new Set(fake.tokens);
				await withPage(app.url, { width, height: 900 }, async (page) => {
					await page.until(shows("Sancho"));
					await page.run("location.hash='#/a/sancho'");
					await app.say("Create tea.");
					await page.until(button("Allow"));
					const first = await until(async () => (await app.api(Status, "/status")).waits[0]);
					oldGeneration = first.ask.args.account.generation;
					await app.api(Type.Unknown(), `/waits/${first.key}`, {
						answer: "approve",
						type: "approval",
						via: "web",
						permission: { scope: "always" },
					});
					await page.until(shows("The invented event was created."));
					await until(() => sent.length === 1);
					const before = (await app.api(Grants, "/control")).permissions;
					expect(before).toHaveLength(1);
					assert.ok(before[0]);
					permissionId = before[0].id;
					await app.say("Prepare the old draft.");
					await page.until(button("Allow"));
					const pending = await until(async () => (await app.api(Status, "/status")).waits[0]);
					expect(pending.ask.args.account.generation).toBe(oldGeneration);
					await shot(page, `${width}-old-draft`);
					await signIn(true);
					expect((await app.api(Grants, "/control")).permissions).toEqual(before);
					const connections = await app.api(
						Type.Object({
							connections: Type.Array(
								Type.Object({
									name: Type.String(),
									accounts: Type.Array(Type.Object({ account: Type.String(), agents: Type.Array(Type.String()) })),
								}),
							),
						}),
						"/capabilities",
					);
					expect(connections.connections.find((item) => item.name === "cal")?.accounts).toMatchObject([
						{ account: "ana", agents: ["sancho"] },
					]);
					await page.click(button("Allow"));
					await page.until(shows("The old draft could not run. The sign-in changed."));
					expect(sent).toHaveLength(1);
					expect(refused).toHaveLength(1);
					expect(refused[0]).toContain("the sign-in changed since this was prepared");
					expect((await app.api(Status, "/status")).waits).toEqual([]);
					await shot(page, `${width}-old-draft-refused`);
					await app.say("Create fresh tea.");
					await until(() => sent.length === 2);
					await page.until(`document.body.innerText.split('The invented event was created.').length === 3`);
					expect(sent.map((call) => call.title)).toEqual(["Tea", "Tea"]);
					assert.ok(sent[1]);
					expect(originalTokens.has(sent[1].token)).toBe(false);
					expect((await app.api(Status, "/status")).waits).toEqual([]);
					expect(await page.run(`Boolean(${button("Allow")})`)).toBe(false);
					expect(await page.run("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
					expect(page.errors()).toEqual([]);
					await shot(page, `${width}-fresh-write`);
				});
			} finally {
				await app.close();
				await fake.close();
			}
			const store = await openStore(app.home, { models: app.models, registry: createRegistry() });
			try {
				const generation = (await store.snapshot(Connected, context))?.accounts.cal?.ana?.generation;
				expect(generation).not.toBe(oldGeneration);
				const permissions = (await store.snapshot(Permissions, context))?.permissions;
				expect(Object.keys(permissions ?? {})).toEqual([permissionId]);
				expect(permissions?.[permissionId]?.match.account).toEqual({ key: "ana", generation });
			} finally {
				await store.close(context);
			}
		},
		110000,
	);

	it.skipIf(!hasChrome())(
		`the app restores accepted bytes and retains unreadable agent files at ${width}px`,
		async () => {
			let command = "";
			const app = await fixture((request) => {
				const last = request.messages.filter((message) => message.role !== "system").at(-1);
				if (last?.role === "user")
					return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
				if (last?.role === "toolResult" && last.toolName === "bash")
					return fauxAssistantMessage([fauxToolCall("message_user", { text: "The workspace file changed." })], {
						stopReason: "toolUse",
					});
				return fauxAssistantMessage("Done.");
			});
			try {
				const accepted = (await app.api(Agents, "/agents")).find((agent) => agent.name === "sancho")?.accepted;
				assert.ok(accepted);
				await withPage(app.url, { width, height: 900 }, async (page) => {
					await page.until(shows("Sancho"));
					await page.run("location.hash='#/a/sancho'");
					for (const kind of ["invalid-utf8", "link"]) {
						command =
							kind === "invalid-utf8"
								? "printf '\\377\\376\\375' > agents/sancho.md"
								: "printf 'Untrusted linked version' > untrusted-agent.txt && rm agents/sancho.md && ln -s ../untrusted-agent.txt agents/sancho.md";
						await app.say(`Make the ${kind} workspace change.`);
						await page.until(button("Keep as is"));
						if (kind === "invalid-utf8") await page.until(shows("This change isn't a valid agent."));
						const changed = (await app.api(Agents, "/agents")).find((agent) => agent.name === "sancho");
						expect(changed?.change).toBeDefined();
						expect(changed?.change?.sha).toBeUndefined();
						if (kind === "invalid-utf8") expect(await page.run(`${button("Allow")}.disabled`)).toBe(true);
						await shot(page, `${width}-${kind}-pending`);
						await page.click(button("Keep as is"));
						try {
							await page.until(`!(${button("Keep as is")})`);
						} catch (error) {
							await shot(page, `${width}-${kind}-failed`);
							const directory = process.env.BANDA_HARDENING_SHOTS;
							if (directory !== undefined)
								await writeFile(
									join(directory, `${width}-${kind}-failed.json`),
									JSON.stringify(
										{
											shown: await page.run("document.body.innerText"),
											agents: await app.api(Type.Unknown(), "/agents"),
											history: await app.api(Type.Unknown(), "/agents/sancho/publications"),
											link: await lstat(join(app.home, "workspace/agents/sancho.md")).then(
												(file) => file.isSymbolicLink(),
												(error: unknown) => (error instanceof Error ? error.message : String(error)),
											),
										},
										null,
										2,
									),
								);
							throw error;
						}
						await until(
							async () =>
								(await app.api(Agents, "/agents")).find((agent) => agent.name === "sancho")?.change === undefined,
						);
						expect(await readFile(join(app.home, "workspace/agents/sancho.md"), "utf8")).toBe(accepted.text);
						const history = await app.api(History, "/agents/sancho/publications");
						const retained = history.items
							.flatMap((item) => item.retained)
							.filter((version) => version.kind === "unreadable");
						if (kind === "invalid-utf8") {
							expect(retained).toHaveLength(1);
							assert.ok(retained[0]);
							expect(await readFile(retained[0].path)).toEqual(Buffer.from([0xff, 0xfe, 0xfd]));
						} else {
							expect(retained).toHaveLength(2);
							const links = await Promise.all(
								retained.map(async (version) =>
									(await lstat(version.path)).isSymbolicLink() ? readlink(version.path) : null,
								),
							);
							expect(links).toContain("../untrusted-agent.txt");
							expect(await readFile(join(app.home, "workspace/untrusted-agent.txt"), "utf8")).toBe(
								"Untrusted linked version",
							);
						}
						await shot(page, `${width}-${kind}-restored`);
					}
					expect(await page.run("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await app.close();
			}
		},
		110000,
	);
}
