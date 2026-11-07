import { describe, expect, it } from "vitest";
import { fileType, safeObjectUrl } from "./Object.tsx";

describe("connection object links", () => {
	it("accepts the declared Gmail message URL and GitHub object URLs", () => {
		expect(safeObjectUrl("https://mail.google.com/mail/u/0/#all/abc_123-xy")).toBeUndefined();
		expect(safeObjectUrl("https://github.com/banda/repo/pull/42")).toBe("https://github.com/banda/repo/pull/42");
	});

	it("rejects Gmail lookalikes, non-message paths and credentialed URLs", () => {
		for (const value of [
			"https://mail.google.com.evil.example/mail/u/0/#all/id",
			"https://mail.google.com/mail/u/0/#settings/general",
			"https://mail.google.com/mail/u/0/#all/id?next=https://evil.example",
			"https://user:pass@mail.google.com/mail/u/0/#all/id",
			"http://mail.google.com/mail/u/0/#all/id",
		])
			expect(safeObjectUrl(value)).toBeUndefined();
	});
});

describe("a Drive file's type in words", () => {
	it("names Google's own kinds, never their raw type, and keeps an ordinary file's type", () => {
		expect(fileType({ kind: "file", mimeType: "application/vnd.google-apps.drawing" })).toBe("Google Drawing");
		expect(fileType({ kind: "file", mimeType: "application/vnd.google-apps.shortcut" })).toBe("Shortcut");
		expect(fileType({ kind: "file", mimeType: "application/vnd.google-apps.unheardof" })).toBe("Google file");
		expect(fileType({ kind: "file", mimeType: "text/csv" })).toBe("text/csv");
		expect(fileType({ kind: "sheet", mimeType: "application/vnd.google-apps.spreadsheet" })).toBe("Google Sheet");
	});
});
