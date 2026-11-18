import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { nativeComputerReply } from "./fixtures/native-computer-model.ts";

const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const commands = {
	check: "printf initial-command",
	persistence: {
		command: "cat /workspace/native-proof",
		output: "workspace-retained\nwork-retained\ntool-retained",
	},
};
const available: Message = {
	role: "system",
	content: "",
	toolsAdded: [{ name: "bash", description: "Run a command.", parameters: Type.Object({ command: Type.String() }) }],
	timestamp: 0,
};
const denied =
	'<held-request-result>\n[{"ended":"The request did not run: the owner denied it."}]\n</held-request-result>';

it("does not repeat an earlier command when its denied held request is reported", () => {
	const reply = nativeComputerReply([user("Check the computer."), user(denied)], commands);
	expect(reply.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "message_user" }));
	expect(reply.content).not.toContainEqual(expect.objectContaining({ type: "toolCall", name: "bash" }));
	expect(reply.content).not.toContainEqual(expect.objectContaining({ type: "toolCall", name: "tool_search" }));
});

for (const [input, query] of [
	["Check the computer.", "bash"],
	["Read the files after restart.", "bash"],
	["Browse the example page.", "browser_navigate"],
]) {
	it(`discovers the tool for the explicit owner fixture command ${input}`, () => {
		const reply = nativeComputerReply([user(input)], commands);
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
	const reply = nativeComputerReply([user("Browse the example page."), user("A scheduled follow-up.")], commands);
	expect(reply.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "message_user" }));
	expect(reply.content).not.toContainEqual(expect.objectContaining({ type: "toolCall", name: "browser_navigate" }));
});

it("runs only the read-only command after restart even when the earlier setup is in history", () => {
	const reply = nativeComputerReply(
		[available, user("Check the computer."), user("Read the files after restart.")],
		commands,
	);
	expect(reply.content).toEqual([
		expect.objectContaining({ type: "toolCall", name: "bash", arguments: { command: commands.persistence.command } }),
	]);
});

it("keeps the initial computer check distinct from the read-only restart check", () => {
	const reply = nativeComputerReply([available, user("Check the computer.")], commands);
	expect(reply.content).toEqual([
		expect.objectContaining({ type: "toolCall", name: "bash", arguments: { command: commands.check } }),
	]);
});

it("reports the actual restart command output", () => {
	const content: Extract<Message, { role: "toolResult" }>["content"] = [
		{ type: "text", text: "workspace-retained\nwork-retained\ntool-retained" },
	];
	const reply = nativeComputerReply(
		[
			available,
			user("Read the files after restart."),
			{ role: "toolResult", toolName: "bash", toolCallId: "restart", content, isError: false, timestamp: 2 },
		],
		commands,
	);
	expect(reply.content).toEqual([
		expect.objectContaining({ type: "toolCall", name: "message_user", arguments: { text: JSON.stringify(content) } }),
	]);
});

it("fails instead of claiming persistence when the restart command fails", () => {
	expect(() =>
		nativeComputerReply(
			[
				available,
				user("Read the files after restart."),
				{
					role: "toolResult",
					toolName: "bash",
					toolCallId: "restart",
					content: [{ type: "text", text: "cat: /workspace/native-proof: No such file" }],
					isError: true,
					timestamp: 2,
				},
			],
			commands,
		),
	).toThrow("No such file");
});

for (const output of ["native-persistence-verified", "workspace-retained\nwork-corrupted\ntool-retained"]) {
	it(`rejects incomplete or corrupted marker output even when bash reports success: ${output}`, () => {
		expect(() =>
			nativeComputerReply(
				[
					available,
					user("Read the files after restart."),
					{
						role: "toolResult",
						toolName: "bash",
						toolCallId: "restart",
						content: [{ type: "text", text: output }],
						isError: false,
						timestamp: 2,
					},
				],
				commands,
			),
		).toThrow();
	});
}
