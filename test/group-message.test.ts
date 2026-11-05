/**
 * How a group member speaks (DESIGN.md "Groups", "Messages"): `message_group`, never `message_user`, and only in a
 * group. Its `ask` is an enum of the group's other active members, by the names the group shows, so a model cannot name
 * anyone else: the schema each request offers follows the group as it is at that turn (members added, removed,
 * archived), has no `ask` when nobody else is there, and a call naming anyone outside it is refused before it runs.
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
import { shaOf } from "../src/core/agents.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { GroupView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until } from "./helpers.ts";

const agentFile = (name: string, marker: string, state = "") =>
	`---\nname: ${name}\n${state}description: ${name} things\ntools: [read]\n---\n${marker} INSTRUCTIONS.\n`;

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

type Schema = { properties?: { [name: string]: Schema }; items?: Schema; anyOf?: Schema[]; const?: unknown };

/** The names an offered `message_group` lets `ask` name; undefined when it has no `ask`. */
type Offered = { readonly name: string; readonly parameters?: unknown };

/** The tools a request offers: each system message's additions and removals, replayed in order. */
function offered(ctx: ModelContext): Offered[] {
	const tools = new Map<string, Offered>();
	for (const message of ctx.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool as Offered);
	}
	return [...tools.values()];
}

function askable(tools: readonly Offered[]): string[] | undefined {
	const tool = tools?.find((each) => each.name === "message_group");
	const items = (tool?.parameters as Schema | undefined)?.properties?.ask?.items;
	if (items === undefined) return undefined;
	return (items.anyOf ?? [items]).map((each) => String(each.const));
}

