import { describe, expect, it } from "vitest";
import { plainText } from "../web/src/lib/plain.ts";

describe("markdown before the renderer loads", () => {
	it("shows the words without their syntax", () => {
		expect(plainText("Plan my trip to **Lisbon**, please.")).toBe("Plan my trip to Lisbon, please.");
		expect(plainText("# Friday\n- the *9:10* train\n- call `Ana`")).toBe("Friday\n• the 9:10 train\n• call Ana");
		expect(plainText("See [the plan](https://example.com) and ![map](sha256:abc)")).toBe("See the plan and map");
		expect(plainText("> quoted\n\n---\n~~gone~~ __kept__")).toBe("quoted\n\n\ngone kept");
		expect(plainText("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
		expect(plainText("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("| a | b |\n\n| 1 | 2 |");
	});

	it("leaves no raw markers from an unfinished stream, and words with underscores alone", () => {
		expect(plainText("The price is **279")).toBe("The price is 279");
		expect(plainText("snake_case_name and 2 * 3 * 4")).toBe("snake_case_name and 2 * 3 * 4");
		expect(plainText("an escaped \\*star\\*")).toBe("an escaped *star*");
	});
});
