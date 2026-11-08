/**
 * The registry is the specimen's one index: every section the page renders is in it, in the page's order, at the width
 * it says; its ids are unique and its sources exist. Rendered on the server, with no browser, at each width.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GROUPS, type GroupId, SECTIONS, sectionsOf } from "./registry.ts";

// the app's modules read the page they run in as they load: a bare one stands in, so they load here
const storage = () => {
	const kept = new Map<string, string>();
	return {
		getItem: (key: string) => kept.get(key) ?? null,
		setItem: (key: string, value: string) => void kept.set(key, value),
		removeItem: (key: string) => void kept.delete(key),
	};
};
Object.assign(globalThis, {
	location: new URL("http://127.0.0.1/#/specimen"),
	localStorage: storage(),
	sessionStorage: storage(),
	history: { replaceState() {}, pushState() {} },
	addEventListener() {},
	CSS: { escape: (text: string) => text, supports: () => false },
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	removeEventListener() {},
});
const { CONTENTS } = await import("./contents.tsx");
const { StageContext } = await import("./stage.tsx");
const { TooltipProvider } = await import("@/components/ui/tooltip");
type Width = (typeof SECTIONS)[number]["only"] & string;

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The ids of the sections a group's components render, in document order, at a width. */
function rendered(group: GroupId, width: Width): string[] {
	const html = renderToStaticMarkup(
		createElement(
			TooltipProvider,
			null,
			createElement(
				StageContext.Provider,
				{ value: { scheme: "light", width } },
				...CONTENTS[group].map(([name, Block]) => createElement(Block, { key: name })),
			),
		),
	);
	return [...html.matchAll(/<section id="([a-z0-9-]+)"/g)].map((match) => match[1] ?? "");
}

describe("the specimen's registry", () => {
	it("has unique ids and groups the page knows", () => {
		const ids = SECTIONS.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		const groups = new Set(GROUPS.map((group) => group.id));
		for (const entry of SECTIONS) expect(groups.has(entry.group), entry.id).toBe(true);
		expect(Object.keys(CONTENTS).sort()).toEqual([...groups].sort());
	});

	it("names sources that exist", () => {
		for (const entry of SECTIONS)
			for (const source of entry.sources) expect(existsSync(`${ROOT}${source}`), `${entry.id}: ${source}`).toBe(true);
	});

	for (const width of ["desktop", "phone"] as const)
		for (const group of GROUPS)
			it(`renders the ${group.title} sections it lists, in its order, at ${width} width`, () => {
				const expected = sectionsOf(group.id)
					.filter((entry) => entry.only === undefined || entry.only === width)
					.map((entry) => entry.id);
				expect(rendered(group.id, width)).toEqual(expected);
			});
});
