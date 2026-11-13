import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { Header } from "./Header.tsx";

const text = (html: string) => html.replace(/<[^>]*>/g, " ");

// work is said by the feed's working line: the header neither says it nor moves for it
it("a chat's header shows no working state, in words or in its face", () => {
	const html = renderToStaticMarkup(
		createElement(Header, {
			name: "Mara",
			face: defaultAvatarFace(),
			state: "working",
			doing: "Using its browser…",
			onActivity: () => {},
		}),
	);
	expect(text(html)).not.toMatch(/Working|working|Using its browser/);
	expect(html).toMatch(/<h1[^>]*>Mara<\/h1>/);
	expect(html).toContain('role="img" aria-label="Mara" data-state="idle"');
});

it("a group's header shows no working state either", () => {
	const html = renderToStaticMarkup(
		createElement(Header, {
			name: "Trip",
			state: "working",
			doing: "Mara and Sancho are working…",
			onActivity: () => {},
		}),
	);
	expect(text(html)).not.toMatch(/working/i);
	expect(html).toMatch(/<h1[^>]*>Trip<\/h1>/);
	expect(html).toContain("lucide-users");
});

it("still says what is not work: waiting on the owner, routines paused", () => {
	const waiting = renderToStaticMarkup(createElement(Header, { name: "Mara", state: "waiting" }));
	expect(text(waiting)).toContain("Waiting on you");
	const paused = renderToStaticMarkup(createElement(Header, { name: "Mara", state: "working", paused: true }));
	expect(text(paused)).toContain("Routines paused");
});
