/** A preview's line of markdown (web/src/chat/inline.tsx): formatting as such, never its marks. */
import { describe, expect, it } from "vitest";
import { inlineParts } from "../web/src/chat/inline.tsx";

describe("a preview's markdown", () => {
	it("reads bold, italic and code as such, and a link as its words", () => {
		expect(inlineParts("Three **good** picks, *all* by `train`: see [Toledo](https://x.example/)")).toEqual([
			{ text: "Three " },
			{ text: "good", style: "bold" },
			{ text: " picks, " },
			{ text: "all", style: "italic" },
			{ text: " by " },
			{ text: "train", style: "code" },
			{ text: ": see Toledo" },
		]);
	});

	it("drops the marks of blocks and keeps one line", () => {
		expect(inlineParts("## Plan\n- **Toledo** first\n> quoted")).toEqual([
			{ text: "Plan " },
			{ text: "Toledo", style: "bold" },
			{ text: " first quoted" },
		]);
	});

	it("leaves a mark the cut left open as plain text", () => {
		expect(inlineParts("Madrid leads with **3.4 mill")).toEqual([{ text: "Madrid leads with **3.4 mill" }]);
		expect(inlineParts("snake_case and 2 * 3")).toEqual([{ text: "snake_case and 2 * 3" }]);
	});
});
