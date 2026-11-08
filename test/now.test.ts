/** The status line: the date and the hour in a time zone, so the model never guesses the date. */
import { describe, expect, it } from "vitest";
import { agentMemoryPath, GLOBAL_MEMORY } from "../src/core/memory.ts";
import { nowLine, statusLine, withStatus } from "../src/core/now.ts";
import { context } from "../src/core/store.ts";

const api = { conversationId: "42", snapshot: async () => ({ chats: { "42": "reader" } }) } as unknown as Parameters<
	typeof statusLine
>[0];

describe("now", () => {
	it("says the day, the date and the hour, in the zone given, to the hour", () => {
		const at = Date.parse("2026-11-04T09:47:12Z");
		expect(nowLine(at, "Europe/Madrid")).toContain(
			"Wednesday, 4 November 2026, between 10:00 and 11:00 CET (Europe/Madrid)",
		);
		// the same hour reads the same, so the line changes at most once an hour
		expect(nowLine(at + 600_000, "Europe/Madrid")).toBe(nowLine(at, "Europe/Madrid"));
	});

	it("includes the current agent id in the status line", async () => {
		const at = Date.parse("2026-11-04T09:47:12Z");
		expect(await statusLine(api, context, () => at)).toContain("Your stable agent id is reader.");
	});

	it("comes just before the last user message, in one place for every request of a turn", async () => {
		const at = Date.parse("2026-11-04T09:47:12Z");
		const status = { role: "system", content: await statusLine(api, context, () => at), timestamp: at };
		const earlier = { role: "user" as const, content: "hi", timestamp: at };
		const turn = { role: "user" as const, content: "what day is it?", timestamp: at };
		expect(await withStatus([earlier, turn], api, context, () => at)).toEqual([earlier, status, turn]);
		const step = [
			earlier,
			turn,
			{ role: "toolResult" as const, toolCallId: "1", toolName: "bash", content: [], isError: false, timestamp: at },
		];
		const sent = await withStatus(step, api, context, () => at);
		expect(sent).toEqual([earlier, status, ...step.slice(1)]);
		expect(sent[2]).toBe(turn);
	});

	it("says how full the agent's memory is, in steps of ten percent, so saves rarely change the line", async () => {
		const at = Date.parse("2026-11-04T09:47:12Z");
		const facts = (n: number) => Array.from({ length: n }, (_, i) => `- fact number ${i} ${"x".repeat(60)}`).join("\n");
		const files = new Map([
			[agentMemoryPath("reader"), facts(15)],
			[GLOBAL_MEMORY, ""],
		]);
		const memory = { read: async (path: string) => files.get(path) };
		const line = await statusLine(api, context, () => at, memory);
		expect(line).toMatch(/Memory: yours [1-7]0% full, shared 0%\./);
		files.set(agentMemoryPath("reader"), `${facts(15)}\n- one more short fact`);
		expect(await statusLine(api, context, () => at, memory)).toBe(line);
		files.set(agentMemoryPath("reader"), facts(40));
		expect(await statusLine(api, context, () => at, memory)).toMatch(
			/Memory: yours [89]0% full, shared 0%; merge or forget facts\./,
		);
	});

	it("leaves memory out when it cannot be read", async () => {
		const at = Date.parse("2026-11-04T09:47:12Z");
		const memory = {
			read: async () => {
				throw new Error("box down");
			},
		};
		const line = await statusLine(api, context, () => at, memory);
		expect(line).toContain("Your stable agent id is reader.");
		expect(line).not.toContain("memory");
	});
});
