/** The sidebar's thinking selector shows the tier the store holds, and offers a pick only when a pick can take effect. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Tier } from "../../../src/core/tiers.ts";
import { ThinkingTiers } from "./Settings.tsx";

const render = (tier: Tier | undefined, custom = false) =>
	renderToStaticMarkup(createElement(ThinkingTiers, { tier, custom, onPick: async () => {} }));

const checked = (html: string) =>
	[...html.matchAll(/<button[^>]*aria-checked="true"[^>]*>([^<]*)</g)].map((match) => match[1]);
const disabled = (html: string) => [...html.matchAll(/<button[^>]*\sdisabled=""/g)].length;

describe("the thinking selector", () => {
	it.each([
		["quick", "Quick"],
		["balanced", "Balanced"],
		["deep", "Deep"],
	] as const)("shows %s as the store holds it, and lets the owner change it", (tier, name) => {
		const html = render(tier);
		expect(checked(html)).toEqual([name]);
		expect(disabled(html)).toBe(0);
	});

	it("claims no tier and offers no pick before the chat has one", () => {
		const html = render(undefined);
		expect(checked(html)).toEqual([]);
		expect(disabled(html)).toBe(3);
	});

	it("offers no pick when the agent's file names its own model, which no tier changes", () => {
		const html = render("balanced", true);
		expect(checked(html)).toEqual(["Balanced"]);
		expect(disabled(html)).toBe(3);
		expect(html).toContain("names its own model");
	});
});
