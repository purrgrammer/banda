/**
 * The one maker of a file's name: whatever the words, the name it makes is one the parser takes. A property over
 * arbitrary strings, and the examples that bit.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AGENT_NAME } from "../src/core/agents.ts";
import { fileNameFor, NAME_LENGTH } from "../src/core/names.ts";
import { pbtRuns } from "./pbt.ts";

describe("a file's name made from words", () => {
	it("always meets the name rule, for any words of any kind", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.string(), fc.string({ unit: "grapheme" }), fc.string({ minLength: 41, maxLength: 120 })),
				fc.constantFrom("routine" as const, "watch" as const),
				(words, kind) => {
					const name = fileNameFor(words, kind);
					return AGENT_NAME.test(name) && name.length <= NAME_LENGTH + kind.length + 1;
				},
			),
			{ numRuns: pbtRuns(500) },
		);
	});

	it("keeps whole words, drops accents, and puts a name that begins with a digit behind its kind", () => {
		expect(fileNameFor("Morning brief", "routine")).toBe("morning-brief");
		expect(fileNameFor("Economía 🏠", "watch")).toBe("economia");
		expect(fileNameFor("3 things to check", "routine")).toBe("routine-3-things-to-check");
		expect(fileNameFor("1e0DrWx78-yd70xjBA1H_LB-45SrxCrDIkq-PSRJ328Y", "watch")).toBe(
			"watch-1e0drwx78-yd70xjba1h-lb-45srxcrdikq",
		);
		expect(fileNameFor("", "watch")).toBe("watch");
		expect(fileNameFor("🏠 🚀", "routine")).toBe("routine");
		expect(fileNameFor("a".repeat(60), "watch")).toBe("a".repeat(NAME_LENGTH));
		expect(fileNameFor("one two three four five six seven eight nine ten eleven", "routine")).toBe(
			"one-two-three-four-five-six-seven-eight",
		);
	});
});
