/**
 * A watch's file name, whichever path writes it: the object's words when it has them, the card's when the object is
 * named by an id, and always a name the parser takes. Found when an agent's `watch` call on a Drive file was refused
 * for the name the tool itself had made from the file's id.
 */
import { describe, expect, it } from "vitest";
import { WATCH_NAME, watchNameFor } from "../src/core/watches.ts";

const SHEET = {
	card: "file" as const,
	name: "Economía 🏠",
	kind: "sheet" as const,
	mimeType: "application/vnd.google-apps.spreadsheet",
	owner: "Alejandro",
	modified: "2026-11-01T09:47:37Z",
	size: null,
	description: "",
	url: "https://docs.google.com/spreadsheets/d/1e0DrWx78-yd70xjBA1H_LB-45SrxCrDIkq-PSRJ328Y/edit",
};

describe("a watch's name", () => {
	it("is the object's words when it has them", () => {
		expect(watchNameFor("acme/banda #142")).toBe("acme-banda-142");
		expect(watchNameFor("purrgrammer/banda · discussion #52")).toBe("purrgrammer-banda-discussion-52");
		expect(watchNameFor("mail matching newer_than:7d")).toBe("mail-matching-newer-than-7d");
	});

	it("is the card's words when the object is named by an id, else the id behind watch-, and always a name", () => {
		const id = "1e0DrWx78-yd70xjBA1H_LB-45SrxCrDIkq-PSRJ328Y";
		expect(watchNameFor(id, SHEET)).toBe("economia");
		expect(watchNameFor(id)).toBe("watch-1e0drwx78-yd70xjba1h-lb-45srxcrdikq");
		// an id that begins with a letter stands as it is; one that does not goes behind watch-
		expect(watchNameFor("cGxhbm5pbmcxMjM0NTY3OA")).toBe("cgxhbm5pbmcxmjm0nty3oa");
		expect(
			watchNameFor("c1234567890", { ...SHEET, card: "contact", name: "Ana García", emails: "", phones: "" } as never),
		).toBe("ana-garcia");
		expect(watchNameFor("")).toBe("watch");
		for (const name of [id, "cGxhbm5pbmcxMjM0NTY3OA", "", "🏠", "acme/banda #142"])
			expect(WATCH_NAME.test(watchNameFor(name))).toBe(true);
	});
});
