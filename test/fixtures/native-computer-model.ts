import assert from "node:assert/strict";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type Message,
} from "@earendil-works/pi-ai";

export function nativeComputerReply(messages: readonly Message[], command: string): AssistantMessage {
	const previous = messages.at(-1);
	if (previous?.role === "toolResult" && previous.toolName === "message_user") return fauxAssistantMessage("Done.");
	if (previous?.role === "toolResult" && previous.toolName !== "tool_search") {
		assert.ok(!previous.isError, JSON.stringify(previous.content));
		return fauxAssistantMessage([fauxToolCall("message_user", { text: JSON.stringify(previous.content) })], {
			stopReason: "toolUse",
		});
	}
	const input = messages.filter((message) => message.role === "user").at(-1)?.content;
	if (input !== "Check the computer." && input !== "Browse the example page.")
		return fauxAssistantMessage([fauxToolCall("message_user", { text: "Noted the test follow-up." })], {
			stopReason: "toolUse",
		});
	const browse = input === "Browse the example page.";
	const tool = browse ? "browser_navigate" : "bash";
	const next = getCurrentTools(messages).some((offered) => offered.name === tool)
		? fauxToolCall(tool, browse ? { url: "https://example.com/" } : { command })
		: fauxToolCall("tool_search", { query: tool, limit: 1 });
	return fauxAssistantMessage([next], { stopReason: "toolUse" });
}
