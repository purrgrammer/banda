import {
	BookOpenIcon,
	CalendarClockIcon,
	FileTextIcon,
	GlobeIcon,
	MessageCircleIcon,
	TerminalIcon,
	WrenchIcon,
} from "lucide-react";
import { describe, expect, it } from "vitest";
import { shortPreview, toolIcon, toolPreview, toolPreviewEnds } from "./tool-presentation.tsx";

describe("tool identity and literal previews", () => {
	it("distinguishes tools, with a generic icon for unknown tools", () => {
		expect(toolIcon("web_fetch")).toBe(GlobeIcon);
		expect(toolIcon("bash")).toBe(TerminalIcon);
		expect(toolIcon("read")).toBe(FileTextIcon);
		expect(toolIcon("message_user")).toBe(MessageCircleIcon);
		expect(toolIcon("schedule")).toBe(CalendarClockIcon);
		expect(toolIcon("skill")).toBe(BookOpenIcon);
		expect(toolIcon("new_tool")).toBe(WrenchIcon);
		expect(toolIcon("constructor")).toBe(WrenchIcon);
	});
	it("uses each tool's subject rather than dumping its arguments", () => {
		expect(toolPreview("web_fetch", { url: "https://example.test/events" })).toBe("https://example.test/events");
		expect(toolPreview("bash", { command: "python3 - <<'PY'\nprint(1)\nPY" })).toBe("python3 - <<'PY' print(1) PY");
		expect(toolPreview("read", { path: "/workspace/notes.md", offset: 20 })).toBe("/workspace/notes.md · from line 20");
		expect(toolPreview("write", { path: "report.md", content: "long report" })).toBe("report.md");
		expect(toolPreview("message_user", { text: "Found three shows." })).toBe("Found three shows.");
		expect(toolPreview("remember", { fact: "Likes flamenco.", scope: "agent" })).toBe("Likes flamenco.");
		expect(toolPreview("schedule", { name: "weekly-events", description: "Events nearby" })).toBe(
			"weekly-events · Events nearby",
		);
		expect(toolPreview("skill", { name: "research" })).toBe("research");
		expect(toolPreview("browser_select", { ref: "r7", values: ["adult"] })).toBe("r7 · adult");
	});
	it("keeps previews short without changing the full recorded arguments", () => {
		const args = { text: "long message\n".repeat(100) };
		const original = args.text;
		expect(toolPreview("message_user", args)?.length).toBe(180);
		expect(args.text).toBe(original);
		expect(shortPreview(" one\n two \t three ")).toBe("one two three");
	});
	it("splits a command before its last step, a path before its file name, and keeps a trailing submit", () => {
		const chain = `npm ci && npm run build && npm test -- ${"--flag ".repeat(30)}&& git push origin main`;
		const command = toolPreviewEnds("bash", { command: chain });
		// the end that must show, whole, whatever the width: the head gives way on screen (KeepEnd), not here
		expect(command?.end).toBe("&& git push origin main");
		expect(command?.head.startsWith("npm ci && npm run build")).toBe(true);
		expect((command?.head ?? "").length + (command?.end ?? "").length).toBeLessThanOrEqual(180);
		expect(toolPreviewEnds("edit", { path: `/workspace/${"nested/".repeat(40)}Settled.tsx` })).toMatchObject({
			end: "Settled.tsx",
		});
		expect(toolPreviewEnds("edit", { path: `/workspace/${"nested/".repeat(40)}Settled.tsx` })?.head).toContain("…");
		const typed = toolPreviewEnds("browser_type", { ref: "e4", text: "word ".repeat(60), submit: true });
		expect(typed?.end).toBe(" · submit");
		// the string form is the same text, joined
		expect(toolPreview("browser_type", { ref: "e4", text: "word ".repeat(60), submit: true })).toBe(
			`${typed?.head}${typed?.end}`,
		);
		// short enough to show whole: unchanged; a call with nothing to keep keeps nothing
		expect(toolPreview("bash", { command: "npm test && git push" })).toBe("npm test && git push");
		expect(toolPreviewEnds("message_user", { text: "hello" })).toEqual({ head: "hello", end: "" });
	});
	it("does not put credentials or unknown arguments in a collapsed preview", () => {
		expect(toolPreview("propose_key", { key: "private", connection: "GitHub", host: "api.github.com" })).toBe(
			"GitHub · api.github.com",
		);
		expect(toolPreview("unknown", { token: "private" })).toBeUndefined();
		expect(toolPreview("bash", {})).toBeUndefined();
	});
});
