import { getExample } from "open-bot-avatar";
import { describe, expect, it } from "vitest";
import { avatarCandidate } from "../src/core/avatar-candidate.ts";

describe("avatar candidates", () => {
	it("accepts a bundled definition and returns normalized geometry", () => {
		const result = avatarCandidate(JSON.stringify(getExample("mug")));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.definition.id).toBe("mug");
	});
	it("refuses malformed and oversized input before validation", () => {
		expect(avatarCandidate("{").ok).toBe(false);
		expect(avatarCandidate("é".repeat(8193))).toEqual({
			ok: false,
			errors: ["The face definition is too large (16 KB maximum)."],
		});
	});
	it("refuses markup, unknown fields and excessive paths", () => {
		const base = getExample("mug");
		if (!base) throw new Error("missing example");
		for (const input of [
			{ ...base, script: "alert(1)" },
			{ ...base, body: { path: "<svg onload=alert(1)>" } },
			{ ...base, body: { path: `M10 10 ${"L10 10 ".repeat(1000)}Z` } },
		])
			expect(avatarCandidate(JSON.stringify(input)).ok).toBe(false);
	});
});
