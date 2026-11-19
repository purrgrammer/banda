import { describe, expect, it } from "vitest";
import { patchLines, permissionOf, V2Updates } from "../src/core/acp-v2.ts";
import { applyUpdate, type HarnessStep } from "../src/core/harness.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** Updates in the order claude-agent-acp 0.100.0's v2 surface sends a backgrounded Bash (`dist/v2/terminal.js`). */
describe("ACP v2 updates as steps", () => {
	it("a command's terminal output reaches its call, before and after the call names the terminal", () => {
		const v2 = new V2Updates();
		const steps: HarnessStep[] = [];
		const take = (update: { sessionUpdate: string; [field: string]: unknown }) => {
			for (const one of v2.take(update)) applyUpdate(steps, one);
		};
		// the terminal first (named after its call), then the report that names it in its content
		take({ sessionUpdate: "terminal_update", terminalId: "bash-1", command: "npm test" });
		take({
			sessionUpdate: "tool_call_update",
			toolCallId: "bash-1",
			kind: "execute",
			title: "npm test",
			status: "in_progress",
			rawInput: { command: "npm test" },
			content: [{ type: "terminal", terminalId: "bash-1" }],
		});
		take({ sessionUpdate: "terminal_output_chunk", terminalId: "bash-1", data: b64("1 passing\n") });
		take({ sessionUpdate: "terminal_output_chunk", terminalId: "bash-1", data: b64("2 passing\n") });
		expect(steps).toEqual([
			{ kind: "run", command: "npm test", output: "1 passing\n2 passing\n", running: true, call: "bash-1" },
		]);
		take({ sessionUpdate: "terminal_update", terminalId: "bash-1", exitStatus: { exitCode: 0 } });
		take({ sessionUpdate: "tool_call_update", toolCallId: "bash-1", status: "completed" });
		expect(steps[0]).toMatchObject({ kind: "run", running: false, output: "1 passing\n2 passing\n" });
	});

	it("a v2 diff counts its patch's lines, and one with no patch says no made-up zero", () => {
		const v2 = new V2Updates();
		const steps: HarnessStep[] = [];
		const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n same";
		for (const one of v2.take({
			sessionUpdate: "tool_call_update",
			toolCallId: "e1",
			kind: "edit",
			title: "Edit /p/x.ts",
			status: "completed",
			content: [
				{
					type: "diff",
					changes: [{ operation: "modify", path: "/p/x.ts" }],
					patch: { format: "git_patch", text: patch },
				},
			],
		}))
			applyUpdate(steps, one);
		for (const one of v2.take({
			sessionUpdate: "tool_call_update",
			toolCallId: "e2",
			kind: "edit",
			status: "completed",
			content: [{ type: "diff", changes: [{ operation: "add", path: "/p/empty.ts" }] }],
		}))
			applyUpdate(steps, one);
		expect(steps[0]).toEqual({
			kind: "edit",
			path: "/p/x.ts",
			added: 2,
			removed: 1,
			diff: "-old\n+new\n+more",
			call: "e1",
		});
		expect(steps[1]).toEqual({ kind: "edit", path: "/p/empty.ts", call: "e2" });
		expect(patchLines(patch)).toEqual({ added: 2, removed: 1, diff: "-old\n+new\n+more" });
	});

	it("a plan is kept as v1's; state, user messages and what v2 adds are no steps", () => {
		const v2 = new V2Updates();
		expect(
			v2.take({ sessionUpdate: "plan_update", plan: { type: "items", planId: "plan", entries: [{ content: "a" }] } }),
		).toEqual([{ sessionUpdate: "plan", entries: [{ content: "a" }] }]);
		for (const sessionUpdate of [
			"state_update",
			"user_message",
			"agent_message",
			"config_option_update",
			"plan_removed",
			"_x",
		])
			expect(v2.take({ sessionUpdate })).toEqual([]);
		const chunk = { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "hi" } };
		expect(v2.take(chunk)).toEqual([chunk]);
	});
});

describe("an ACP v2 permission request", () => {
	it("reads as v1's: its subject's tool call, titled by the request when the call has none", () => {
		const request = permissionOf(
			{
				sessionId: "s",
				title: "Run npm test",
				subject: {
					type: "tool_call",
					toolCall: { toolCallId: "c1", kind: "execute", rawInput: { command: "npm test" } },
				},
				options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
			},
			"permission-7",
		);
		expect(request).toEqual({
			sessionId: "s",
			toolCall: { toolCallId: "c1", kind: "execute", rawInput: { command: "npm test" }, title: "Run npm test" },
			options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
		});
	});

	it("one with no tool call is still an ask, by the request's own id; a v1 request is left as it is", () => {
		expect(permissionOf({ sessionId: "s", title: "Open a page", options: [] }, "permission-9").toolCall).toEqual({
			toolCallId: "permission-9",
			title: "Open a page",
		});
		const v1 = { sessionId: "s", toolCall: { toolCallId: "x" }, options: [] };
		expect(permissionOf(v1, "p")).toBe(v1);
	});

	it("a command subject is the command it would run; one it cannot show is unreviewable; none shows its words", () => {
		expect(
			permissionOf(
				{ sessionId: "s", title: "Run", subject: { type: "command", command: "rm -rf build", cwd: "/w" }, options: [] },
				"p1",
			).toolCall,
		).toEqual({ toolCallId: "p1", kind: "execute", rawInput: { command: "rm -rf build", cwd: "/w" }, title: "Run" });
		expect(
			permissionOf({ sessionId: "s", title: "Do it", subject: { type: "_secret", what: "x" }, options: [] }, "p2")
				.toolCall,
		).toMatchObject({ unreviewable: true, title: "Do it" });
		expect(
			permissionOf({ sessionId: "s", title: "Open", description: "https://example.com", options: [] }, "p3").toolCall,
		).toEqual({
			toolCallId: "p3",
			title: "Open",
			content: [{ type: "content", content: { type: "text", text: "https://example.com" } }],
		});
	});

	it("its diff carries the patch's lines, so the ask shows the change whole", () => {
		const request = permissionOf(
			{
				sessionId: "s",
				title: "Edit",
				subject: {
					type: "tool_call",
					toolCall: {
						toolCallId: "c",
						kind: "edit",
						content: [{ type: "diff", changes: [{ operation: "modify", path: "/p/a" }], patch: { text: "-a\n+b" } }],
					},
				},
				options: [],
			},
			"p",
		);
		expect((request.toolCall as { content?: unknown }).content).toEqual([
			{
				type: "diff",
				path: "/p/a",
				changes: [{ operation: "modify", path: "/p/a" }],
				lines: { added: 1, removed: 1, diff: "-a\n+b" },
			},
		]);
	});
});
