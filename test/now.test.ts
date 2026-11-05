/** The status line: the date and the hour in a time zone, so the model never guesses the date. */
import { describe, expect, it } from "vitest";
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
});
