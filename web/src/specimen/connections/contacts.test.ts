/**
 * The Google Contacts specimen's words, links and drafts, rendered on the server with no browser, at each width the
 * stage gives. This is the HTML React first draws, before effects, styles or layout: that the section fits its width,
 * and that these words are visible and not merely present, is test/contacts-specimen.browser.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
const { ContactsSection } = await import("./contacts.tsx");
const { StageContext } = await import("../stage.tsx");
const { TooltipProvider } = await import("@/components/ui/tooltip");

function render(width: "desktop" | "phone"): string {
	return renderToStaticMarkup(
		createElement(
			TooltipProvider,
			null,
			createElement(StageContext.Provider, { value: { scheme: "light", width } }, createElement(ContactsSection)),
		),
	);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'", nbsp: " " };
/** The text of some markup, hidden text included: `textContent`, not `innerText`. */
const textOf = (html: string) =>
	html.replace(/<[^>]*>/g, "").replace(/&(#x27|#39|amp|lt|gt|quot|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "");

/** Every element whose opening tag `open` matches, with all it holds. */
function elements(html: string, open: RegExp): string[] {
	const found: string[] = [];
	for (const match of html.matchAll(new RegExp(open.source, "g"))) {
		const name = /^<([a-zA-Z0-9-]+)/.exec(match[0])?.[1] ?? "";
		const rest = html.slice(match.index);
		let depth = 0;
		for (const tag of rest.matchAll(new RegExp(`<${name}\\b[^>]*>|</${name}>`, "g"))) {
			depth += tag[0].startsWith("</") ? -1 : tag[0].endsWith("/>") ? 0 : 1;
			if (depth === 0) {
				found.push(rest.slice(0, tag.index + tag[0].length));
				break;
			}
		}
	}
	return found;
}
/** What an element holds, without its own opening tag: what a descendant selector reaches. */
const inside = (element: string) => element.slice(element.indexOf(">") + 1);

describe("the Google Contacts specimen, as first drawn", () => {
	for (const width of ["phone", "desktop"] as const)
		it(`names, links and drafts its people at ${width} width`, () => {
			const html = render(width);
			const [section] = elements(html, /<section\b[^>]*\sid="contacts"[^>]*>/);
			expect(section, "the section").toBeDefined();
			const text = textOf(section ?? "");
			for (const words of [
				"Ana García",
				"Head of Design · Northstar",
				"From people you've emailed",
				"Open in Google Contacts",
				"Add “Bo Lindqvist” to your contacts",
				"Delete this contact from your contacts",
				"AG",
			])
				expect(text, words).toContain(words);
			const drafts = elements(section ?? "", /<[a-z]+\b[^>]*\saria-label="Contact draft"[^>]*>/);
			expect(drafts.length).toBeGreaterThan(0);
			for (const draft of drafts) expect(inside(draft)).not.toMatch(/<(textarea|input)\b/);
			expect(section).toMatch(/<a\b[^>]*\shref="mailto:ana@northstar\.example"/);
			expect(section).toMatch(/<a\b[^>]*\shref="tel:\+34600123456"/);
			expect(section).toMatch(/\sdata-contact-other=""/);
			const inline = elements(section ?? "", /<[a-z]+\b[^>]*\sdata-object-inline=""[^>]*>/);
			expect(inline.some((element) => /<a\b[^>]*\shref="https:\/\/contacts\.google\.com\//.test(inside(element)))).toBe(
				true,
			);
		});
});
