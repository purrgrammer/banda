import type { Message } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { nativeComputerReply } from "./fixtures/native-computer-model.ts";

const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const denied =
	'<held-request-result>\n[{"ended":"The request did not run: the owner denied it."}]\n</held-request-result>';

it("does not repeat an earlier command when its denied held request is reported", () => {
	const reply = nativeComputerReply([user("Check the computer."), user(denied)], "exit 1");
	expect(reply.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "message_user" }));
	expect(reply.content).not.toContainEqual(expect.objectContaining({ type: "toolCall", name: "bash" }));
	expect(reply.content).not.toContainEqual(expect.objectContaining({ type: "toolCall", name: "tool_search" }));
});

for (const [input, query] of [
	["Check the computer.", "bash"],
	["Browse the example page.", "browser_navigate"],
]) {
	it(`discovers the tool for the explicit owner fixture command ${input}`, () => {
		const reply = nativeComputerReply([user(input)], "echo verified");
		expect(reply.content).toContainEqual(
			expect.objectContaining({
				type: "toolCall",
				name: "tool_search",
				arguments: { query, limit: 1 },
			}),
		);
	});
}

it("reports an unknown follow-up without selecting privileged fixture work", () => {
	const reply = nativeComputerReply([user("Browse the example page."), user("A scheduled follow-up.")], "exit 1");
	expect(reply.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "message_user" }));
	expect(reply.content).not.toContainEqual(expect.objectContaining({ type: "toolCall", name: "browser_navigate" }));
});
