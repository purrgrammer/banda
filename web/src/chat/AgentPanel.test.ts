/** Changing tab must not move the agent's face, name or tabs: only the open tab's own region scrolls. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { AgentPanel } from "./Panel.tsx";

const panel = (tab: "routines" | "access" | "memory" | "about") =>
	renderToStaticMarkup(
		createElement(AgentPanel, {
			who: { id: "otto", name: "Otto", face: defaultAvatarFace() },
			tab,
			routines: "routines here",
			access: "access here",
			memory: "memory here",
			about: "about here",
		}),
	);

describe("the agent panel's header", () => {
	it.each(["routines", "access", "memory", "about"] as const)("stays out of the %s tab's scrolling region", (tab) => {
		const html = panel(tab);
		const firstRegion = html.indexOf('role="tabpanel"');
		const header = html.slice(0, firstRegion);
		expect(header).toContain("Otto");
		expect(header).toContain('role="tablist"');
		expect(header).not.toContain("overflow-y-auto");
		const regions = [...html.matchAll(/<div[^>]*role="tabpanel"[^>]*>/g)].map((match) => match[0]);
		expect(regions).toHaveLength(4);
		for (const region of regions) expect(region).toContain("overflow-y-auto");
	});
});
