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
const asked: Segment = { kind: "owner", key: "40", text: "Find me a train", files: [] };
const reply: Segment = { kind: "companion", key: "41", text: "The 09:00 is direct", files: [], undelivered: false };
const working: Segment = { kind: "working", key: "working", text: "working…" };
const render = (segments: readonly Segment[], outgoing: Parameters<typeof FeedView>[0]["outgoing"] = []) =>
	renderToStaticMarkup(
		createElement(FeedView, { chat: 1, who, compact: true, segments, outgoing, onWorkingLine: () => {} }),
	);
const line = (html: string) => html.includes("data-working-line");

it("while the agent works and has shown nothing, its face and Working… stand at the foot, named for who works", () => {
	const html = render([asked, working]);
	expect(line(html)).toBe(true);
	expect(html).toContain('aria-label="Mara is working"');
	expect(html).toContain("Working…");
	expect(html.indexOf("Find me a train")).toBeLessThan(html.indexOf("data-working-line"));
});

it("goes at the agent's first content, though its turn is still running", () => {
	expect(line(render([asked, reply, working]))).toBe(false);
	// anything it shows counts, not only words: a line in the feed too
	const effect: Segment = {
		kind: "effect",
		key: "41:effect",
		label: "Read your calendar",
		permission: { scope: "always" },
	};
	expect(line(render([asked, effect, working]))).toBe(false);
});

it("comes back when a new turn begins: the owner's words, or a routine's wake", () => {
	const again: Segment = { kind: "owner", key: "42", text: "And back on Sunday?", files: [] };
	expect(line(render([asked, reply, again, working]))).toBe(true);
	const wake: Segment = { kind: "wake", key: "43", text: "Trains ran", routine: "trains" };
	expect(line(render([asked, reply, wake, working]))).toBe(true);
	expect(line(render([wake, reply, working]))).toBe(false);
});

it("stays below the owner's message both while sending and once queued", () => {
	const waiting: Segment = { kind: "owner", key: "queued:q1", text: "Before noon", files: [], queued: true };
	const sending = { id: "q1", text: waiting.text, files: [], state: "sending" } as const;
	for (const html of [render([asked, working], [sending]), render([asked, working, waiting])]) {
		expect(html).toContain(waiting.text);
		expect(html.indexOf("data-working-line")).toBeGreaterThan(html.indexOf(waiting.text));
	}
});

it("says nothing of the work when nobody is working", () => {
	const html = render([asked, reply]);
	expect(line(html)).toBe(false);
	expect(html).not.toContain("is working");
});

// a direct chat's reply never had a face: the line's face does not stay on it, before or after a reload
it("puts no face on a reply in a direct chat", () => {
	const faces = (html: string) => (html.match(/role="img"/g) ?? []).length;
	expect(faces(render([asked, working]))).toBe(1);
	expect(faces(render([asked, reply]))).toBe(0);
	expect(faces(render([asked, reply, working]))).toBe(0);
});
