/**
 * The system prompt and tools in the raw transcript (DESIGN.md "The prompt"): read from the chat's context, the one
 * the request sends, never built a second time; so what the route returns is what the model was sent.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { MAIN_THREAD } from "../src/core/gateway.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ChatPrompt, ItemPage, Posted } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome, until } from "./helpers.ts";

describe("a chat's prompt", () => {
	it("is the system prompt and tools the chat's last request sent, and holds no credential", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const web = join(home, "web");
		await mkdir(web, { recursive: true });
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const { models, faux } = echoModels();
		// what each request sends, as the provider receives it
		const sent: (readonly Message[])[] = [];
		const stream = models.streamSimple.bind(models);
		models.streamSimple = ((model, context, options) => {
			sent.push(structuredClone(context.messages));
			return stream(model, context, options);
		}) as typeof models.streamSimple;
		const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
		try {
			const token = (await readDaemonFile(home))!.token!;
			const api = async <T>(path: string, init: RequestInit = {}) => {
				const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
					...init,
					headers: { authorization: `Bearer ${token}`, ...init.headers },
				});
				return { status: response.status, body: (await response.json()) as T };
			};
			const posted = await api<Posted>("/messages", {
				method: "POST",
				body: JSON.stringify({ id: randomUUID(), text: "hello", thread: MAIN_THREAD }),
			});
			if (!("chat" in posted.body) || posted.body.chat === undefined) throw new Error("refused");
			const chat = posted.body.chat;
			await until(async () =>
				(await api<ItemPage>(`/chats/${chat}/items`)).body.items.some(
					(item) => item.role === "assistant" && item.text === "sent: re: hello",
				),
			);
			const { status, body } = await api<ChatPrompt>(`/chats/${chat}/prompt`);
			expect(status).toBe(200);
			const last = sent.at(-1)!;
			expect(body.system).toBe(getCurrentSystemPrompt(last));
			expect(body.system.length).toBeGreaterThan(0);
			expect(body.tools).toEqual(
				getCurrentTools(last).map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: JSON.parse(JSON.stringify(tool.parameters)),
				})),
			);
			expect(body.tools.map((tool) => tool.name)).toContain("message_user");
			// the rarer speaking tools, connect and propose_avatar, load on demand
			expect(body.tools.map((tool) => tool.name).sort()).toEqual([
				"ask_user",
				"bash",
				"edit",
				"forget",
				"message_agent",
				"message_user",
				"propose_agent",
				"propose_agent_change",
				"propose_group",
				"publish",
				"react",
				"read",
				"read_agent_chat",
				"read_search_result",
				"recall",
				"remember",
				"schedule",
				"search",
				"skill",
				"tool_search",
				"watch",
				"web_fetch",
				"write",
			]);
			const discovery = body.tools.find((tool) => tool.name === "tool_search")!;
			expect(Object.keys(discovery.parameters.properties ?? {}).sort()).toEqual(["limit", "query"]);
			expect(body.system).toContain("When an instruction names a tool you do not have, search for it first.");
			// the roster: the lead alone in the band
			expect(body.system).toContain("<roster>\nNo other agent is active in the band");
			// the daemon's own credential never reaches the model
			expect(JSON.stringify(body)).not.toContain(token);
			expect((await api(`/chats/999999/prompt`)).status).toBe(404);
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("tool_search", { query: "propose_avatar", limit: 1 })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall("message_user", { text: "Found the face instructions." })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Discovery finished."),
			]);
			await api("/messages", {
				method: "POST",
				body: JSON.stringify({ id: randomUUID(), text: "Find face instructions", thread: MAIN_THREAD }),
			});
			await until(async () =>
				(await api<ItemPage>(`/chats/${chat}/items`)).body.items.some(
					(item) => item.role === "assistant" && item.text === "Discovery finished.",
				),
			);
			const entries = (await api<ItemPage>(`/chats/${chat}/items`)).body.items;
			const search = entries.find(
				(item) => item.role === "assistant" && item.calls?.some((call) => call.name === "tool_search"),
			)!;
			const loaded = entries.find(
				(item) =>
					item.role === "assistant" && item.id > search.id && item.calls?.some((call) => call.name === "message_user"),
			)!;
			const before = (await api<ChatPrompt>(`/chats/${chat}/prompt?at=${search.id}`)).body;
			const after = (await api<ChatPrompt>(`/chats/${chat}/prompt?at=${loaded.id}`)).body;
			expect(before.tools.map((tool) => tool.name)).not.toContain("propose_avatar");
			expect(after.tools.map((tool) => tool.name)).toContain("propose_avatar");
			// the face guide arrives with the tool, and costs a chat nothing before it
			expect(before.system).not.toContain("Avatar geometry designer");
			expect(after.system).toContain("Avatar geometry designer");
			// its group leaves once none of its tools is left to load; connect is still to load
			expect(before.system).toMatch(/On demand: .*\bavatar\b/);
			expect(after.system).not.toMatch(/On demand: .*\bavatar\b/);
			expect(after.system).toMatch(/On demand: .*\bconnections\b/);
			expect(entries.filter((item) => item.role === "tool" && item.error)).toEqual([]);
		} finally {
			await daemon.close();
		}
	});
});
