/** The status line: the date and the hour in a time zone, so the model never guesses the date. */
import { describe, expect, it } from "vitest";
import { agentMemoryPath, GLOBAL_MEMORY } from "../src/core/memory.ts";
import { nowLine, nowSection } from "../src/core/now.ts";
import { context } from "../src/core/store.ts";

const AT = Date.parse("2026-11-04T09:47:12Z");
const HOUR = 3_600_000;
const input = {
	conversationId: "42",
	read: { snapshot: async () => ({ chats: { "42": "reader" } }) },
} as unknown as Parameters<ReturnType<typeof nowSection>["render"]>[0];

const facts = (n: number) => Array.from({ length: n }, (_, i) => `- fact number ${i} ${"x".repeat(60)}`).join("\n");

describe("now", () => {
	it("says the day, the date and the hour, in the zone given, to the hour", () => {
		expect(nowLine(AT, "Europe/Madrid")).toContain(
			"Wednesday, 4 November 2026, between 10:00 and 11:00 CET (Europe/Madrid)",
		);
	});

	it("renders as the prompt section `now`, naming the agent", async () => {
		const section = nowSection(() => AT);
		expect(section.key).toBe("now");
		expect(await section.render(input, context)).toContain("Your stable agent id is reader.");
	});

	it("reads the same within an hour at the same fill, and differently when the hour turns", async () => {
		const files = new Map([
			[agentMemoryPath("reader"), facts(15)],
			[GLOBAL_MEMORY, ""],
		]);
		const memory = { read: async (path: string) => files.get(path) };
		const line = await nowSection(() => AT, memory).render(input, context);
		expect(await nowSection(() => AT + 600_000, memory).render(input, context)).toBe(line);
		expect(await nowSection(() => AT + HOUR, memory).render(input, context)).not.toBe(line);
	});

	it("says how full the agent's memory is, in steps of ten percent, so saves rarely change the line", async () => {
		const files = new Map([
			[agentMemoryPath("reader"), facts(15)],
			[GLOBAL_MEMORY, ""],
		]);
		const memory = { read: async (path: string) => files.get(path) };
		const line = await nowSection(() => AT, memory).render(input, context);
		expect(line).toMatch(/Memory: yours [1-7]0% full, shared 0%\./);
		files.set(agentMemoryPath("reader"), `${facts(15)}\n- one more short fact`);
		expect(await nowSection(() => AT, memory).render(input, context)).toBe(line);
		files.set(agentMemoryPath("reader"), facts(40));
		expect(await nowSection(() => AT, memory).render(input, context)).toMatch(
			/Memory: yours [89]0% full, shared 0%; merge or forget facts\./,
		);
	});

	it("leaves memory out when it cannot be read", async () => {
		const memory = {
			read: async () => {
				throw new Error("box down");
			},
		};
		const line = await nowSection(() => AT, memory).render(input, context);
		expect(line).toContain("Your stable agent id is reader.");
		expect(line).not.toContain("Memory:");
	});
});
