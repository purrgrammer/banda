import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import type { Segment } from "../lib/chat.ts";

// the feed's modules read the page's address as they load; only the drawing is under test here
vi.hoisted(() => {
	Object.assign(globalThis, { location: { hash: "", origin: "http://localhost", href: "http://localhost/" } });
});
const { FeedView } = await import("./Feed.tsx");

const who = { name: "Mara", face: defaultAvatarFace() };
const reply: Segment = { kind: "companion", key: "41", text: "An earlier reply", files: [], undelivered: false };
const working: Segment = { kind: "working", key: "working", text: "working…" };
const render = (segments: readonly Segment[]) =>
	renderToStaticMarkup(createElement(FeedView, { chat: 1, who, compact: true, segments, onWorkingFace: () => {} }));
const faces = (html: string) => html.match(/data-run-face="[a-z]*"/g) ?? [];

// a run's news can reach the page before the owner's words that began it: the reply already there is older work
it("the working face never lands on an earlier reply: it goes alone to the foot, and the reply stays as it was", () => {
	const html = render([reply, working]);
	expect(faces(html)).toEqual(['data-run-face="working"']);
	expect(html.indexOf("An earlier reply")).toBeLessThan(html.indexOf('data-run-face="working"'));
	expect(html).toContain('aria-label="Mara is working"');
});

it("says nothing of the work when nobody is working", () => {
	const html = render([reply]);
	expect(faces(html)).toEqual([]);
	expect(html).not.toContain("is working");
});

it("draws the face with no words beside it", () => {
	const html = render([working]);
	expect(html.replace(/<[^>]*>/g, "").trim()).toBe("");
});
