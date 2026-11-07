/** What an agent knows of its own permissions: how it asks, and what it may do without asking, its own alone. */
import { describe, expect, it } from "vitest";
import { AgentChats } from "../src/core/agents.ts";
import { ASKING_WORDS, permissionsLines, permissionsSection } from "../src/core/permission-prompt.ts";
import { type Permission, permissionWhen } from "../src/core/permissions.ts";
import { context } from "../src/core/store.ts";

const HOUR = 60 * 60_000;
const at = Date.parse("2026-11-07T22:00:00Z");

const given = (permission: Partial<Permission> & Pick<Permission, "what" | "scope">): Permission => ({
	tool: "send",
	match: {},
	at: 0,
	wait: 1,
	...permission,
});

const permissions: { [id: string]: Permission } = {
	"1": given({ what: "send messages to ana", scope: "always", agent: "reader" }),
	"2": given({ what: "send messages to bob", scope: "always", agent: "writer" }),
	"3": given({ what: "Reader may send anything to github.com", scope: "host", agent: "reader" }),
	"4": given({ what: "merge pull requests in banda", scope: "until", until: at + 2 * HOUR, agent: "reader" }),
	"5": given({ what: "deploy prod", scope: "until", until: at - HOUR, agent: "reader" }),
	"6": given({ what: "send messages to eve", scope: "task", task: { chat: 42, input: 7 }, agent: "reader" }),
};

describe("the permissions section", () => {
	it("lists the agent's own open permissions and how long, never another agent's, an expired one or a task's", () => {
		const until = permissionWhen({ scope: "until", until: at + 2 * HOUR });
		expect(permissionsLines(permissions, at, "reader")).toBe(
			`${ASKING_WORDS}\nThe owner allowed you to do these without asking:\n` +
				"- send messages to ana, always\n" +
				"- send anything to github.com, always\n" +
				`- merge pull requests in banda, ${until}`,
		);
		expect(permissionsLines(permissions, at, "writer")).toBe(
			`${ASKING_WORDS}\nThe owner allowed you to do these without asking:\n- send messages to bob, always`,
		);
		// the window closed: the words change at the next render
		expect(permissionsLines(permissions, at + 3 * HOUR, "reader")).not.toContain("merge pull requests");
	});

	it("says an agent with none has none, and a chat of no agent hears only how asking works", () => {
		expect(permissionsLines(permissions, at, "lead")).toBe(
			`${ASKING_WORDS}\nYou have no permissions: everything outside your computer asks.`,
		);
		expect(permissionsLines(permissions, at, undefined)).toBe(ASKING_WORDS);
	});

	it("renders the same words while nothing changed, so the chat gains no entry", async () => {
		let now = at;
		const section = permissionsSection(() => now);
		const input = {
			conversationId: "42",
			read: {
				snapshot: async (doc: unknown) =>
					doc === AgentChats ? { chats: { "42": "reader" } } : { permissions, next: 7 },
			},
		} as unknown as Parameters<typeof section.render>[0];
		const first = await section.render(input, context);
		now += 10 * 60_000;
		expect(await section.render(input, context)).toBe(first);
		expect(first).toContain("- send messages to ana, always");
		expect(first).not.toContain("bob");
	});
});
