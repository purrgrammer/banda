import { describe, expect, it } from "vitest";
import { wallOf, withWall } from "./wall.ts";

describe("an event's time in a picker", () => {
	it("shows the wall clock it was given in and keeps its offset when edited", () => {
		expect(wallOf("2026-11-09T16:00:00+01:00")).toBe("2026-11-09T16:00");
		expect(withWall("2026-11-09T16:00:00+01:00", "2026-11-09T17:30")).toBe("2026-11-09T17:30:00+01:00");
		expect(withWall("2026-11-09T16:00:00Z", "2026-11-10T08:00")).toBe("2026-11-10T08:00:00Z");
	});

	it("keeps a date a date, and says nothing of what is neither", () => {
		expect(wallOf("2026-11-11")).toBe("2026-11-11");
		expect(withWall("2026-11-11", "2026-11-12")).toBe("2026-11-12");
		expect(wallOf("tomorrow")).toBe("");
		expect(withWall("", "")).toBe("");
	});

	it("gives a time with no offset the browser's own", () => {
		expect(withWall("", "2026-11-09T09:00")).toMatch(/^2026-11-09T09:00:00(Z|[+-]\d{2}:\d{2})$/);
	});
});
