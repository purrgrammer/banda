/** The band's rows: the newest thing said and who said it, an open ask in a few words, and where the owner read. */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { readChat } from "../src/core/chat-reads.ts";
import { context, openStore } from "../src/core/store.ts";
import { Routes } from "../src/core/turn.ts";
import { WAIT } from "../src/core/wait.ts";
import { askWords, chats } from "../src/server/transcript.ts";
import { echoModels } from "./fixtures/models.ts";
import { tempHome } from "./helpers.ts";

describe("chat rows", () => {
	it("carry the newest words, who said them, and the read cursor", async () => {
		const harness = await openStore(await tempHome(), { registry: createRegistry(), models: echoModels().models });
		try {
			const chat = await harness.commit(async (tx) => {
				const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
				(await tx.doc(Routes)).chats[id] = { origin: { gateway: "web", peer: "owner" }, agent: "sancho" };
				await tx.appendEntry(id, {
					kind: "test.owner",
					model: [{ role: "user", content: "Find me a **flight**", timestamp: 1 }],
				});
				return Number(id);
			}, context);
			let [row] = await chats(harness);
			expect(row).toMatchObject({ chat, excerpt: "Find me a flight", by: "owner", read: 0 });

			await harness.commit(async (tx) => {
				await tx.appendEntry(chat as never, {
					kind: "test.reply",
					model: [fauxAssistantMessage([fauxToolCall("message_user", { text: "Three fit.\n\nThe 9:15 is best." })])],
				});
			}, context);
			[row] = await chats(harness);
			expect(row).toMatchObject({ excerpt: "Three fit. The 9:15 is best.", by: "agent", unread: 1 });

			// a file alone, a reaction alone: the row still says what reached the owner
			await harness.commit(async (tx) => {
				await tx.appendEntry(chat as never, {
					kind: "test.file",
					model: [fauxAssistantMessage([fauxToolCall("message_user", { files: ["/work/out/report.pdf"] })])],
				});
			}, context);
			[row] = await chats(harness);
			expect(row?.excerpt).toBe("Sent report.pdf");

			// the owner approving a draft is their newest act: it dates and words the row
			await harness.commit(async (tx) => {
				await tx.appendEntry(chat as never, {
					kind: WAIT,
					data: {
						ask: { type: "approval", tool: "github_comment", args: {}, label: "Comment on #34" },
						outcome: "answered",
						answer: "approve",
						at: 9_000,
					},
				});
			}, context);
			[row] = await chats(harness);
			expect(row).toMatchObject({ excerpt: "Approved: Comment on #34", by: "owner", said: 9_000 });

			await readChat(harness, chat);
			[row] = await chats(harness);
			expect(row?.read).toBeGreaterThan(0);
			expect(row?.unread).toBe(0);
			expect(row?.ask).toBeUndefined();
		} finally {
			await harness.close(context);
		}
	});

	it("say an open ask in a few words", () => {
		expect(askWords({ type: "question", question: "Book the **9:15**?" })).toBe("Book the 9:15?");
		expect(askWords({ type: "approval", tool: "github_comment", args: {}, label: "Comment on #34" })).toBe(
			"Comment on #34",
		);
		expect(askWords({ type: "approval", tool: "github_comment", args: {} })).toBe("github_comment");
	});
});
