import { describe, expect, it } from "vitest";
import { skillTokens, slashQuery } from "../src/core/skill-tokens.ts";

const names = ["research", "review", "trip-planner"];

describe("skill slash syntax", () => {
	it("finds whole known names in order, including repetitions", () => {
		const text = "/review then /research and /review";
		expect(skillTokens(text, names).map(({ name }) => name)).toEqual(["review", "research", "review"]);
		expect(
			skillTokens("Use /review, /unknown /workspace/x https://x.test/review", names).map(({ name }) => name),
		).toEqual(["review"]);
	});

	it("treats quoted, fenced and escaped slash names as literal text", () => {
		const text =
			"Show me `/review`, \" /research \", '/research' and \\/trip-planner, then /review.\n```\n/research\n```\n/research";
		expect(skillTokens(text, names).map(({ name }) => name)).toEqual(["review", "research"]);
		expect(slashQuery("`/rev", 5)).toBeUndefined();
		expect(slashQuery('"/rev', 5)).toBeUndefined();
		expect(slashQuery("'/rev", 5)).toBeUndefined();
		expect(slashQuery("\\/rev", 5)).toBeUndefined();
	});

	it("offers the token at the caret, including its untyped suffix for replacement", () => {
		expect(slashQuery("Ask /resarch before leaving", 8)).toEqual({ start: 4, end: 12, query: "res" });
		expect(slashQuery("/trip-", 6)).toEqual({ start: 0, end: 6, query: "trip-" });
		expect(slashQuery("https://a.test/rev", 18)).toBeUndefined();
	});
});
