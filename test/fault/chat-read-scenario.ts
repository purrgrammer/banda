/** A read commit between two batches of replies, recovered from the cursor itself after every fault. */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	type Harness,
	type JsonObject,
	SessionFailed,
} from "@earendil-works/pi-durable";
import { ChatReads, readChat } from "../../src/core/chat-reads.ts";

import { context, openStore } from "../../src/core/store.ts";
import { Routes } from "../../src/core/turn.ts";
import { chats } from "../../src/server/transcript.ts";
import { echoModels } from "../fixtures/models.ts";
import { type Faults, InjectedFault } from "./faults.ts";

export type Reply = "text" | "question" | "files" | "reaction" | "view";
const argsOf = (reply: Reply): JsonObject => {
	switch (reply) {
		case "text":
			return { text: "Here is the news" };
		case "question":
			return { question: "Which one?" };
		case "files":
			return { files: ["/work/report.txt"] };
		case "reaction":
			return { reaction: "👍" };
		case "view":
			return { view: "browser" };
	}
};

export async function chatReadScenario(home: string, faults: Faults, replies: readonly Reply[]) {
	let harness: Harness | undefined;
	const reopen = async () => {
		await harness?.close(context).catch(() => undefined);
		harness = undefined;
		for (;;) {
			try {
				harness = await openStore(home, {
					registry: createRegistry(),
					models: echoModels().models,
					wrapStorage: (storage) => faults.storage(storage),
				});
				return;
			} catch (error) {
				if (!(error instanceof InjectedFault || error instanceof SessionFailed)) throw error;
			}
		}
	};
	const through = async <T>(step: (harness: Harness) => Promise<T>): Promise<T> => {
		for (;;) {
			try {
				return await step(harness!);
			} catch (error) {
				if (!(error instanceof InjectedFault || error instanceof SessionFailed)) throw error;
				await reopen();
			}
		}
	};
	await reopen();
	try {
		const chat = await through((h) =>
			h.commit(async (tx) => {
				const routes = await tx.doc(Routes);
				const known = Object.keys(routes.chats)[0];
				if (known !== undefined) return Number(known) as ConversationId;
				const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
				routes.chats[id] = { origin: { gateway: "web", peer: "owner" }, agent: "sancho" };
				await tx.appendEntry(id, { kind: "test.owner", model: [{ role: "user", content: "Hello", timestamp: 0 }] });
				await tx.appendEntry(id, {
					kind: "test.before",
					model: [fauxAssistantMessage([fauxToolCall("message_user", { text: "Earlier" })])],
				});
				return id;
			}, context),
		);
		// A stored read is an acknowledged opening even if its response was lost. Recovery never opens again.
		await through(async (h) => {
			if ((await h.snapshot(ChatReads, context))?.chats[chat] === undefined) await readChat(h, Number(chat));
		});
		await through((h) =>
			h.commit(async (tx) => {
				const newest = (await tx.scanEntries({ conversationId: chat }, 1)).items[0];
				if (newest?.kind === "test.after") return;
				await tx.appendEntry(chat, {
					kind: "test.replies",
					model: [
						fauxAssistantMessage([
							...replies.map((reply) => fauxToolCall("message_user", argsOf(reply))),
							fauxToolCall("bash", { command: "private work" }),
							fauxToolCall("message_user", {}),
							fauxToolCall("message_user", { reaction: "invalid" }, { id: "refused-reaction" }),
							fauxToolCall("message_user", { question: "Not delivered?" }, { id: "refused-question" }),
						]),
					],
				});

				// Results on the next page must still decide which calls the owner can see.
				for (let i = 0; i < 50; i++) await tx.appendEntry(chat, { kind: "test.bookkeeping" });
				for (const call of ["refused-reaction", "refused-question"])
					await tx.appendEntry(chat, {
						kind: "test.result",
						model: [
							{
								role: "toolResult",
								toolCallId: call,
								toolName: "message_user",
								content: [{ type: "text", text: "Not sent." }],
								isError: true,
								timestamp: 0,
							},
						],
					});
				await tx.appendEntry(chat, {
					kind: "test.owner",
					model: [{ role: "user", content: "Still the owner", timestamp: 0 }],
				});
				await tx.appendEntry(chat, { kind: "test.after", model: [fauxAssistantMessage("Private working notes")] });
			}, context),
		);
		await reopen();
		// A delayed read from the old screen, even after a crash, cannot consume what appeared later.
		const earlier = (await harness!.snapshot(ChatReads, context))!.chats[chat]!;
		await through((h) => readChat(h, Number(chat), earlier));
		await reopen();
		const row = (await through((h) => chats(h))).find((row) => row.chat === Number(chat));
		return {
			unread: row?.unread,
			cursor: (await harness!.snapshot(ChatReads, context))?.chats[chat],
			commits: faults.hits("commit:before"),
		};
	} finally {
		await harness?.close(context).catch(() => undefined);
	}
}
