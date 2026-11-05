import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { Face, FaceStack } from "../chat/Face.tsx";
import { AvatarChoices } from "./Choices.tsx";
import { COLORS, customColors, SHAPES } from "./choices.ts";

vi.mock("./Renderer.tsx", () => ({
	AvatarRenderer: ({ color, animated, size }: { color: string; animated: boolean; size: number }) =>
		createElement("span", { "data-color": color, "data-animated": String(animated), "data-size": size }),
}));

const face = { ...defaultAvatarFace(), color: "#123456" };

describe("avatar identity UI", () => {
	it("draws every real face from its colour at all five sizes, with accessible status", () => {
		for (const [size, pixels] of [
			["mention", 20],
			["message", 28],
			["row", 40],
			["panel", 64],
			["hero", 96],
		] as const) {
			const html = renderToStaticMarkup(
				createElement(Face, { face, name: "Otto", size, state: "working", paused: true }),
			);
			expect(html).toContain('aria-label="Otto, working, routines paused"');
			expect(html).toContain('data-color="#123456"');
			expect(html).toContain(`data-size="${pixels}"`);
			expect(html).toContain('data-animated="true"');
			expect(html).toContain("opacity-45");
			expect(html).not.toContain("orbit");
		}
	});

	it("waits with a labelled, still face and a quiet dot", () => {
		const html = renderToStaticMarkup(createElement(Face, { face, name: "Otto", state: "waiting" }));
		expect(html).toContain('aria-label="Otto, waiting on you"');
		expect(html).toContain('data-animated="false"');
		expect(html).toContain("ring-paper");
	});

	it("brings working group members forward, preserves colours, and names counted members", () => {
		const html = renderToStaticMarkup(
			createElement(FaceStack, {
				name: "Trip",
				faces: [
					{ id: "a", name: "A", face },
					{ id: "b", name: "B", face },
					{ id: "c", name: "C", face: { ...face, color: "#abcdef" }, state: "working" },
					{ id: "d", name: "D", face, state: "waiting", paused: true },
				],
			}),
		);
		expect(html).toContain('aria-label="Trip: A, B, C, D; C working; waiting on you; D routines paused"');
		expect(html).toContain("+2");
		expect(html.indexOf('data-color="#abcdef"')).toBeLessThan(html.indexOf('data-color="#123456"'));
	});

	it("offers labelled shapes, colours, a custom swatch and motion preview without a confirmation button or JSON", () => {
		const html = renderToStaticMarkup(createElement(AvatarChoices, { initial: face, name: "Otto", onPick: vi.fn() }));
		for (const shape of SHAPES) expect(html).toContain(`aria-label="${shape.name}"`);
		for (const color of COLORS) expect(html).toContain(`aria-label="${color.name}"`);
		expect(html).toContain('aria-label="Custom colour #123456" aria-pressed="true"');
		expect(html).toContain('aria-label="Add a colour"');
		expect(html).toContain('aria-label="Preview state"');
		expect(html).not.toContain("Use face");
		expect(html).not.toContain('"definition"');
	});

	it("keeps a generated shape available when editing its colour rather than replacing it with a gallery face", () => {
		const generated = { ...face, definition: { ...face.definition, name: "A unique accepted shape" } };
		const html = renderToStaticMarkup(
			createElement(AvatarChoices, { initial: generated, name: "Otto", onPick: vi.fn() }),
		);
		expect(html).toContain('aria-label="Current shape" aria-pressed="true"');
		expect(html).not.toContain("A unique accepted shape");
	});

	it("retains custom swatches across gallery picks without duplicating the palette", () => {
		expect(customColors("#123456", ["#123456", "#abcdef", COLORS[0].value])).toEqual(["#123456", "#abcdef"]);
	});
});
