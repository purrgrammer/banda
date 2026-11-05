/** A routine's title from its file name, each word as its description writes it. */
import { describe, expect, it } from "vitest";
import { nearTime, routineTitle } from "../web/src/app/titles.ts";

describe("routine titles", () => {
	it("keeps the capitals its description gives, and capitalises the first word", () => {
		expect(routineTitle("call-ana", "Every Monday at 9:00, remind you to call Ana.")).toBe("Call Ana");
		expect(routineTitle("portugal-fun-fact", "Share one fun fact about Portugal")).toBe("Portugal fun fact");
		expect(routineTitle("pr-watch")).toBe("Pr watch");
		expect(routineTitle("pr-watch", "Watch my PR queue")).toBe("PR watch");
	});
});

describe("a time near now", () => {
	const now = new Date(2026, 10, 4, 8, 58).getTime();
	const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).getTime();
	it("says today, tomorrow and yesterday, the weekday within the week, else the date", () => {
		expect(nearTime(at(4, 9), now)).toMatch(/^Today 0?9:00/);
		expect(nearTime(at(5, 9), now)).toMatch(/^Tomorrow /);
		expect(nearTime(at(3, 9), now)).toMatch(/^Yesterday /);
		expect(nearTime(at(7, 9), now)).not.toMatch(/^(Today|Tomorrow)/);
		expect(nearTime(at(20, 9), now)).toMatch(/20/);
	});
});
