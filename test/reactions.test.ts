import { describe, expect, it } from "vitest";
import type { Item } from "../src/server/api.ts";
import { type Live, type Segment, view } from "../web/src/lib/chat.ts";
import { reactionsOf } from "../web/src/lib/segments/reactions.ts";

const IDLE: Live = { busy: false, running: [], thinking: false };
const BUSY: Live = { busy: true, running: [{ call: "c9", doing: "reading notes.md" }], thinking: false };

const user = (id: number, text: string): Item => ({ id, role: "user", text });
const call = (id: number, callId: string, name: string, args: Record<string, unknown>): Item => ({
	id,
	role: "assistant",
	text: "",
	calls: [{ id: callId, name, args }],
});
const result = (id: number, callId: string, name: string, error = false, text = ""): Item => ({
	id,
	role: "tool",
	call: callId,
	name,
	text,
	error,
});

const kinds = (segments: Segment[]) => segments.map((s) => s.kind);

describe("reactions in the chat", () => {
	it("no inferred reaction when the model fails, is still running, or replies in words", () => {
		const items = [
			user(1, "hi"),
			{ id: 2, role: "assistant" as const, text: "", error: "provider unavailable" },
			user(3, "and?"),
		];
		expect(reactionsOf(items).size).toBe(0);
		expect(view(items, [], BUSY).filter((segment) => segment.kind === "owner-message")).toEqual([
			expect.objectContaining({ key: "1" }),
			expect.objectContaining({ key: "3" }),
		]);
		for (const segment of view(items, [], BUSY))
			if (segment.kind === "owner-message") expect(segment).not.toHaveProperty("reaction");
	});

	it("a reaction alone goes on the message its run answered and draws no bubble; a refused one is not shown", () => {
		const items = [
			user(1, "thanks!"),
			call(2, "c1", "message_user", { reaction: "👍" }),
			result(3, "c1", "message_user"),
			user(4, "ok"),
			call(5, "c2", "message_user", { reaction: "ok" }),
			result(6, "c2", "message_user", true, "Not sent: a reaction is exactly one emoji."),
			user(7, "still there?"),
			call(8, "c3", "message_user", { reaction: "👋" }),
		];
		const segments = view(items, [], IDLE);
		expect(kinds(segments)).toEqual(["owner-message", "owner-message", "owner-message"]);
		expect(segments[0]).toMatchObject({ text: "thanks!", reaction: "👍" });
		expect(segments[1]).not.toHaveProperty("reaction");
		expect(segments[2]).not.toHaveProperty("reaction");
	});
});
