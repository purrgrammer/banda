import { describe, expect, it } from "vitest";
import { frontmatter } from "../src/core/agents.ts";
import { defaultAvatarFace, readAvatarFace, writeAvatarFace } from "../src/core/avatar-face.ts";

describe("agent face representation spike", () => {
	it("keeps the complete default chat bubble and colour in an agent file scalar", () => {
		const original = defaultAvatarFace();
		const text = `---\nface: ${writeAvatarFace(original)}\n---\nPersonality`;
		const parsed = frontmatter(text, ["face"]);
		expect(parsed?.errors).toEqual([]);
		const read = readAvatarFace(parsed?.one("face") ?? "");
		expect(read).toEqual({ ok: true, face: original });
		expect(original.definition.id).toBe("chat");
	});
	it("rejects extra fields, invalid colors, invalid geometry and oversize", () => {
		const face = defaultAvatarFace();
		for (const value of [
			{ ...face, extra: true },
			{ ...face, color: "url(https://example.com)" },
			{ ...face, definition: { ...face.definition, body: { path: "<svg onload=alert(1)>" } } },
		])
			expect(readAvatarFace(JSON.stringify(value)).ok).toBe(false);
		expect(readAvatarFace("x".repeat(16_385)).ok).toBe(false);
	});
	it("does not share the mutable gallery definition between agents", () => {
		const a = defaultAvatarFace();
		const b = defaultAvatarFace();
		expect(a.definition).not.toBe(b.definition);
		expect(a).toEqual(b);
	});
});
