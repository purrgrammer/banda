/**
 * The system prompt and tools in the raw transcript (DESIGN.md "The prompt"): read from the chat's context, the one
 * the request sends, never built a second time; so what the route returns is what the model was sent.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentSystemPrompt, getCurrentTools, type Message } from "@earendil-works/pi-ai";
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
		const { models } = echoModels();
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
			// the daemon's own credential never reaches the model
			expect(JSON.stringify(body)).not.toContain(token);
			expect((await api(`/chats/999999/prompt`)).status).toBe(404);
		} finally {
			await daemon.close();
		}
	});
});
