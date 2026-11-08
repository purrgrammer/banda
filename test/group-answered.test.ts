/**
 * The owner is always answered in a group too (DESIGN.md "Messages", "Groups"): a member's run the owner asked for that
 * ended without posting (its final text is notes nobody reads) is nudged once, in the group's words; one that still
 * posts nothing leaves "<name> didn't answer." in the room. A reaction on the owner's message answers too, shown on that
 * message. A run another member asked for may stay silent, and has no owner's message to react to.
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
import type { GroupView } from "../src/server/api.ts";
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

const NUDGED = /without posting to the group/;

describe("a group member the owner asked", () => {
	it("is nudged once when it posts nothing, may answer with a reaction, and otherwise the room says so", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const web = join(home, "web");
		await mkdir(web, { recursive: true });
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const requests: { agent: string; text: string; nudge: boolean }[] = [];
		const results: { agent: string; text: string; error: boolean }[] = [];
		const respond = (ctx: ModelContext) => {
			const prompt = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
			const who = ["WRITER", "RESEARCHER"].find((marker) => prompt.includes(`${marker} INSTRUCTIONS`))?.toLowerCase();
			const turns = ctx.messages.filter((m) => m.role !== "system");
			const last = turns.at(-1);
			if (last?.role === "toolResult") {
				results.push({ agent: who ?? "lead", text: textOf(last.content), error: last.isError });
				return fauxAssistantMessage("done");
			}
			const text = textOf(last?.content);
			const nudge = NUDGED.test(text);
			requests.push({ agent: who ?? "lead", text, nudge });
			// what the turn's input asked, whether this request is the nudge or the input itself
			const input = textOf(
				[...turns].reverse().find((m) => m.role === "user" && !NUDGED.test(textOf(m.content)))?.content,
			);
			if (who === undefined) return fauxAssistantMessage("notes");
			// a member's first turn reads the whole room: what asks it is the newest message
			if (who === "researcher" && input.includes("REACT TO ME"))
				return fauxAssistantMessage([fauxToolCall("react", { reaction: "👀" })], { stopReason: "toolUse" });
			if (input.includes("REACT WHEN NUDGED") && nudge)
				return fauxAssistantMessage([fauxToolCall("react", { reaction: "👍" })], { stopReason: "toolUse" });
			if (input.includes("REACT WHEN NUDGED") || input.includes("STAY SILENT"))
				return fauxAssistantMessage("I posted it above.");
			if (who === "writer" && input.includes("HAND OVER"))
				return fauxAssistantMessage(
					[fauxToolCall("message_group", { text: "Over to you: REACT TO ME", ask: ["Researcher"] })],
					{ stopReason: "toolUse" },
				);
			return fauxAssistantMessage([fauxToolCall("message_group", { text: `${who} reply` })], { stopReason: "toolUse" });
		};
		faux.setResponses(Array.from({ length: 100 }, () => respond as never));
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
		const view = (room: number) => api<GroupView>(`/groups/${room}`);
		const say = async (room: number, text: string, mentions: string[]) =>
			(
				await api<GroupView>(`/groups/${room}/messages`, {
					method: "POST",
					body: JSON.stringify({ key: randomUUID(), text, mentions }),
				})
			).messages.find((message) => message.text === text)?.entry as number;
		/** Until no member works in `room`. */
		const settled = (room: number) => until(async () => ((await view(room)).working.length === 0 ? true : undefined));
		try {
			await until(async () => existsSync(join(home, "workspace", "agents", "sancho.md")));
			for (const [id, name, marker] of [
				["writer", "Writer", "WRITER"],
				["researcher", "Researcher", "RESEARCHER"],
			] as const)
				await api(`/agents/${id}`, {
					method: "PUT",
					body: JSON.stringify({ text: agentFile(name, marker), base: null }),
				});
			const { room } = await api<{ room: number }>("/groups", {
				method: "POST",
				body: JSON.stringify({ members: ["writer", "researcher"] }),
			});

			// notes alone, then nudged in the group's words: a reaction answers, on the owner's message
			const asked = await say(room, "REACT WHEN NUDGED", ["writer"]);
			const reacted = await until(async () => (await view(room)).messages.find((m) => m.reaction !== undefined));
			expect(reacted).toMatchObject({ author: { agent: "writer" }, text: "", reaction: { emoji: "👍", on: asked } });
			await settled(room);
			expect(requests.filter((request) => request.agent === "writer" && request.nudge)).toHaveLength(1);
			expect((await view(room)).notices.some((notice) => notice.unanswered)).toBe(false);

			// still nothing when nudged: one nudge, then the room says so
			const before = requests.length;
			await say(room, "STAY SILENT", ["writer"]);
			const notice = await until(async () => (await view(room)).notices.find((n) => n.unanswered));
			expect(notice).toMatchObject({ agent: "writer", unanswered: true });
			expect(requests.slice(before).filter((request) => request.nudge)).toHaveLength(1);

			// a member another member asked may stay silent, and has no owner's message to react to
			const handed = requests.length;
			const spoke = results.length;
			await say(room, "HAND OVER", ["writer"]);
			const refused = await until(async () => results.slice(spoke).find((result) => result.agent === "researcher"));
			expect(refused.error).toBe(true);
			expect(refused.text).toMatch(/reaction goes on the owner's message/);
			await settled(room);
			expect(requests.slice(handed).filter((request) => request.agent === "researcher" && request.nudge)).toEqual([]);
			expect((await view(room)).notices.filter((n) => n.unanswered)).toHaveLength(1);
		} finally {
			await daemon.close();
		}
	}, 60_000);
});