describe("message_group", () => {
	it("offers a member exactly the other active members to ask, as the group is at each turn", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const web = join(home, "web");
		await mkdir(web, { recursive: true });
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const requests: { agent: string; text: string; tools: string[]; ask: string[] | undefined }[] = [];
		const results: { agent: string; text: string; error: boolean }[] = [];
		const respond = (ctx: ModelContext) => {
			const prompt = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
			const agent = ["WRITER", "RESEARCHER", "EDITOR"].find((marker) => prompt.includes(`${marker} INSTRUCTIONS`));
			const who = agent?.toLowerCase() ?? "lead";
			const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
			if (last?.role === "toolResult") {
				results.push({ agent: who, text: textOf(last.content), error: last.isError });
				return fauxAssistantMessage("done");
			}
			const text = textOf(last?.content);
			const tools = offered(ctx);
			requests.push({ agent: who, text, tools: tools.map((tool) => tool.name), ask: askable(tools) });
			if (text.includes("SPEAK AS USER"))
				return fauxAssistantMessage([fauxToolCall("message_user", { text: "to the owner?" })], {
					stopReason: "toolUse",
				});
			// in its own chat, an agent speaks to the owner
			if (!tools.some((tool) => tool.name === "message_group"))
				return fauxAssistantMessage([fauxToolCall("message_user", { text: "hi" })], { stopReason: "toolUse" });
			if (text.includes("ASK MALLORY"))
				return fauxAssistantMessage([fauxToolCall("message_group", { text: "Mallory?", ask: ["Mallory"] })], {
					stopReason: "toolUse",
				});
			if (text.includes("ASK RESEARCHER"))
				return fauxAssistantMessage([fauxToolCall("message_group", { text: "Over to you", ask: ["Researcher"] })], {
					stopReason: "toolUse",
				});
			return fauxAssistantMessage([fauxToolCall("message_group", { text: `${who} reply` })], { stopReason: "toolUse" });
		};
		faux.setResponses(Array.from({ length: 100 }, () => respond as never));
		const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
		const token = (await readDaemonFile(home))!.token!;
		const call = (path: string, init: RequestInit = {}) =>
			fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, ...init.headers },
			});
		const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const response = await call(path, init);
			if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
			return (await response.json()) as T;
		};
		/** Ask `agent` with `text`, and wait for its turn's first request. */
		const turn = async (room: number, agent: string, text: string) => {
			const before = requests.length;
			const response = await call(`/groups/${room}/messages`, {
				method: "POST",
				body: JSON.stringify({ key: randomUUID(), text, mentions: [agent] }),
			});
			expect(response.status).toBe(200);
			return until(async () => requests.slice(before).find((request) => request.agent === agent));
		};
		const put = (room: number, body: object) =>
			api<GroupView>(`/groups/${room}`, { method: "PUT", body: JSON.stringify(body) });
		try {
			await until(async () => existsSync(join(home, "workspace", "agents", "sancho.md")));
			for (const [id, name, marker] of [
				["writer", "Writer", "WRITER"],
				["researcher", "Researcher", "RESEARCHER"],
				["editor", "Editor", "EDITOR"],
			] as const)
				await api(`/agents/${id}`, {
					method: "PUT",
					body: JSON.stringify({ text: agentFile(name, marker), base: null }),
				});

			// outside a group it is never offered
			await api("/messages", {
				method: "POST",
				body: JSON.stringify({ id: randomUUID(), thread: randomUUID(), text: "hello", agent: "editor" }),
			});
			const own = await until(async () => requests.find((request) => request.agent === "editor"));
			expect(own.tools).toContain("message_user");
			expect(own.tools).not.toContain("message_group");

			const { room } = await api<{ room: number }>("/groups", {
				method: "POST",
				body: JSON.stringify({ members: ["writer", "researcher"] }),
			});
			// a member speaks to the room alone, and may ask exactly the others, by the names the group shows
			const first = await turn(room, "writer", "Draft it");
			expect(first.tools).toContain("message_group");
			expect(first.tools).not.toContain("message_user");
			expect(first.ask).toEqual(["Researcher"]);

			// a member added is offered at the next turn
			await put(room, { add: ["editor"] });
			expect((await turn(room, "writer", "Again")).ask).toEqual(["Researcher", "Editor"]);
			// and one archived is not, while it stays in the room
			await api("/agents/editor", {
				method: "PUT",
				body: JSON.stringify({
					text: agentFile("Editor", "EDITOR", "state: archived\n"),
					base: shaOf(agentFile("Editor", "EDITOR")),
				}),
			});
			expect((await turn(room, "writer", "Once more")).ask).toEqual(["Researcher"]);
			// alone, it has nobody to ask: no `ask` at all
			await put(room, { remove: ["researcher", "editor"] });
			expect((await turn(room, "writer", "Alone now")).ask).toBeUndefined();
			await put(room, { add: ["researcher"] });

			// a name outside the enum is refused before the tool runs: nothing is posted, nobody is asked
			const posted = (await api<GroupView>(`/groups/${room}`)).messages.length;
			const before = results.length;
			await turn(room, "writer", "ASK MALLORY");
			const refused = await until(async () => results.slice(before).find((result) => result.agent === "writer"));
			expect(refused.error).toBe(true);
			expect(refused.text).toMatch(/Validation failed for tool "message_group"[\s\S]*ask/);
			// nothing posted for the owner's message, so it is nudged, and answers then
			const after = await until(async () => {
				const view = await api<GroupView>(`/groups/${room}`);
				return view.messages.length === posted + 2 ? view : undefined;
			});
			expect(after.messages.at(-1)).toMatchObject({ author: { agent: "writer" }, text: "writer reply" });
			expect(after.messages.some((message) => message.text === "Mallory?")).toBe(false);

			// a name within it asks that member, who starts a turn of its own
			const asked = requests.length;
			await turn(room, "writer", "ASK RESEARCHER");
			await until(async () => requests.slice(asked).find((request) => request.agent === "researcher"));
			const message = (await api<GroupView>(`/groups/${room}`)).messages.find((m) => m.text === "Over to you");
			expect(message?.mentions).toEqual(["researcher"]);

			// message_user is not offered in a group; called anyway, it reaches nobody
			const spoke = results.length;
			await turn(room, "writer", "SPEAK AS USER");
			const user = await until(async () => results.slice(spoke).find((result) => result.agent === "writer"));
			expect(user.error).toBe(true);
			expect((await api<GroupView>(`/groups/${room}`)).messages.some((m) => m.text === "to the owner?")).toBe(false);
		} finally {
			await daemon.close();
		}
	}, 60_000);
});
