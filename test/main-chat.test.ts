/**
 * The main chat (DESIGN.md "The app"): the web's main thread names one chat, the same whatever is written to it and
 * after a restart; every other chat, older ones included, is a side chat.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentMainThread, isAgentMain, isMain, MAIN_THREAD, mainAgentOf, OWNER } from "../src/core/gateway.ts";
import type { Status } from "../src/core/status.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { AgentView, ChatRow, Item, Posted } from "../src/server/api.ts";
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
	/** What `banda say` sends: the lines the daemon answered with. */
	const say = async (text: string, to: { agent?: string; thread?: string } = {}) => {
		const response = await fetch(`http://127.0.0.1:${daemon.port}/api/say`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify({ text, ...to }),
		});
		return response.text();
	};
	return { daemon, api, post, say };
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

	it("is the chat the CLI writes to: the first agent's when it names none, another's by its name", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const { daemon, api, post, say } = await daemonAt(home);
		try {
			// the CLI first: the chat it starts is the one the app shows
			expect(await say("from the terminal")).toContain("re: from the terminal");
			const main = await post({ thread: MAIN_THREAD }, "from the app");
			expect(await say("and again")).toContain("re: and again");
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
			// another agent by its name, the CLI first again
			expect(await say("reader, from the terminal", { agent: "reader" })).toContain("re: reader, from the terminal");
			const readerMain = await post({ thread: agentMainThread("reader") }, "hello reader");
			expect(await say("reader, again", { agent: "reader" })).toContain("re: reader, again");
			// an agent is the only target: a thread, a name that is none, or an agent that is not there starts nothing
			expect(await say("to a thread", { thread: "work" })).toContain("say takes an agent, not a thread");
			expect(await say("to no name", { agent: "Not A Name" })).toContain("agent is an agent's name");
			expect(await say("to nobody", { agent: "nobody" })).toContain("there is no agent named nobody");
			const { chats } = await api<Status>("/status");
			expect(chats.map(({ chat, origin }) => ({ chat, origin })).sort((a, b) => a.chat - b.chat)).toEqual([
				{ chat: main, origin: { gateway: "web", peer: OWNER, thread: MAIN_THREAD } },
				{ chat: readerMain, origin: { gateway: "web", peer: OWNER, thread: "agent:reader" } },
			]);
		} finally {
			await daemon.close();
		}
	}, 60_000);

	it("shows what a routine's run says after the owner last wrote from the CLI", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const { daemon, api, say } = await daemonAt(home);
		try {
			expect(await say("from the terminal")).toContain("re: from the terminal");
			const main = (await api<Status>("/status")).chats[0]!.chat;
			const json = { "content-type": "application/json" };
			const { name } = await api<{ name: string }>("/routines", {
				method: "POST",
				headers: json,
				body: JSON.stringify({ agent: "sancho", description: "Tea", when: "every 24h", ask: "TEA ASK: remind them." }),
			});
			await api(`/routines/sancho/${name}/run`, {
				method: "POST",
				headers: json,
				body: JSON.stringify({ key: "run-tea" }),
			});
			// the run's message is in the agent's chat, where the app reads it, though the owner's last word came from the CLI
			const said = (items: readonly Item[]) =>
				items.filter((item) => item.role === "assistant" && JSON.stringify(item.calls ?? []).includes("TEA ASK"));
			const shown = await until(async () => {
				const found = said((await api<{ items: Item[] }>(`/chats/${main}/items?after=0`)).items);
				return found.length > 0 ? found : undefined;
			});
			expect(shown).toHaveLength(1);
			// and the app's next message goes on in that chat
			expect((await api<Status>("/status")).chats.map(({ chat }) => chat)).toEqual([main]);
		} finally {
			await daemon.close();
		}
	}, 60_000);
});
