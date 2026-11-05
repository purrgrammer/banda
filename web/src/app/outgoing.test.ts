import { describe, expect, it } from "vitest";
import type { Item, Posted, Queued } from "../lib/api.ts";
import { type PendingMessage, settledByAnswer, shownMessages, stillPending } from "./outgoing.ts";

const pending = (id: string): PendingMessage => ({ id, text: id, files: [], state: "sending" });
const entry = (message: string) => ({ id: 1, role: "user", text: message, message }) as unknown as Item;
const queued = (message: string): Queued => ({ id: `q-${message}`, text: message, message });

describe("the owner's messages on their way", () => {
	it("stays dimmed until the transcript shows it, as an entry or a queued input, and never shows twice", () => {
		const outgoing = [pending("a"), pending("b"), pending("c")];
		expect(stillPending(outgoing, shownMessages([], []))).toEqual(outgoing);
		// queued behind the run: "Waiting its turn" shows it, so the dimmed copy goes
		expect(stillPending(outgoing, shownMessages([entry("a")], [queued("b")])).map((one) => one.id)).toEqual(["c"]);
	});

	it("is settled by the post when it answered the chat's open question, which no entry carries", () => {
		expect(settledByAnswer({ answered: 4, chat: 1 } as Posted)).toBe(true);
		expect(settledByAnswer({ turn: 4, chat: 1 } as Posted)).toBe(false);
	});
});
