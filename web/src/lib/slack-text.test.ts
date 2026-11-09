import { expect, it } from "vitest";
import { slackBlocks, slackEmoji, slackLine } from "./slack-text.ts";

it("draws Slack's shortcodes as emoji, and leaves what it does not know", () => {
	expect(slackEmoji("shipped :rocket: :+1::skin-tone-3:")).toBe("shipped \u{1F680} \u{1F44D}\u{1F3FC}");
	expect(slackEmoji(":sunny:")).toBe("\u2600\ufe0f");
	expect(slackEmoji("at 10:30:45 :party-parrot:")).toBe("at 10:30:45 :party-parrot:");
});

it("reads as one line for a reference", () => {
	expect(slackLine("> asked\nanswer :rocket:")).toBe("asked answer \u{1F680}");
});

it("reads quoted lines as blocks", () => {
	expect(slackBlocks("> one\n> two\nanswer")).toEqual([
		{ quote: true, lines: ["one", "two"] },
		{ quote: false, lines: ["answer"] },
	]);
	expect(slackBlocks("lead\n>>> all\nof this")).toEqual([
		{ quote: false, lines: ["lead"] },
		{ quote: true, lines: ["all", "of this"] },
	]);
	expect(slackBlocks("a > b")).toEqual([{ quote: false, lines: ["a > b"] }]);
});
