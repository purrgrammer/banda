/** The status line: the date and the hour in a time zone, so the model never guesses the date. */
import { describe, expect, it } from "vitest";
import { agentMemoryPath, GLOBAL_MEMORY } from "../src/core/memory.ts";
import { nowLine, nowSection } from "../src/core/now.ts";
import { context } from "../src/core/store.ts";

describe("now", () => {
	it("says the day, the date and the hour, in the zone given, to the hour", () => {
		const at = Date.parse("2026-11-04T09:47:12Z");
		expect(nowLine(at, "Europe/Madrid")).toContain("Wednesday, 4 November 2026 at 10:00 CET (Europe/Madrid)");
		// the same hour reads the same, so the section changes at most once an hour
		expect(nowLine(at + 600_000, "Europe/Madrid")).toBe(nowLine(at, "Europe/Madrid"));
	});

	it("includes the current agent id in the dynamic status section", async () => {
		const at = Date.parse("2026-11-04T09:47:12Z");
		const section = nowSection(() => at);
		const input = {
			conversationId: "42",
			read: { snapshot: async () => ({ chats: { "42": "reader" } }) },
		} as unknown as Parameters<typeof section.render>[0];
		expect(await section.render(input, context)).toContain("Your stable agent id is reader.");
	});

	it("says how full the agent's memory is, in steps of ten percent, so saves rarely change the line", async () => {
		const at = Date.parse("2026-11-04T09:47:12Z");
		const facts = (n: number) => Array.from({ length: n }, (_, i) => `- fact number ${i} ${"x".repeat(60)}`).join("\n");
		const files = new Map([
			[agentMemoryPath("reader"), facts(15)],
			[GLOBAL_MEMORY, ""],
		]);
		const memory = { read: async (path: string) => files.get(path) };
		const input = {
			conversationId: "42",
			read: { snapshot: async () => ({ chats: { "42": "reader" } }) },
		} as unknown as Parameters<ReturnType<typeof nowSection>["render"]>[0];
		const line = await nowSection(() => at, memory).render(input, context);
		expect(line).toMatch(/Memory: yours [1-7]0% full, shared 0%\./);
		files.set(agentMemoryPath("reader"), `${facts(15)}\n- one more short fact`);
		expect(await nowSection(() => at, memory).render(input, context)).toBe(line);
		files.set(agentMemoryPath("reader"), facts(40));
		expect(await nowSection(() => at, memory).render(input, context)).toMatch(
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
		const input = {
			conversationId: "42",
			read: { snapshot: async () => ({ chats: { "42": "reader" } }) },
		} as unknown as Parameters<ReturnType<typeof nowSection>["render"]>[0];
		const line = await nowSection(() => at, memory).render(input, context);
		expect(line).toContain("Your stable agent id is reader.");
		expect(line).not.toContain("memory");
	});
});
