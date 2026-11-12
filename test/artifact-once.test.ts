/**
 * An artifact once in the chat (DESIGN.md "Messages"): a message that shows an artifact its own run just published, at
 * that very version, draws no second card; one that shows it in a later run, or another version of it, does. Through a
 * daemon whose faux model publishes and then shows what it published, read back as the app reads it: a chat, and a
 * group's room.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { artifactId } from "../src/core/artifacts.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ArtifactView, ChatRow, GroupView, Item } from "../src/server/api.ts";
import { view } from "../web/src/lib/chat.ts";
import type { ArtifactSegment } from "../web/src/lib/segments/artifacts.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until } from "./helpers.ts";

type Said = { role: string; content: unknown };
const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

/**
 * A daemon on a host box whose faux model, told `publish <path>`, publishes it and then shows it with `message_user`
 * by the id `publish` returned, as a model does; told `show <id>`, only shows it.
 */
async function daemon() {
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const web = join(home, "web");
	await mkdir(web, { recursive: true });
	await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let asked = 0;
	faux.setResponses(
		Array.from({ length: 100 }, () => (ctx: { messages: readonly Said[] }) => {
			asked++;
			const last = ctx.messages.at(-1);
			const said = textOf(last?.content);
			if (last?.role === "toolResult") {
				const id = /its id is ([0-9a-f]{16})/.exec(said)?.[1];
				return id === undefined
					? fauxAssistantMessage("done")
					: fauxAssistantMessage([fauxToolCall("message_user", { text: "Here is the plan.", artifacts: [id] })], {
							stopReason: "toolUse",
						});
			}
			const shown = /^show (\S+)$/.exec(said);
			if (shown !== null)
				return fauxAssistantMessage(
					[fauxToolCall("message_user", { text: "Here it is again.", artifacts: [shown[1]] })],
					{
						stopReason: "toolUse",
					},
				);
			const published = /^publish (\S+)$/.exec(said);
			if (published === null) return fauxAssistantMessage("ok");
			return fauxAssistantMessage([fauxToolCall("publish", { path: published[1] ?? "", title: "Trip" })], {
				stopReason: "toolUse",
			});
		}) as never,
	);
	const running = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
	const token = (await readDaemonFile(home))!.token!;
	const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
		const response = await fetch(`http://127.0.0.1:${running.port}/api${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, ...init.headers },
		});
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	};
	const thread = randomUUID();
	let chat: number | undefined;
	/** Say `text` in the one chat and wait for its run to end. */
	const say = async (text: string) => {
		const before = asked;
		const posted = await api<{ chat: number }>("/messages", {
			method: "POST",
			body: JSON.stringify({ id: randomUUID(), text, ...(chat === undefined ? { thread } : { chat }) }),
		});
		chat = posted.chat;
		await until(
			async () => asked > before && (await api<ChatRow[]>("/chats")).find((row) => row.chat === chat)?.state === "idle",
		);
	};
	/** The chat's artifact cards, as the app draws them from the transcript and the Library. */
	/**
	 * The chat's artifact cards, as the app draws them from the transcript and the Library: from the live tail (the
	 * items after the newest the app already had, as the stream appends them) and from history (the newest page a
	 * reload reads), which must draw the same.
	 */
	const cards = async () => {
		const library = await api<ArtifactView[]>("/artifacts");
		const drawn = (items: readonly Item[]) =>
			view(items, [], { busy: false, running: [], thinking: false }, { artifacts: { chat: chat!, library } })
				.filter((segment): segment is ArtifactSegment => segment.kind === "artifact")
				.map(({ id, n, shown }) => ({ id, n, ...(shown === true ? { shown } : {}) }));
		const live = drawn((await api<{ items: Item[] }>(`/chats/${chat}/items?after=0`)).items);
		expect(drawn((await api<{ items: Item[] }>(`/chats/${chat}/items`)).items)).toEqual(live);
		return live;
	};
	const box = (path: string) => join(home, "workspace", path);
	return { home, say, cards, box, close: () => running.close() };
}

describe("an artifact once in the chat", () => {
	it("published and shown by the same run is one card; shown again by a later run is a card of its own", async () => {
		const d = await daemon();
		try {
			await mkdir(join(d.home, "workspace"), { recursive: true });
			await writeFile(d.box("plan.md"), "# Friday\n");
			await d.say("publish plan.md");
			const id = artifactId(d.box("plan.md"));
			// the publish's card, and no second one for the message that named it
			expect(await d.cards()).toEqual([{ id, n: 1 }]);
			// the owner asks for it again: a later run's message shows it, on purpose
			await d.say(`show ${id}`);
			expect(await d.cards()).toEqual([
				{ id, n: 1 },
				{ id, n: 1, shown: true },
			]);
			// a new version published and shown in one run: once more, one card
			await writeFile(d.box("plan.md"), "# Friday\n\nback at six\n");
			await d.say("publish plan.md");
			expect(await d.cards()).toEqual([
				{ id, n: 1 },
				{ id, n: 1, shown: true },
				{ id, n: 2 },
			]);
		} finally {
			await d.close();
		}
	});
});

const agentFile = (name: string, marker: string) =>
	`---\nname: ${name}\ndescription: ${name} things\ntools: [read]\n---\n${marker} INSTRUCTIONS.\n`;

describe("an artifact once in a group's room", () => {
	it("a member's publish and its own run's message showing it are one card; a later run's is a card of its own", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const web = join(home, "web");
		await mkdir(web, { recursive: true });
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(
			Array.from({ length: 100 }, () => (ctx: { messages: readonly Said[] }) => {
				const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
				const said = textOf(last?.content);
				if (last?.role === "toolResult") {
					const id = /its id is ([0-9a-f]{16})/.exec(said)?.[1];
					return id === undefined
						? fauxAssistantMessage("done")
						: fauxAssistantMessage([fauxToolCall("message_group", { text: "Here is the draft.", artifacts: [id] })], {
								stopReason: "toolUse",
							});
				}
				const shown = /SHOW ([0-9a-f]{16})/.exec(said)?.[1];
				if (shown !== undefined)
					return fauxAssistantMessage(
						[fauxToolCall("message_group", { text: "Here it is again.", artifacts: [shown] })],
						{ stopReason: "toolUse" },
					);
				if (said.includes("PUBLISH IT"))
					return fauxAssistantMessage([fauxToolCall("publish", { path: "draft.md", title: "Launch post" })], {
						stopReason: "toolUse",
					});
				return fauxAssistantMessage([fauxToolCall("message_group", { text: "ok" })], { stopReason: "toolUse" });
			}) as never,
		);
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
			const { room } = await api<{ room: number }>("/groups", {
				method: "POST",
				body: JSON.stringify({ members: ["researcher", "writer"] }),
			});
			const post = (text: string) =>
				api(`/groups/${room}/messages`, {
					method: "POST",
					body: JSON.stringify({ key: randomUUID(), text, mentions: ["researcher"] }),
				});
			/** The room's member messages with their cards, once the one saying `text` is there. */
			const cards = (text: string) =>
				until(async () => {
					const shown = (await api<GroupView>(`/groups/${room}`)).messages
						.filter((m) => "agent" in m.author)
						.map((m) => ({ text: m.text, cards: (m.artifacts ?? []).map(({ id, n }) => ({ id, n })) }));
					return shown.some((m) => m.text === text) ? shown : undefined;
				});
			await writeFile(join(home, "workspace", "draft.md"), "# Launch\n\nFriday.\n");
			await post("PUBLISH IT");
			const id = artifactId(join(home, "workspace", "draft.md"));
			const published = await cards("Here is the draft.");
			// the publish's card, and none again on the message its own run posted to show it
			expect(published.flatMap((m) => m.cards)).toEqual([{ id, n: 1 }]);
			expect(published.find((m) => m.text === "Here is the draft.")?.cards).toEqual([]);
			// a later run shows it on purpose: its card
			await post(`SHOW ${id}`);
			const again = await cards("Here it is again.");
			expect(again.find((m) => m.text === "Here it is again.")?.cards).toEqual([{ id, n: 1 }]);
		} finally {
			await daemon.close();
		}
	});
});
