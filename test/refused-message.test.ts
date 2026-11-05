/** A message the daemon refused never reached the owner: the chat does not draw it. */
import { describe, expect, it } from "vitest";
import type { Item } from "../src/server/api.ts";
import { type Live, view } from "../web/src/lib/chat.ts";

const IDLE: Live = { busy: false, running: [], thinking: false };
const said = (id: number, call: string, text: string): Item => ({
	id,
	role: "assistant",
	text: "",
	calls: [{ id: call, name: "message_user", args: { text } }],
});
const result = (id: number, call: string, text: string, error = false): Item => ({
	id,
	role: "tool",
	call,
	name: "message_user",
	text,
	error,
});

describe("a message the daemon refused", () => {
	it("is not drawn; one sent is, and one undelivered is, marked", () => {
		const items: Item[] = [
			said(1, "a", "No umbrella today."),
			result(2, "a", "Sent."),
			said(3, "b", "Still no umbrella."),
			result(4, "b", "Not sent: you have sent 3 messages since you last did anything else.", true),
			said(5, "c", "Again."),
			result(6, "c", "Not delivered: the gateway is down.", true),
		];
		const companion = view(items, [], IDLE, {}).filter((segment) => segment.kind === "companion");
		expect(companion.map((segment) => [segment.text, segment.undelivered])).toEqual([
			["No umbrella today.", false],
			["Again.", true],
		]);
	});
});
