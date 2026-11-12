/**
 * Mid-chat events that change the prompt patch it in place (DESIGN.md "The prompt"): pi-durable can only append a new
 * section at the end, and `instructions` is last from the start, so a section that appeared later anywhere else would
 * remove and re-add every one of them. The first saved fact and loading `propose_avatar` are the common two.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	type Message,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { AVATAR_INSTRUCTIONS } from "../src/core/avatar-instructions.ts";
import { MAIN_THREAD } from "../src/core/gateway.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ItemPage, Posted } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until } from "./helpers.ts";

type SystemMessage = { readonly role: "system"; readonly sections?: { readonly [key: string]: string | null } };

const textOf = (message: Message | undefined): string =>
	message === undefined
		? ""
		: typeof message.content === "string"
			? message.content
			: (message.content as readonly { type: string; text?: string }[]).map((part) => part.text ?? "").join("");

/**
 * A daemon on a faux model: the owner's `call:<tool>:<json>` makes the model call that tool, then answer; anything else
 * is answered at once. Every request's messages are kept as the provider got them.
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
	const sent: Message[][] = [];
	const respond = (ctx: ModelContext) => {
		sent.push(structuredClone(ctx.messages) as Message[]);
		const last = ctx.messages.filter((message) => message.role !== "system").at(-1);
		if (last?.role === "toolResult" && last.toolName === "message_user") return fauxAssistantMessage("done");
		if (last?.role === "toolResult")
			return fauxAssistantMessage([fauxToolCall("message_user", { text: "ok" })], { stopReason: "toolUse" });
		const call = /^call:([a-z_]+):([\s\S]+)$/.exec(textOf(last as Message));
		return fauxAssistantMessage(
			[
				call === null
					? fauxToolCall("message_user", { text: "hi" })
					: fauxToolCall(call[1]!, JSON.parse(call[2]!) as JsonObject),
			],
			{ stopReason: "toolUse" },
		);
	};
	faux.setResponses(Array.from({ length: 200 }, () => respond as never));
	const running = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
	const token = (await readDaemonFile(home))!.token!;
	const api = async <T>(path: string, init: RequestInit = {}) =>
		(await (
			await fetch(`http://127.0.0.1:${running.port}/api${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, ...init.headers },
			})
		).json()) as T;
	let turns = 0;
	/** Say `text` in the lead's chat and wait for its run to end, in the model's closing notes. */
	const say = async (text: string) => {
		const posted = await api<Posted>("/messages", {
			method: "POST",
			body: JSON.stringify({ id: randomUUID(), text, thread: MAIN_THREAD }),
		});
		if (!("chat" in posted) || posted.chat === undefined) throw new Error("refused");
		const chat = posted.chat;
		turns++;
		await until(
			async () =>
				(await api<ItemPage>(`/chats/${chat}/items`)).items.filter(
					(item) => item.role === "assistant" && item.text === "done",
				).length === turns,
		);
	};
	/** The system messages the chat's last request sent, in order. */
	const systems = () => (sent.at(-1) ?? []).filter((message) => message.role === "system") as SystemMessage[];
	return { sent, say, systems, close: () => running.close() };
}

/** The section patches `after` holds beyond `before`: what an event wrote into the prompt. */
const patches = (before: readonly SystemMessage[], after: readonly SystemMessage[]) =>
	after.slice(before.length).flatMap((message) => (message.sections === undefined ? [] : [message.sections]));

describe("a section that changes mid-chat", () => {
	it("is patched in place when the first fact is saved and when propose_avatar loads: nothing is re-added", async () => {
		const d = await daemon();
		try {
			await d.say("hello");
			const start = d.systems();
			// the baseline: every section once, instructions last, memory among them before anything is saved
			const baseline = start[0]?.sections ?? {};
			expect(Object.keys(baseline).at(-1)).toBe("instructions");
			expect(baseline.memory).toContain("Nothing saved yet.");

			await d.say(`call:remember:${JSON.stringify({ fact: "Prefers window seats", scope: "agent" })}`);
			const remembered = d.systems();
			const saved = patches(start, remembered);
			// the fact changes memory's words, and nothing else is removed or sent again
			expect(saved.flatMap((patch) => Object.keys(patch))).toContain("memory");
			expect(saved.flatMap((patch) => Object.keys(patch))).not.toContain("instructions");
			expect(saved.flatMap((patch) => Object.values(patch))).not.toContain(null);
			expect(saved.map((patch) => patch.memory).join()).toContain("Prefers window seats");

			// before the tool loads, the guide's section is there, empty, and so not in the prompt
			expect(baseline.avatar_design).toBe("");
			expect(getCurrentSystemPrompt(d.sent.at(-1) ?? [])).not.toContain("Avatar geometry designer");

			await d.say(`call:tool_search:${JSON.stringify({ query: "propose_avatar", limit: 1 })}`);
			const loaded = d.systems();
			const avatar = patches(remembered, loaded);
			expect(avatar.flatMap((patch) => Object.keys(patch))).not.toContain("instructions");
			expect(avatar.flatMap((patch) => Object.values(patch))).not.toContain(null);
			// loading it changes the section's words to the whole guide, and the tool is offered
			expect(avatar.map((patch) => patch.avatar_design ?? "").join()).toContain(AVATAR_INSTRUCTIONS);
			expect(getCurrentSystemPrompt(d.sent.at(-1) ?? [])).toContain(AVATAR_INSTRUCTIONS);
			const added = loaded.flatMap((message) => (message as { toolsAdded?: { name: string }[] }).toolsAdded ?? []);
			expect(added.map((tool) => tool.name)).toContain("propose_avatar");
			// once, as a section: the search's result does not repeat it
			const search = (d.sent.at(-1) ?? []).find(
				(message) => message.role === "toolResult" && message.toolName === "tool_search",
			) as Message | undefined;
			expect(textOf(search)).toContain("propose_avatar");
			expect(textOf(search)).not.toContain("Avatar geometry designer");
		} finally {
			await d.close();
		}
	});
});
