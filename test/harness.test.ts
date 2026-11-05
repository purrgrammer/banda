import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyUpdate, diffOf, folderPath, type HarnessStep } from "../src/core/harness.ts";

describe("diffOf", () => {
	it("counts the lines between the common start and end", () => {
		const before = "a\nif (x < Date.now()) {\n  go();\n}";
		const after = "a\nconst now = Math.floor(Date.now() / 1000);\nif (x < now) {\n  go();\n}";
		expect(diffOf(before, after)).toEqual({
			added: 2,
			removed: 1,
			diff: "-if (x < Date.now()) {\n+const now = Math.floor(Date.now() / 1000);\n+if (x < now) {",
		});
		expect(diffOf("", "one\ntwo")).toMatchObject({ added: 2, removed: 0 });
	});
});

describe("folderPath", () => {
	it("takes a folder in the home, never the home or the root", () => {
		expect(folderPath("~/sancho")).toBe(join(homedir(), "sancho"));
		expect(folderPath("~")).toBeUndefined();
		expect(folderPath("/")).toBeUndefined();
		expect(folderPath("code/x")).toBeUndefined();
	});
});

describe("applyUpdate", () => {
	it("follows a call from pending to done, and gathers words", () => {
		const steps: HarnessStep[] = [];
		// as claude-agent-acp sends them (spike, 2026-11-05)
		applyUpdate(steps, {
			sessionUpdate: "tool_call",
			toolCallId: "t1",
			title: "Terminal",
			kind: "execute",
			status: "pending",
			rawInput: {},
		});
		applyUpdate(steps, { sessionUpdate: "tool_call_update", toolCallId: "t1", rawInput: { command: "npm test" } });
		applyUpdate(steps, {
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "6 passed" } }],
		});
		applyUpdate(steps, {
			sessionUpdate: "tool_call",
			toolCallId: "t2",
			title: "Write",
			kind: "edit",
			status: "pending",
			rawInput: { file_path: "/w/hello.txt" },
			content: [{ type: "diff", path: "/w/hello.txt", oldText: null, newText: "banda" }],
		});
		applyUpdate(steps, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "do" } });
		applyUpdate(steps, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ne" } });
		expect(steps).toEqual([
			{ kind: "run", command: "npm test", output: "6 passed", running: false, call: "t1" },
			{ kind: "edit", path: "/w/hello.txt", added: 1, removed: 0, diff: "+banda", call: "t2" },
			{ kind: "said", text: "done" },
		]);
	});
});
