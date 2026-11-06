/** The app's places in the hash: read and written back the same; anything else is home. */
import { describe, expect, it } from "vitest";
import { hrefOf, isSourceHref, lastOf, parse } from "../web/src/app/where.ts";

describe("where", () => {
	it("reads each place and writes it back", () => {
		for (const hash of [
			"#/",
			"#/a/sancho",
			"#/a/mara-2?at=41",
			"#/g/7",
			"#/g/7?at=3",
			"#/settings",
			"#/connections",
			"#/specimen",
		])
			expect(hrefOf(parse(hash))).toBe(hash);
	});

	it("takes anything else as home, and a bad entry as none", () => {
		expect(parse("#/inbox")).toEqual({ name: "home" });
		expect(parse("#/a/Bad Name")).toEqual({ name: "home" });
		expect(parse("#/a/mara?at=-3")).toEqual({ name: "agent", id: "mara" });
		expect(parse("")).toEqual({ name: "home" });
	});

	it("remembers only a chat as the last place", () => {
		expect(lastOf("#/a/mara?at=9")).toEqual({ name: "agent", id: "mara" });
		expect(lastOf("#/g/4")).toEqual({ name: "group", room: 4 });
		expect(lastOf("#/settings")).toBeUndefined();
		expect(lastOf(null)).toBeUndefined();
	});
});

it("only canonical search source links open inside the app", () => {
	for (const href of ["#/a/mara?at=9", "#/g/4?at=17", "#/artifact/abc123"]) expect(isSourceHref(href)).toBe(true);
	for (const href of [
		undefined,
		"https://example.com/#/a/mara",
		"javascript:alert(1)",
		"#/settings",
		"#token=secret",
		"#/a/mara?token=secret",
		"#/g/-1",
	])
		expect(isSourceHref(href)).toBe(false);
});
