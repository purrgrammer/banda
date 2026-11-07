/**
 * Every agent makes routines (DESIGN.md "Agents"): a permanent agent gets `schedule` whatever its file
 * names, never the lead's own proposals; a routine it writes wakes as it, with its identity and tools, in its one chat.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ControlView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until } from "./helpers.ts";

const RESEARCHER =
	"---\nname: Researcher\ndescription: Finds things out\ntools: [read]\n---\nRESEARCHER INSTRUCTIONS: dig deep.\n";

type Request = { readonly prompt: string; readonly tools: readonly string[]; readonly text: string };

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

/** The prompt a request carries: its system messages, replayed. */
const promptOf = (ctx: ModelContext) => JSON.stringify(ctx.messages.filter((m) => m.role === "system"));

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

describe("a permanent agent's routines", () => {
	it("its routines wake as it", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const web = join(home, "web");
		await mkdir(web, { recursive: true });
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const requests: Request[] = [];
		const plans: { [said: string]: [string, object] } = {
			digest: [
				"schedule",
				{ name: "daily-digest", description: "Daily digest", every: "1d", ask: "DIGEST MARKER: gather the news." },
			],
		};
		const respond = (ctx: ModelContext) => {
			// a section that changed comes as a system message after the owner's
			const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
			const text = textOf(last?.content);
			requests.push({ prompt: promptOf(ctx), tools: toolsOf(ctx), text });
			const react = fauxAssistantMessage([fauxToolCall("message_user", { reaction: "👍" })], {
				stopReason: "toolUse",
			});
			if (last?.role === "toolResult" && last.toolName !== "tool_search") {
				if (last.toolName === "message_user") return fauxAssistantMessage("done");

				return react;
			}
			const input = [...ctx.messages].reverse().find((message) => message.role === "user");
			const plan = plans[textOf(input?.content)];
			if (plan === undefined) return react;
			if (!toolsOf(ctx).includes(plan[0]))
				return fauxAssistantMessage([fauxToolCall("tool_search", { query: plan[0], limit: 1 })], {
					stopReason: "toolUse",
				});
			return fauxAssistantMessage([fauxToolCall(plan[0], plan[1] as never)], { stopReason: "toolUse" });
		};
		faux.setResponses(Array.from({ length: 200 }, () => respond as never));
		const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
		const token = (await readDaemonFile(home))!.token!;
		const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, ...init.headers },
			});
			if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
			return (await response.json()) as T;
		};
		const say = (text: string, thread: string) =>
			api<{ chat: number }>("/messages", { method: "POST", body: JSON.stringify({ id: randomUUID(), thread, text }) });
		const allowAndRun = async (name: string) => {
			const routine = await until(async () =>
				(await api<ControlView>("/control")).routines.find((each) => each.name === name),
			);
			const sha = routine.change !== undefined && "sha" in routine.change ? routine.change.sha : null;
			await api(`/routines/${name}/accept`, { method: "POST", body: JSON.stringify({ sha }) });
			await api(`/routines/${name}/run`, { method: "POST", body: JSON.stringify({ key: `run-${name}` }) });
		};
		const wakeOf = (marker: string) => until(async () => requests.find((request) => request.text.includes(marker)));
		try {
			await until(async () => existsSync(join(home, "workspace", "agents", "sancho.md")));
			await api("/agents/researcher", { method: "PUT", body: JSON.stringify({ text: RESEARCHER, base: null }) });
			const main = "agent:researcher";

			// a routine it writes in its main chat wakes there, as it
			await say("digest", main);
			const researcher = await until(async () =>
				requests.find((request) => request.prompt.includes("RESEARCHER INSTRUCTIONS")),
			);
			expect(researcher.tools).toEqual(expect.arrayContaining(["read", "message_user", "tool_search"]));
			expect(researcher.tools).not.toContain("schedule");
			for (const tool of ["propose_identity", "propose_preference", "bash"])
				expect(researcher.tools, tool).not.toContain(tool);
			await allowAndRun("daily-digest");
			const digest = await wakeOf("DIGEST MARKER");
			expect(digest.prompt).toContain("RESEARCHER INSTRUCTIONS");
			expect(digest.tools).toContain("read");
			expect(digest.tools).not.toContain("bash");
			// it is the researcher's, and woke in the researcher's one chat: no chat of its own
			const control = await api<ControlView>("/control");
			expect(control.routines.find((each) => each.name === "daily-digest")?.agent).toBe("researcher");
			const rows = await api<{ origin: { thread?: string }; agent: string }[]>("/chats");
			expect(rows.filter((row) => row.agent === "researcher").map((row) => row.origin.thread)).toEqual([main]);
		} finally {
			await daemon.close();
		}
	}, 90_000);
});
