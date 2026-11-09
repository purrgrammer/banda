import { getExample } from "open-bot-avatar";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { AvatarCandidateCard } from "./CandidateCard.tsx";

const controls = vi.hoisted(() => ({
	use: undefined as (() => void) | undefined,
}));
vi.mock("@/components/ui/button", () => ({
	Button: ({ onClick, children }: { onClick: () => void; children: string }) => {
		controls.use = onClick;
		return createElement("button", { type: "button" }, children);
	},
}));
vi.mock("./Renderer.tsx", () => ({
	AvatarRenderer: ({ size }: { size: number }) => createElement("span", { "data-preview-size": size }),
}));

beforeEach(() => {
	controls.use = undefined;
});

describe("generated face preview card", () => {
	it("shows readable previews, never geometry text, and writes only on explicit acceptance", async () => {
		const definition = getExample("mug");
		if (!definition) throw new Error("missing mug fixture");
		const current = { ...defaultAvatarFace(), color: "#123456" };
		const onUse = vi.fn(async () => {});
		const html = renderToStaticMarkup(createElement(AvatarCandidateCard, { definition, current, name: "Mira", onUse }));
		expect(html).toContain("Face preview for Mira");
		expect(html).toContain("Use this face");
		expect(html).toContain('data-preview-size="128"');
		for (const field of ["body", "path", "eyes", "spacing", "version"]) expect(html).not.toContain(`"${field}"`);
		expect(html).not.toContain(definition.body.path);
		expect(onUse).not.toHaveBeenCalled();
		controls.use?.();
		controls.use?.(); // a rapid double click cannot race two saves
		expect(onUse).toHaveBeenCalledExactlyOnceWith({ definition, color: current.color });
		await Promise.resolve();
	});

	it("recognises a currently accepted face without offering a redundant write", () => {
		const current = defaultAvatarFace();
		const onUse = vi.fn(async () => {});
		const html = renderToStaticMarkup(
			createElement(AvatarCandidateCard, { definition: current.definition, current, name: "Mira", onUse }),
		);
		expect(html).toContain(`${current.definition.name}, face preview`);
		expect(html).not.toContain("Use this face");
		expect(html).not.toContain("Nothing changes");
		expect(controls.use).toBeUndefined();
		expect(onUse).not.toHaveBeenCalled();
	});
});
