/** The chat's "Browsed" line: the pages a stretch of browser calls went to. */
import { describe, expect, it } from "vitest";
import type { Item } from "../src/server/api.ts";
import { withBrowsed } from "../web/src/lib/segments/browser.ts";

const go = (id: number, call: string, url: string): Item => ({
	id,
	role: "assistant",
	text: "",
	calls: [{ id: call, name: "browser_navigate", args: { url } }],
});
const result = (id: number, call: string, error = false): Item => ({
	id,
	role: "tool",
	call,
	name: "browser_navigate",
	text: "",
	error,
});

describe("the pages browsed", () => {
	it("are those whose call went through: one waiting for the owner, or refused, was not browsed", () => {
		const items: Item[] = [
			go(1, "a", "https://a.example/"),
			result(2, "a"),
			go(3, "b", "https://b.example/"),
			result(4, "b", true),
			go(5, "c", "https://c.example/"),
		];
		const lines = withBrowsed([], items, false).filter((segment) => segment.kind === "browsed");
		expect(lines).toEqual([expect.objectContaining({ pages: ["https://a.example/"] })]);
	});
});
