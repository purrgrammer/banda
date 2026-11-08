/**
 * The speaking tools (DESIGN.md "Messages"): one per act, each read back as one message's parts, offered to every chat
 * whatever its file lists, the face alone kept out of a group; and in a group's room, a question takes options alone.
 */
import { describe, expect, it } from "vitest";
import { chatTools } from "../src/core/agents.ts";
import { askUserTool, type Speaking } from "../src/core/ask.ts";
import { context } from "../src/core/store.ts";
import { isMessageTool, isOwnerMessage, messageArgs, OWNER_ACTS } from "../src/core/toolsets.ts";
import { blobStore } from "./helpers.ts";

const nothing = new Proxy(
	{},
	{
		get() {
			throw new Error("refused before anything is touched");
		},
	},
);

describe("speaking tools", () => {
	it("read back as one message's parts, whichever tool made the call", () => {
		expect(messageArgs("publish", { path: "plan.md", title: "Plan" })).toEqual({
			artifact: { path: "plan.md", title: "Plan", change: undefined },
		});
		expect(messageArgs("connect", { connection: "github", reason: "to read the issue" })).toEqual({
			connect: "github",
			text: "to read the issue",
		});
		expect(messageArgs("propose_avatar", { version: 1 })).toEqual({ avatar: { version: 1 } });
		expect(messageArgs("react", { reaction: "👍" })).toEqual({ reaction: "👍" });
		expect(messageArgs("ask_user", { question: "Which?" })).toEqual({ question: "Which?" });
	});

	it("are messages; message_group alone speaks in a room, not the agent's own chat", () => {
		for (const name of ["message_user", "message_group", ...OWNER_ACTS]) expect(isMessageTool(name)).toBe(true);
		expect(isMessageTool("bash")).toBe(false);
		expect(isOwnerMessage("message_group")).toBe(false);
		expect(isOwnerMessage("ask_user")).toBe(true);
	});

	it("come with every chat; a group's has no face to propose and no message_user", () => {
		const direct = chatTools({ id: "mira", tools: [] }, undefined, [], false) ?? [];
		const group = chatTools({ id: "mira", tools: [] }, undefined, [], true) ?? [];
		expect(direct).toEqual(expect.arrayContaining(["message_user", ...OWNER_ACTS]));
		expect(group).toEqual(expect.arrayContaining(["message_group", "ask_user", "react", "publish", "connect"]));
		expect(group).not.toContain("propose_avatar");
		expect(group).not.toContain("message_user");
	});

	it("in a group, a question takes options alone, refused before anything is sent or asked", async () => {
		const speaking = {
			asking: nothing,
			sending: nothing,
			blobs: blobStore(),
			limit: 1000,
			venue: async () => "group",
		} as unknown as Speaking;
		const tool = askUserTool(speaking);
		for (const extra of [{ fields: [{ name: "size" }] }, { multiple: true, options: ["a", "b"] }, { minutes: 5 }]) {
			const result = await tool.execute({ question: "Which?", ...extra } as never, nothing as never, context);
			expect(result).toMatchObject({
				isError: true,
				output: [{ type: "text", text: "Not sent: in a group, a question takes options alone." }],
			});
		}
	});
});
