/** The chat's "Browsed" line: the pages a stretch of browser calls went to; and its "Read" line, for web_fetch. */
import { describe, expect, it } from "vitest";
import type { Item } from "../src/server/api.ts";
import { withBrowsed } from "../web/src/lib/segments/browser.ts";
import { withRead } from "../web/src/lib/segments/web.ts";

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

describe("the pages read", () => {
	const fetch = (id: number, call: string, url: string): Item => ({
		id,
		role: "assistant",
		text: "",
		calls: [{ id: call, name: "web_fetch", args: { url } }],
	});
	const read = (id: number, call: string, error = false): Item => ({
		id,
		role: "tool",
		call,
		name: "web_fetch",
		text: "",
		error,
	});
	it("are one line per stretch between the owner's messages, the last first, a refused read left out", () => {
		const items: Item[] = [
			fetch(1, "a", "https://a.example/"),
			read(2, "a"),
			fetch(3, "b", "https://b.example/"),
			read(4, "b", true),
			fetch(5, "c", "https://c.example/"),
			read(6, "c"),
			{ id: 7, role: "user", text: "and now?" },
			fetch(8, "d", "https://d.example/"),
			read(9, "d"),
		];
		const lines = withRead([], items).filter((segment) => segment.kind === "read");
		expect(lines).toEqual([
			{ kind: "read", key: "5:read", pages: ["https://c.example/", "https://a.example/"] },
			{ kind: "read", key: "8:read", pages: ["https://d.example/"] },
		]);
	});
});
