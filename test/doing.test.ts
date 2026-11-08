import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { approvalLabel, doing, namesTool, TOOL_NAMES } from "../src/server/doing.ts";
import { pbtRuns } from "./pbt.ts";

describe("doing", () => {
	it("says what each tool is doing in plain words", () => {
		expect(doing("bash", { command: "rm -rf /tmp/x" })).toBe("running a command");
		expect(doing("read", { path: "/workspace/x/notes.md" })).toBe("reading notes.md");
		expect(doing("read", { path: "README.md" })).toBe("reading README.md");
		expect(doing("write", { path: "/workspace/draft.txt", content: "…" })).toBe("writing draft.txt");
		expect(doing("edit", { path: "C:\\work\\plan.md" })).toBe("writing plan.md");
		expect(doing("message_user", { text: "hi" })).toBeUndefined();
		expect(doing("message_group", { text: "hi" })).toBeUndefined();
		expect(doing("mcp_thing", { x: 1 })).toBe("working");
	});

	it("an approval names what it would run in words", () => {
		expect(approvalLabel("bash", { command: "ls" })).toBe("running a command");
		expect(approvalLabel("send_email", { to: "a@b" })).toBe("send email");
		expect(approvalLabel("postToChannel", {})).toBe("post to channel");
	});

	it("never shows what it cannot say plainly", () => {
		expect(doing("read", {})).toBe("reading a file");
		expect(doing("read", { path: "/workspace/" })).toBe("reading a file");
		expect(doing("read", { path: 42 })).toBe("reading a file");
		expect(doing("write", { path: "/x/notes.bash" })).toBe("writing a file");
		expect(doing("read", { path: `/x/${"a".repeat(100)}` })).toMatch(/^reading a{59}…$/);
		expect(doing("read", undefined)).toBe("reading a file");
	});

	it("property: a label never holds a slash or a tool's name, and an unknown tool is working", () => {
		const path = fc.array(fc.oneof(fc.string(), fc.constantFrom(...TOOL_NAMES), fc.constant("/")), { maxLength: 8 });
		fc.assert(
			fc.property(
				fc.constantFrom(...TOOL_NAMES, "other", "mcp_search"),
				path.map((parts) => parts.join("")),
				fc.string(),
				(tool, p, agent) => {
					const label = doing(tool, { path: p, agent, command: p });
					if (tool === "message_user" || tool === "message_group" || tool === "ask_user") {
						expect(label).toBeUndefined();
						return;
					}
					expect(label).toBeDefined();
					expect(label).not.toContain("/");
					expect(label).not.toContain("\\");
					expect(namesTool(label ?? ""), `${tool}: ${label}`).toBe(false);
					if (tool === "other" || tool === "mcp_search") expect(label).toBe("working");
				},
			),
			{ numRuns: pbtRuns(300) },
		);
	});
});
