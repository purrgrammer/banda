/**
 * "Try again" (DESIGN.md "The chat"): offered on the newest of a reply that failed, a message that was not delivered,
 * or a run that ended without answering the owner; never once anything came after it.
 */
import { describe, expect, it } from "vitest";
import type { Item } from "../src/server/api.ts";
import { answeredWell, type Live, tryAgainAfter, view } from "../web/src/lib/chat.ts";

const IDLE: Live = { busy: false, running: [], thinking: false };
const asked: Item = { id: 1, role: "user", text: "Find a train" };
const failed: Item = { id: 2, role: "assistant", text: "", error: "stream ended before a terminal response event" };
const later: Item = { id: 3, role: "user", text: "Never mind" };
/** A run that only took notes: its text is never the owner's to read. */
const notes: Item = { id: 2, role: "assistant", text: "I should look this up later." };
const message = (id: number, call: string): Item => ({
	id,
	role: "assistant",
	text: "",
	calls: [{ id: call, name: "message_user", args: { text: "The 9:15 is free" } }],
});
const result = (id: number, call: string, text: string, error: boolean): Item => ({
	id,
	role: "tool",
	call,
	name: "message_user",
	text,
	error,
});

describe("Try again", () => {
	it("follows the newest reply that failed", () => {
		expect(tryAgainAfter(view([asked, failed], [], IDLE))).toBe("2:error");
	});
	it("is not offered once something came after the failure, nor on a reply stopped by the owner", () => {
		expect(tryAgainAfter(view([asked, failed, later], [], IDLE))).toBeUndefined();
		expect(tryAgainAfter(view([asked, { ...failed, error: "interrupted" }], [], IDLE))).toBeUndefined();
	});
	it("follows a message that was not delivered, and not one that was", () => {
		const lost = [asked, message(2, "m1"), result(3, "m1", "Not delivered: the connection closed", true)];
		expect(tryAgainAfter(view(lost, [], IDLE))).toBe("2:m1");
		const delivered = [asked, message(2, "m1"), result(3, "m1", "Sent", false)];
		expect(tryAgainAfter(view(delivered, [], IDLE))).toBeUndefined();
	});
	it("follows a run that ended without a word to the owner", () => {
		const segments = view([asked, notes], [], IDLE);
		expect(segments.at(-1)).toMatchObject({ kind: "notice", key: "1:unanswered" });
		expect(tryAgainAfter(segments)).toBe("1:unanswered");
	});
	it("is not offered while the agent works, before it worked, or when the owner stopped it", () => {
		expect(tryAgainAfter(view([asked, notes], [], { ...IDLE, busy: true }))).toBeUndefined();
		expect(tryAgainAfter(view([asked], [], IDLE))).toBeUndefined();
		const aborted: Item = {
			id: 3,
			role: "tool",
			call: "c1",
			name: "web_fetch",
			text: "aborted",
			error: true,
			notes: [{ severity: "info", code: "aborted", text: "stopped" }],
		};
		const calling: Item = { id: 2, role: "assistant", text: "", calls: [{ id: "c1", name: "web_fetch", args: {} }] };
		expect(tryAgainAfter(view([asked, calling, aborted], [], IDLE))).toBeUndefined();
	});
	it("is not offered after an answer typed to a question, nor after the owner's edit of an artifact", () => {
		const ask = { type: "question" as const, question: "Which day?" };
		const questioned: Item[] = [
			asked,
			{
				id: 2,
				role: "assistant",
				text: "",
				calls: [{ id: "q1", name: "ask_user", args: { question: "Which day?" } }],
			},
			{ id: 3, role: "wait", ask, call: "q1", outcome: "answered", answer: "Friday", message: "m1", at: 4 },
		];
		expect(tryAgainAfter(view(questioned, [], IDLE))).toBeUndefined();
		const edited: Item = { id: 1, role: "user", text: "I changed the plan", artifact: { id: "a1", n: 2 } };
		expect(tryAgainAfter(view([edited, notes], [], IDLE))).toBeUndefined();
	});
});

describe("A reply that finished well", () => {
	const delivered: Item[] = [asked, message(2, "m1"), result(3, "m1", "delivered", false)];
	it("is the newest thing shown, delivered", () => {
		expect(answeredWell(view(delivered, [], IDLE))).toBe(true);
	});
	it("is not a failure, a stop, an undelivered message or a run that only took notes", () => {
		expect(answeredWell(view([asked, failed], [], IDLE))).toBe(false);
		expect(answeredWell(view([...delivered, { ...failed, id: 4 }], [], IDLE))).toBe(false);
		expect(answeredWell(view([asked, { ...failed, error: "interrupted" }], [], IDLE))).toBe(false);
		expect(
			answeredWell(
				view([asked, message(2, "m1"), result(3, "m1", "Not delivered: the connection closed", true)], [], IDLE),
			),
		).toBe(false);
		expect(answeredWell(view([asked, notes], [], IDLE))).toBe(false);
	});
});
