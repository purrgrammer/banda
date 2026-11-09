/**
 * The main chat (DESIGN.md "The app"): the web's main thread names one chat, the same whatever is written to it and
 * after a restart; every other chat, older ones included, is a side chat.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentMainThread, isAgentMain, isMain, MAIN_THREAD, mainAgentOf, OWNER } from "../src/core/gateway.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { AgentView, ChatRow, Posted } from "../src/server/api.ts";
import { agentMainOf, mainOf } from "../web/src/lib/chats.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome, until } from "./helpers.ts";

async function daemonAt(home: string) {
	const web = join(home, "web");
	await mkdir(web, { recursive: true });
	await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
	const daemon = await startDaemon({
		home,
		port: 0,
		models: echoModels().models,
		log: () => {},
		box: hostBox(home),
		web,
	});
	const token = (await readDaemonFile(home))!.token!;
	const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
		const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, ...init.headers },
		});
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	};
	const post = async (to: { thread: string } | { chat: number }, text: string) => {
		const posted = await api<Posted>("/messages", {
			method: "POST",
			body: JSON.stringify({ id: randomUUID(), text, ...to }),
		});
		if (!("chat" in posted) || posted.chat === undefined) throw new Error(`refused: ${JSON.stringify(posted)}`);
		return posted.chat;
	};
	return { daemon, api, post };
}

describe("the main chat", () => {
	it("is the web's main thread: one chat, the same after a restart", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		let main: number;
		let side: number;
		{
			const { daemon, api, post } = await daemonAt(home);
			try {
				// a chat from before the main one was ever written to is a side chat
				side = await post({ thread: randomUUID() }, "an older topic");
				main = await post({ thread: MAIN_THREAD }, "hello");
				expect(await post({ thread: MAIN_THREAD }, "again")).toBe(main);
				expect(await post({ chat: main }, "by its id")).toBe(main);
				const rows = await until(async () => {
					const listed = await api<ChatRow[]>("/chats");
					return listed.length >= 2 ? listed : undefined;
				});
				expect(mainOf(rows)?.chat).toBe(main);
				expect(main).not.toBe(side);
			} finally {
				await daemon.close();
			}
		}
		const { daemon, api, post } = await daemonAt(home);
		try {
			expect(mainOf(await api<ChatRow[]>("/chats"))?.chat).toBe(main);
			expect(await post({ thread: MAIN_THREAD }, "after the restart")).toBe(main);
		} finally {
			await daemon.close();
		}
	}, 60_000);

	it("is named by the web's owner and the main thread alone", () => {
		expect(isMain({ gateway: "web", peer: OWNER, thread: MAIN_THREAD })).toBe(true);
		expect(isMain({ gateway: "cli", peer: OWNER, thread: MAIN_THREAD })).toBe(false);
		expect(isMain({ gateway: "web", peer: "someone", thread: MAIN_THREAD })).toBe(false);
		expect(isMain({ gateway: "web", peer: OWNER, thread: "#1" })).toBe(false);
		expect(isMain({ gateway: "web", peer: OWNER })).toBe(false);
		expect(agentMainThread("sancho")).toBe(MAIN_THREAD);
		expect(agentMainThread("travel-planner")).toBe("agent:travel-planner");
		expect(mainAgentOf({ gateway: "web", peer: OWNER, thread: "agent:travel-planner" })).toBe("travel-planner");
		expect(isAgentMain({ gateway: "web", peer: OWNER, thread: "agent:travel-planner" })).toBe(true);
		expect(mainAgentOf({ gateway: "web", peer: OWNER, thread: "agent:Bad" })).toBeUndefined();
		const rows = [
			{ chat: 1, origin: { gateway: "web", peer: OWNER, thread: MAIN_THREAD } },
			{ chat: 2, origin: { gateway: "web", peer: OWNER, thread: "agent:reader" } },
			{ chat: 3, origin: { gateway: "web", peer: OWNER, thread: "side" } },
		] as ChatRow[];
		expect(agentMainOf(rows, "reader")?.chat).toBe(2);
		expect(mainOf(rows)?.chat).toBe(1);
	});

	it("gives every accepted agent one stable main chat and refuses a confused route", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		let readerMain: number;
		{
			const { daemon, api, post } = await daemonAt(home);
			try {
				const dir = join(home, "workspace", "agents");
				await mkdir(dir, { recursive: true });
				await writeFile(
					join(dir, "reader.md"),
					"---\ndescription: Reads carefully\ntools: [read]\n---\nRead carefully.\n",
				);
				const change = await until(async () => {
					const reader = (await api<AgentView[]>("/agents")).find((agent) => agent.name === "reader");
					return reader?.change !== undefined && "sha" in reader.change ? reader.change : undefined;
				});
				await api("/agents/reader/accept", { method: "POST", body: JSON.stringify({ sha: change.sha }) });
				readerMain = await post({ thread: agentMainThread("reader") }, "hello reader");
				expect(await post({ thread: agentMainThread("reader") }, "again")).toBe(readerMain);
				expect(await post({ thread: MAIN_THREAD }, "hello banda")).not.toBe(readerMain);
				const row = (await api<ChatRow[]>("/chats")).find(({ chat }) => chat === readerMain);
				expect(row).toMatchObject({ agent: "reader", origin: { thread: "agent:reader" } });
				await expect(
					api("/messages", {
						method: "POST",
						body: JSON.stringify({
							id: randomUUID(),
							thread: agentMainThread("reader"),
							agent: "writer",
							text: "wrong agent",
						}),
					}),
				).rejects.toThrow(/400 .*reader's main chat, not writer's/);
			} finally {
				await daemon.close();
			}
		}
		const { daemon, post } = await daemonAt(home);
		try {
			expect(await post({ thread: agentMainThread("reader") }, "after restart")).toBe(readerMain);
		} finally {
			await daemon.close();
		}
	}, 60_000);
});
