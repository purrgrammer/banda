import { describe, expect, it } from "vitest";
import { safeObjectUrl } from "./Object.tsx";

describe("connection object links", () => {
	it("accepts the declared Gmail message URL and GitHub object URLs", () => {
		expect(safeObjectUrl("https://mail.google.com/mail/u/0/#all/abc_123-xy")).toBe(
			"https://mail.google.com/mail/u/0/#all/abc_123-xy",
		);
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
