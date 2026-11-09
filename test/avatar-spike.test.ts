import { getExample, renderAvatarSvg, validateAvatar } from "open-bot-avatar";
import { describe, expect, it } from "vitest";

describe("avatar specimen", () => {
	it("validates and renders the bundled shapes at the app's face sizes", () => {
		for (const id of ["sprout", "mug", "controller", "lightbulb"]) {
			const definition = getExample(id);
			expect(definition).toBeDefined();
			const result = validateAvatar(definition);
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(result.errors.join(", "));
			for (const size of [28, 40, 64, 96]) {
				const svg = renderAvatarSvg(result.value, { size, color: "#56a875" });
				expect(svg).toContain("<svg");
				expect(svg).toContain("<path");
			}
		}
	});
});
