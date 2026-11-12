/**
 * The browser in a chat (web/src/lib/segments/browser.ts): one line while that chat's run uses the browser (or the
 * owner holds it), just before what the newest browser call drew (else last, above the line of work in progress); nothing once the run is done though the browser stays
 * open a while, when it is closed, or when the context has none (another chat holds it).
 */
import { describe, expect, it } from "vitest";
import type { BrowserView, Item } from "../src/server/api.ts";
import { type Live, type Segment, view } from "../web/src/lib/chat.ts";

const IDLE: Live = { busy: false, running: [], thinking: false };
const BUSY: Live = { busy: true, running: [{ call: "c9", doing: "using its browser" }], thinking: false };
const RUNNING: BrowserView = {
	running: true,
	preparing: false,
	chat: 1,
	control: "agent",
	url: "https://example.com/",
	title: "Example",
};

const items: Item[] = [
	{ id: 1, role: "user", text: "book the train" },
	{
		id: 2,
		role: "assistant",
		text: "",
		calls: [{ id: "c1", name: "message_user", args: { text: "On it." } }],
	},
	{ id: 3, role: "tool", call: "c1", name: "message_user", text: "", error: false },
];
const kinds = (segments: Segment[]) => segments.map((s) => s.kind);

describe("the inline browser", () => {
	it("shows preparation during a browser call before a page exists", () => {
		const preparing: BrowserView = { running: false, preparing: true, control: "agent" };
		expect(kinds(view(items, [], BUSY, { browser: preparing }))).toContain("browser");
		expect(kinds(view(items, [], IDLE, { browser: preparing }))).not.toContain("browser");
	});
	it("does not add a second live preview when a message already shows the browser", () => {
		const explicit: Item = {
			id: 4,
			role: "assistant",
			text: "",
			calls: [{ id: "c2", name: "message_user", args: { view: "browser" } }],
		};
		const segments = view([...items, explicit], [], IDLE, { browser: RUNNING });
		expect(kinds(segments)).not.toContain("browser");
		expect(segments.some((segment) => segment.kind === "companion" && segment.view === "browser")).toBe(true);
	});
	it("shows last while the chat's run uses the browser", () => {
		const segments = view(items, [], BUSY, { browser: RUNNING });
		expect(kinds(segments).at(-2)).toBe("browser");
		expect(kinds(segments).filter((kind) => kind === "browser")).toHaveLength(1);
		const line = segments.at(-2) as Extract<Segment, { kind: "browser" }>;
		expect(line.view).toBe(RUNNING);
	});

	it("stands where the browser was last used: what came after (a reply, an approval) stays after it", () => {
		const used: Item[] = [
			...items,
			{
				id: 4,
				role: "assistant",
				text: "",
				calls: [{ id: "c4", name: "browser_navigate", args: { url: "https://example.com/" } }],
			},
			{ id: 5, role: "tool", call: "c4", name: "browser_navigate", text: "ok", error: false },
			{
				id: 6,
				role: "assistant",
				text: "",
				calls: [{ id: "c6", name: "message_user", args: { text: "Found it, booking now." } }],
			},
			{ id: 7, role: "tool", call: "c6", name: "message_user", text: "", error: false },
		];
		const shown = view(used, [], BUSY, { browser: RUNNING });
		const browser = shown.findIndex((segment) => segment.kind === "browser");
		const after = shown.findIndex(
			(segment) => segment.kind === "companion" && segment.text === "Found it, booking now.",
		);
		expect(browser).toBeGreaterThan(-1);
		expect(after).toBeGreaterThan(browser);
		expect(kinds(shown).at(-1)).toBe("working");
	});

	it("stands just before what the newest browser call drew: its approval for the next page follows the card", () => {
		const nav = (id: number, call: string, url: string): Item[] => [
			{ id, role: "assistant", text: "", calls: [{ id: call, name: "browser_navigate", args: { url } }] },
			{ id: id + 1, role: "tool", call, name: "browser_navigate", text: "ok", error: false },
		];
		const said = (id: number, text: string): Item[] => [
			{ id, role: "assistant", text: "", calls: [{ id: `m${id}`, name: "message_user", args: { text } }] },
			{ id: id + 1, role: "tool", call: `m${id}`, name: "message_user", text: "", error: false },
		];
		const shown = view(
			[
				...items,
				...nav(4, "c4", "https://a.example/"),
				...said(6, "Now the second shop."),
				...nav(8, "c8", "https://b.example/"),
			],
			[],
			BUSY,
			{ browser: RUNNING },
		);
		const browser = shown.findIndex((segment) => segment.kind === "browser");
		const before = shown.findIndex(
			(segment) => segment.kind === "companion" && segment.text === "Now the second shop.",
		);
		// the newest browser call's own segments come after the card; what came before it, before
		expect(before).toBeLessThan(browser);
		expect(shown.slice(browser + 1).every((segment) => segment.kind !== "companion")).toBe(true);
	});

	it("stands above the line of work in progress", () => {
		const shown = kinds(view(items, [], BUSY, { browser: RUNNING }));
		expect(shown.slice(-2)).toEqual(["browser", "working"]);
	});

	it("shows nothing once the run is done, though the browser stays open a while; the owner holding it shows it", () => {
		expect(kinds(view(items, [], IDLE, { browser: RUNNING }))).not.toContain("browser");
		expect(kinds(view(items, [], IDLE, { browser: { ...RUNNING, control: "owner" } })).at(-1)).toBe("browser");
	});

	it("shows nothing when the browser is closed, or another chat holds it", () => {
		expect(
			kinds(view(items, [], IDLE, { browser: { running: false, preparing: false, control: "agent" } })),
		).not.toContain("browser");
		expect(kinds(view(items, [], IDLE, {}))).not.toContain("browser");
	});
});

describe("what the browser opened", () => {
	const browsing: Item[] = [
		...items,
		{
			id: 4,
			role: "assistant",
			text: "",
			calls: [
				{ id: "c4", name: "browser_navigate", args: { url: "https://a.example/" } },
				{ id: "c5", name: "browser_navigate", args: { url: "https://b.example/x" } },
			],
		},
		// each went through: a page is browsed once its call did
		{ id: 41, role: "tool", call: "c4", name: "browser_navigate", text: "", error: false },
		{ id: 42, role: "tool", call: "c5", name: "browser_navigate", text: "", error: false },
		{
			id: 5,
			role: "assistant",
			text: "",
			calls: [{ id: "c6", name: "message_user", args: { text: "Found it." } }],
		},
		{ id: 6, role: "tool", call: "c6", name: "message_user", text: "", error: false },
	];

	it("stays as one line per stretch after the browser closed, the newest page first, before what came after", () => {
		const segments = view(browsing, [], IDLE, {});
		const line = segments.find((segment) => segment.kind === "browsed") as Extract<Segment, { kind: "browsed" }>;
		expect(line.pages).toEqual(["https://b.example/x", "https://a.example/"]);
		const at = segments.indexOf(line);
		expect(segments.slice(at + 1).some((segment) => segment.kind === "companion" && segment.text === "Found it.")).toBe(
			true,
		);
	});

	it("gives way to the live line while the stretch is still in use", () => {
		const segments = view(browsing.slice(0, 4), [], BUSY, { browser: RUNNING });
		expect(kinds(segments)).not.toContain("browsed");
		expect(kinds(segments)).toContain("browser");
	});
});
