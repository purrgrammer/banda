import { describe, expect, it } from "vitest";
import { AVATAR_INSTRUCTIONS } from "../src/core/avatar-instructions.ts";

describe("shipped avatar instructions", () => {
	it("fits the bound a face definition is held to, and leaves acceptance to the owner", () => {
		expect(Buffer.byteLength(AVATAR_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(16_384);
		expect(AVATAR_INSTRUCTIONS).toContain("at most 16,384 UTF-8 bytes");
		expect(AVATAR_INSTRUCTIONS).toContain("Do not write agents/ files");
		expect(AVATAR_INSTRUCTIONS).toContain("explicitly accept");
	});
});
