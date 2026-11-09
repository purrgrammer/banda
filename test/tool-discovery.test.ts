import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { chatTools } from "../src/core/agents.ts";
import { context } from "../src/core/store.ts";
import { discoveryFixture } from "./fixtures/tool-discovery.ts";
import { tempHome } from "./helpers.ts";

it("uses pi search, preserves loaded tools after reopen, and filters revoked authority", async () => {
	const home = await tempHome();
	let fixture = await discoveryFixture(home);
	try {
		const first = await fixture.run();
		expect(first.state?.modelTools).toEqual({ add: ["lookup"] });
		expect(getCurrentTools(first.messages).map((tool) => tool.name)).toContain("lookup");
		expect(JSON.stringify(first.messages)).not.toContain("SECRET UNAVAILABLE DESCRIPTION");
		expect(
			first.messages.filter((message) => message.role === "toolResult" && message.toolName === "tool_search"),
		).toHaveLength(1);
		await fixture.harness.close(context);
		fixture = await discoveryFixture(home);
		const second = await fixture.run("again");
		expect(second.state?.modelTools).toEqual({ add: ["lookup"] });
		expect(
			second.messages.filter((message) => message.role === "toolResult" && message.toolName === "tool_search"),
		).toHaveLength(1);
		await fixture.setAllowed(false);
		const revoked = await fixture.run("revoked");
		expect(getCurrentTools(revoked.messages).map((tool) => tool.name)).not.toContain("lookup");
		expect(getCurrentSystemPrompt(revoked.messages)).not.toMatch(/On demand: .*\bother\b/);
		expect(
			revoked.messages.filter((message) => message.role === "toolResult" && message.toolName === "lookup"),
		).toHaveLength(2);
	} finally {
		await fixture.harness.close(context);
	}
});

it("keeps discovery in ordinary and group agents, without adding direct-chat tools to a group", () => {
	const tools = chatTools({ id: "reader", tools: [] }, [], [], true);
	expect(tools).toContain("tool_search");
	expect(tools).toContain("message_group");
	expect(tools).not.toContain("message_user");
	expect(tools).not.toContain("message_agent");
});

it("keeps discovered schemas after pi compacts the conversation", async () => {
	const fixture = await discoveryFixture(await tempHome());
	try {
		const before = await fixture.run();
		const conversation = (await fixture.harness.conversation(before.chat, context))!;
		const task = await conversation.compact(undefined, context);
		await fixture.harness.waitForTask(task, context);
		const after = await fixture.run("after-compaction");
		expect(after.entries.some((entry) => entry.kind === "pi.compaction")).toBe(true);
		expect(after.state?.modelTools).toEqual({ add: ["lookup"] });
		expect(getCurrentTools(after.messages).map((tool) => tool.name)).toContain("lookup");
	} finally {
		await fixture.harness.close(context);
	}
});
