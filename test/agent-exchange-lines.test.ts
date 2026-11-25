/**
 * The two lines a message between agents leaves in the chats: "X sent a message" in the recipient's, "Messaged X" in
 * the sender's, each naming the call that sent it, so both open the exchange at the same message. A send the daemon
 * refused reached no one and leaves no line.
 */
import { describe, expect, it } from "vitest";
import type { Item } from "../src/server/api.ts";
import { type Live, shown, view } from "../web/src/lib/chat.ts";

const IDLE: Live = { busy: false, running: [], thinking: false };
const sent = (id: number, call: string, agent: string, text: string): Item => ({
	id,
	role: "assistant",
	text: "",
	calls: [{ id: call, name: "message_agent", args: { agent, text } }],
	at: id * 1000,
});
const result = (id: number, call: string, text: string, error = false): Item => ({
	id,
	role: "tool",
	call,
	name: "message_agent",
	text,
	error,
});

describe("a message between agents in the feed", () => {
	it("is a line in the sender's chat, with the call that sent it; a refused send is none", () => {
		const items: Item[] = [
			sent(1, "c1", "reader", "Please look into it."),
			result(2, "c1", "Message delivered to the agent's chat."),
			sent(3, "c2", "ghost", "Anyone there?"),
			result(4, "c2", "Not sent: there is no active agent by that name.", true),
			// still going: its result not in yet
			sent(5, "c3", "reader", "And this."),
		];
		const lines = view(items, [], IDLE, {}).filter((segment) => segment.kind === "messaged");
		expect(lines).toEqual([
			{ kind: "messaged", key: "1:c1", to: "reader", text: "Please look into it.", call: "c1", at: 1000 },
			{ kind: "messaged", key: "5:c3", to: "reader", text: "And this.", call: "c3", at: 5000 },
		]);
		expect(shown(lines[0] as (typeof lines)[number])).toEqual(["reader", "Please look into it."]);
	});

	it("is a line in the recipient's chat that names the same call", () => {
		const items: Item[] = [
			{ id: 7, role: "agentMessage", from: "sancho", text: "Please look into it.", at: 7000, call: "c1" },
			{ id: 8, role: "agentMessage", from: "sancho", text: "From before calls were kept.", at: 8000 },
		];
		expect(view(items, [], IDLE, {}).filter((segment) => segment.kind === "agentMessage")).toEqual([
			{ kind: "agentMessage", key: "7", from: "sancho", text: "Please look into it.", at: 7000, call: "c1" },
			{ kind: "agentMessage", key: "8", from: "sancho", text: "From before calls were kept.", at: 8000 },
		]);
	});
});
