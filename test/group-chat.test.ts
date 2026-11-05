/**
 * Groups through the daemon (DESIGN.md "Groups"): the owner makes a group of agents and posts to it; only the agents a
 * message mentions work, each from the log as data, and each answers in the room with `message_group`. A message posts
 * once per key; a mention of a non-member is refused; a question waits in the room, answered there.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import type { GroupRow, GroupView, SearchHit } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until } from "./helpers.ts";

const agentFile = (name: string, marker: string) =>
	`---\nname: ${name}\ndescription: ${name} things\ntools: [read]\n---\n${marker} INSTRUCTIONS.\n`;

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

describe("groups", () => {
	it("runs only the mentioned agents, each answering in the room", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const web = join(home, "web");
		await mkdir(web, { recursive: true });
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const runs: { agent: string; text: string; prompt: string }[] = [];
		const results: string[] = [];
		const respond = (ctx: ModelContext) => {
			const prompt = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
			const agent = prompt.includes("RESEARCHER INSTRUCTIONS")
				? "researcher"
				: prompt.includes("WRITER INSTRUCTIONS")
					? "writer"
					: "lead";
			const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
			if (last?.role === "toolResult") {
				results.push(textOf(last.content));
				return fauxAssistantMessage("done");
			}
			const text = textOf(last?.content);
			runs.push({ agent, text, prompt });
			// a file the owner sent: the agent sends it back, from where the turn says it is in its box (first: a turn
			// reads every message since it last worked, an earlier FAIL ME among them)
			// publishing to the Library from the room (first, like a file: a turn reads every message since it last worked)
			if (text.includes("PUBLISH IT"))
				return fauxAssistantMessage(
					[fauxToolCall("message_group", { artifact: { path: "draft.md", title: "Launch post" } })],
					{ stopReason: "toolUse" },
				);
			const path = /"path":"([^"]+notes\.txt)"/.exec(text)?.[1];
			if (path !== undefined)
				return fauxAssistantMessage([fauxToolCall("message_group", { text: "Read it.", files: [path] })], {
					stopReason: "toolUse",
				});
			if (text.includes("FAIL ME")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" });
			const args: { [key: string]: string } = text.includes("ASK ME")
				? { question: "Which one?" }
				: { text: `${agent} reply` };
			return fauxAssistantMessage([fauxToolCall("message_group", args)], { stopReason: "toolUse" });
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
		const post = (room: number, body: object) =>
			call(`/groups/${room}/messages`, { method: "POST", body: JSON.stringify(body) });
		const by = (view: GroupView, agent: string) =>
			view.messages.filter((m) => "agent" in m.author && m.author.agent === agent);
		try {
			await until(async () => existsSync(join(home, "workspace", "agents", "sancho.md")));
			for (const [id, name, marker] of [
				["researcher", "Researcher", "RESEARCHER"],
				["writer", "Writer", "WRITER"],
			] as const)
				await api(`/agents/${id}`, {
					method: "PUT",
					body: JSON.stringify({ text: agentFile(name, marker), base: null }),
				});

			// the shell streams, groups among it, before any group was made
			const stream = new AbortController();
			const events = await call("/events", { signal: stream.signal });
			const reader = events.body!.getReader();
			let streamed = "";
			const deadline = Date.now() + 5_000;
			while (!streamed.includes('"type":"groups"') && Date.now() < deadline) {
				const { value, done } = await reader.read();
				if (done) break;
				streamed += new TextDecoder().decode(value);
			}
			stream.abort();
			expect(streamed).toContain('"type":"groups","groups":[]');

			const { room } = await api<{ room: number }>("/groups", {
				method: "POST",
				body: JSON.stringify({ members: ["researcher", "writer"] }),
			});
			const rows = await api<GroupRow[]>("/groups");
			expect(rows.map((row) => ({ room: row.room, name: row.name, members: row.members }))).toEqual([
				{ room, name: "Researcher, Writer", members: ["researcher", "writer"] },
			]);

			// a message without a mention is shared context: nobody works
			const quiet = { key: randomUUID(), text: "Context: the launch is Friday." };
			expect((await post(room, quiet)).status).toBe(200);
			// the same key posts once
			expect((await post(room, quiet)).status).toBe(200);
			expect((await api<GroupView>(`/groups/${room}`)).messages).toHaveLength(1);

			// a mention of one agent runs it alone, from the whole log
			expect((await post(room, { key: randomUUID(), text: "Draft it", mentions: ["writer"] })).status).toBe(200);
			const first = await until(async () => {
				const view = await api<GroupView>(`/groups/${room}`);
				return by(view, "writer").length === 1 ? view : undefined;
			});
			expect(by(first, "writer")[0]?.text).toBe("writer reply");
			expect(runs.map((run) => run.agent)).toEqual(["writer"]);
			// the writer's answer is unread until the owner reads through it, and reading never goes back
			expect(first.unread).toBe(1);
			const answer = by(first, "writer")[0]?.entry ?? 0;
			expect(
				(await call(`/groups/${room}/read`, { method: "POST", body: JSON.stringify({ through: answer }) })).status,
			).toBe(200);
			await call(`/groups/${room}/read`, { method: "POST", body: JSON.stringify({ through: 0 }) });
			const read = await api<GroupView>(`/groups/${room}`);
			expect(read).toMatchObject({ read: answer, unread: 0 });
			expect((await api<GroupRow[]>("/groups"))[0]).toMatchObject({ read: answer, unread: 0 });
			// renamed, a member removed and added back: in effect at once, never below one member
			const put = (body: object) => call(`/groups/${room}`, { method: "PUT", body: JSON.stringify(body) });
			expect((await put({ name: "  Launch   crew " })).status).toBe(200);
			expect((await api<GroupView>(`/groups/${room}`)).name).toBe("Launch crew");
			expect((await put({ remove: ["writer"] })).status).toBe(200);
			expect((await api<GroupView>(`/groups/${room}`)).members).toEqual(["researcher"]);
			expect((await put({ remove: ["researcher"] })).status).toBe(400);
			expect((await put({ add: ["writer"] })).status).toBe(200);
			expect((await api<GroupView>(`/groups/${room}`)).members).toEqual(["researcher", "writer"]);
			expect((await put({ add: ["nobody"] })).status).toBe(400);
			// each change is said in the room, in the order it was made; a refused one says nothing
			const said = (await api<GroupView>(`/groups/${room}`)).notices.map(({ entry: _, at: __, ...notice }) => notice);
			expect(said).toEqual([
				{ renamed: "Launch crew" },
				{ agent: "writer", removed: true },
				{ agent: "writer", added: true },
			]);

			// search finds it in the group, at its entry, and never in the member's own execution chat
			const found = await api<SearchHit[]>(`/search?q=${encodeURIComponent("writer reply")}`);
			expect(found).toContainEqual(expect.objectContaining({ kind: "group", room, entry: answer, who: "writer" }));
			expect(found.some((hit) => hit.kind === "chat" && hit.text === "writer reply")).toBe(false);
			expect(runs[0]?.text).toContain("the launch is Friday");
			expect(runs[0]?.prompt).toContain("one equal member of the group");
			// it speaks to the room alone: nothing tells it of message_user
			expect(runs[0]?.prompt).toContain("message_group");
			expect(runs[0]?.prompt).not.toContain("message_user");

			// both mentioned: both answer in the room
			expect(
				(await post(room, { key: randomUUID(), text: "Both of you", mentions: ["researcher", "writer"] })).status,
			).toBe(200);
			const both = await until(async () => {
				const view = await api<GroupView>(`/groups/${room}`);
				return by(view, "writer").length === 2 && by(view, "researcher").length === 1 ? view : undefined;
			});
			const authors = both.messages.map((m) => ("owner" in m.author ? "owner" : m.author.agent));
			expect(authors.slice(0, 4)).toEqual(["owner", "owner", "writer", "owner"]);
			expect(authors.slice(4).sort()).toEqual(["researcher", "writer"]);
			// the researcher, catching up, read everything before its mention
			const researcher = runs.find((run) => run.agent === "researcher");
			expect(researcher?.text).toContain("writer reply");

			// refused: a mention of an agent not in the group
			const stranger = await post(room, { key: randomUUID(), text: "You?", mentions: ["sancho"] });
			expect(stranger.status).toBe(400);
			// a question waits in the room, and the owner answers it there; the agent goes on with the answer
			const before = results.length;
			await post(room, { key: randomUUID(), text: "ASK ME", mentions: ["writer"] });
			const asked = await until(async () => {
				const view = await api<GroupView>(`/groups/${room}`);
				return view.asks.length === 1 ? view : undefined;
			});
			expect(asked.asks[0]).toMatchObject({ agent: "writer", wait: { ask: { question: "Which one?" } } });
			expect(asked.asking).toEqual([asked.asks[0]?.wait.key]);
			// asked in the room alone: no message of it went to the owner's other chats
			expect((await api<{ chat: number }[]>("/chats")).length).toBe(0);
			const key = asked.asks[0]?.wait.key ?? "";
			await api(`/waits/${key}`, {
				method: "POST",
				body: JSON.stringify({ answer: "the blue one", type: "question", via: "web" }),
			});
			expect(await until(async () => results.slice(before).find((r) => r.includes("the blue one")))).toContain(
				"The owner answered",
			);
			expect((await api<GroupView>(`/groups/${room}`)).asks).toEqual([]);

			// a run that fails says so in the room: nobody waits on an answer that is not coming
			await post(room, { key: randomUUID(), text: "FAIL ME", mentions: ["researcher"] });
			const failed = await until(async () => {
				const view = await api<GroupView>(`/groups/${room}`);
				return view.notices.some((notice) => notice.failed !== undefined) ? view : undefined;
			});
			const failure = failed.notices.filter((notice) => notice.failed !== undefined);
			expect(failure).toEqual([expect.objectContaining({ agent: "researcher", failed: "boom" })]);
			expect(failed.latest).toBe(failure[0]?.entry);

			// files: the owner's reach the asked agent's box before its turn, and the agent's own come back to the room
			const uploaded = await api<{ sha: string; name: string }>("/blobs", {
				method: "POST",
				body: "NOTES MARKER",
				headers: { "content-type": "text/plain", "x-file-name": "notes.txt" },
			});
			await post(room, {
				key: randomUUID(),
				text: "",
				mentions: ["writer"],
				files: [{ sha: uploaded.sha, name: "notes.txt" }],
			});
			const sent = await until(async () => {
				const view = await api<GroupView>(`/groups/${room}`);
				return view.messages.find((m) => "agent" in m.author && m.text === "Read it.");
			});
			expect(sent.files?.map((file) => file.name)).toEqual(["notes.txt"]);
			const owner = (await api<GroupView>(`/groups/${room}`)).messages.find((m) => m.files !== undefined);
			expect(owner?.author).toEqual({ owner: true });
			const turn = runs.find((run) => run.text.includes("notes.txt"));
			const placed = /"path":"([^"]+)"/.exec(turn?.text ?? "")?.[1] ?? "";
			expect(await readFile(placed, "utf8")).toBe("NOTES MARKER");

			// an artifact a member publishes from the room shows on its message there, as the Library holds it
			await writeFile(join(home, "workspace", "draft.md"), "# Launch\n\nFriday.\n");
			await post(room, { key: randomUUID(), text: "PUBLISH IT", mentions: ["researcher"] });
			const card = await until(async () => {
				const view = await api<GroupView>(`/groups/${room}`);
				return view.messages.find((m) => m.artifact !== undefined);
			});
			expect(card.author).toEqual({ agent: "researcher" });
			expect(card.artifact).toMatchObject({ title: "Launch post", n: 1 });

			// stop: nothing works there after
			const stopped = await api<GroupView>(`/groups/${room}/stop`, { method: "POST", body: "{}" });
			expect(stopped.working).toEqual([]);
		} finally {
			await daemon.close();
		}
	}, 30_000);
});
