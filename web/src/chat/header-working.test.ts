import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { Header } from "./Header.tsx";

// the header names its shape's filter with CSS.escape, which the page has and Node does not
vi.stubGlobal("CSS", { escape: (value: string) => value });

const MARA = { name: "Mara", face: defaultAvatarFace() };
const SANCHO = { name: "Sancho", face: defaultAvatarFace() };
const text = (html: string) => html.replace(/<[^>]*>/g, " ");

// work is said by the feed's working line: the header neither says it nor moves for it
it("a chat's header shows no working state, in words or in its face", () => {
	const html = renderToStaticMarkup(
		createElement(Header, {
			name: "Mara",
			faces: [MARA],
			state: "working",
			doing: "Using its browser…",
			onActivity: () => {},
		}),
	);
	expect(text(html)).not.toMatch(/Working|working|Using its browser/);
	expect(html).not.toContain('data-state="working"');
	expect(html).toContain('data-state="idle"');
});

it("a group's header shows no working state either", () => {
	const html = renderToStaticMarkup(
		createElement(Header, {
			name: "Trip",
			faces: [
				{ ...MARA, state: "working" },
				{ ...SANCHO, state: "working" },
			],
			state: "working",
			doing: "Mara and Sancho are working…",
			onActivity: () => {},
		}),
	);
	expect(text(html)).not.toMatch(/working/i);
	expect(html).not.toMatch(/aria-label="[^"]*working/);
});

it("still says what is not work: waiting on the owner, routines paused", () => {
	const waiting = renderToStaticMarkup(createElement(Header, { name: "Mara", faces: [MARA], state: "waiting" }));
	expect(text(waiting)).toContain("Waiting on you");
	const paused = renderToStaticMarkup(
		createElement(Header, { name: "Mara", faces: [MARA], state: "working", paused: true }),
	);
	expect(text(paused)).toContain("Routines paused");
});
