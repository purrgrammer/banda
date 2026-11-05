import { describe, expect, it } from "vitest";
import type { Item, TurnUsage } from "../../../src/server/api.ts";
import { lastTurn, turnTotals } from "./usage.ts";

const usage = (input: number, cacheRead: number, output: number, cost = 0, reasoning?: number): TurnUsage => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	...(reasoning === undefined ? {} : { reasoning }),
	cost,
});
const MODEL = "openai/gpt-5.5";
const call = (id: string) => [{ id, name: "message_user", args: { text: "hi" } }];

describe("a turn's usage", () => {
	const items: Item[] = [
		{ id: 1, role: "user", text: "first" },
		{ id: 2, role: "assistant", text: "", calls: call("a"), model: MODEL, usage: usage(100, 5_000, 20, 0.01, 8) },
		{ id: 3, role: "tool", call: "a", name: "message_user", text: "Sent.", error: false },
		{ id: 4, role: "assistant", text: "done", model: MODEL, usage: usage(30, 5_120, 5, 0.002) },
		{ id: 5, role: "user", text: "second" },
		{ id: 6, role: "assistant", text: "", calls: call("b"), model: MODEL, usage: usage(40, 5_160, 10, 0.003) },
		{ id: 7, role: "tool", call: "b", name: "message_user", text: "Sent.", error: false },
	];

	it("is shown once, at the turn's last answer, summed over its requests", () => {
		const turns = turnTotals(items, true);
		expect([...turns.keys()]).toEqual([4]);
		expect(turns.get(4)).toEqual({
			model: MODEL,
			usage: { input: 130, output: 25, cacheRead: 10_120, cacheWrite: 0, reasoning: 8, cost: 0.012 },
			requests: 2,
			// the last request: everything it sent, and what came back
			context: 30 + 5_120 + 5,
		});
		expect(lastTurn(turns)?.requests).toBe(2);
	});

	it("shows nothing for a turn still running, and closes it when its run ends", () => {
		expect(turnTotals(items, true).has(6)).toBe(false);
		const done = [...items, { id: 8, role: "assistant", text: "ok", model: MODEL, usage: usage(12, 5_200, 3) } as Item];
		expect(turnTotals(done, true).get(8)?.usage.input).toBe(52);
		// a run that ended without a final answer (the daemon is idle) still ends its turn
		expect(turnTotals(items, false).get(6)?.requests).toBe(1);
	});

	it("keeps a failed, retried request in its turn, and ends the turn at one nothing came after", () => {
		const retried: Item[] = [
			{ id: 1, role: "user", text: "go" },
			{ id: 2, role: "assistant", text: "", error: "overloaded", model: MODEL, usage: usage(0, 0, 0) },
			{ id: 3, role: "assistant", text: "ok", model: MODEL, usage: usage(50, 0, 5) },
			{ id: 4, role: "user", text: "again" },
			{ id: 5, role: "assistant", text: "", error: "overloaded", model: MODEL, usage: usage(0, 0, 0) },
			{ id: 6, role: "user", text: "and again" },
		];
		const turns = turnTotals(retried, true);
		expect(turns.get(3)).toMatchObject({ requests: 2, usage: { input: 50 }, context: 55 });
		// failed with nothing after: the next input starts another turn; no usage counted, no context
		expect(turns.get(5)).toEqual({ model: MODEL, usage: usage(0, 0, 0), requests: 1 });
	});

	it("ends at an interrupted answer, and skips a turn whose start is on a page not read yet", () => {
		const page: Item[] = [
			{ id: 9, role: "tool", call: "x", name: "read", text: "…", error: false },
			{ id: 10, role: "assistant", text: "half of it", model: MODEL, usage: usage(10, 0, 1) },
			{ id: 11, role: "user", text: "stop" },
			{ id: 12, role: "assistant", text: "", error: "interrupted", model: MODEL, usage: usage(7, 0, 0) },
		];
		const turns = turnTotals(page, true);
		expect(turns.has(10)).toBe(false);
		expect(turns.get(12)?.requests).toBe(1);
	});
});
