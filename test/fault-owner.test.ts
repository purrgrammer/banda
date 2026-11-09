import { describe, expect, it } from "vitest";
import { answersGiven, noteAnswer } from "./fault/owner.ts";
import { tempHome } from "./helpers.ts";

describe("what a fault worker notes the owner said", () => {
	it("an answer a kill stopped before it was kept, said again to the same ask, is one answer", async () => {
		const home = await tempHome();
		noteAnswer(home, "approve", "ask-1");
		noteAnswer(home, "approve", "ask-1");
		expect(answersGiven(home)).toEqual(["approve"]);
	});

	it("a second ask approved is still seen as a second approval, in order", async () => {
		const home = await tempHome();
		noteAnswer(home, "approve", "ask-1");
		noteAnswer(home, "approve", "ask-2");
		noteAnswer(home, "asked-again", "ask-3");
		expect(answersGiven(home)).toEqual(["approve", "approve", "asked-again"]);
	});
});
