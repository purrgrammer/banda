/** A recorded conversation the specimen's private activity preview loads: one run, a failed fetch, the full toolset. */
import type { RecordedActivity } from "../../web/src/specimen/agent/recorded-types.ts";

export const fixture: RecordedActivity = {
	agent: { name: "Sancho" },
	capturedAt: 123,
	runs: [
		{
			id: 1,
			input: "Find an event",
			at: 123,
			kind: "user",
			prompt: {
				system: "Recorded system prompt, not regenerated.",
				tools: Array.from({ length: 22 }, (_, i) => ({
					name: i === 0 ? "web_fetch" : `available_tool_${i}`,
					description: `Complete tool description ${i}`,
					parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
				})),
			},
			items: [
				{ id: 1, role: "user", text: "Find an event", at: 123 },
				{
					id: 2,
					role: "assistant",
					text: "",
					at: 124,
					model: "faux/test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
					calls: [{ id: "fetch", name: "web_fetch", args: { url: "https://example.test/events" } }],
				},
				{ id: 3, role: "tool", call: "fetch", name: "web_fetch", text: "Page unavailable", error: true, at: 125 },
				{
					id: 4,
					role: "assistant",
					text: "",
					at: 126,
					model: "faux/test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
					calls: [
						{
							id: "reply",
							name: "message_user",
							args: { text: "The source is unavailable; I could not verify an event." },
						},
					],
				},
				{ id: 5, role: "tool", call: "reply", name: "message_user", text: "Sent.", error: false, at: 127 },
			],
		},
	],
};
