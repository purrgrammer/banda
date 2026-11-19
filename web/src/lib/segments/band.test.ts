import { describe, expect, it } from "vitest";
import type { Item, ToolCall } from "../../../../src/server/api.ts";
import { band, bandWords } from "./band.ts";

const call = (name: string): ToolCall => ({ id: "c1", name, args: {} }) as ToolCall;
const result = (over: Partial<Extract<Item, { role: "tool" }>>): Extract<Item, { role: "tool" }> =>
	({ id: 2, role: "tool", call: "c1", name: "create_agent", text: "", error: false, at: 5, ...over }) as Extract<
		Item,
		{ role: "tool" }
	>;
const face = {
	definition: {
		version: 1 as const,
		id: "d",
		name: "D",
		body: { path: "M0 0" },
		eyes: { x: 0, y: 0, spacing: 0, scale: 1 },
	},
	color: "#000000",
};

describe("the band's own calls in the feed", () => {
	it("draws a receipt as done, never the call's arguments", () => {
		const receipt = {
			kind: "agent" as const,
			change: "created" as const,
			id: "writer",
			agent: { name: "Writer", face, description: "Writes drafts", instructions: "Write." },
		};
		const made = band.call?.(
			{ id: "c1", name: "create_agent", args: { name: "Argued", description: "From the arguments" } } as ToolCall,
			"1:c1",
			{ result: result({ receipt }), asks: () => [], context: {} },
		);
		expect(made).toEqual([{ kind: "band", key: "1:c1", tool: "create_agent", state: "done", receipt, at: 5 }]);
		expect(bandWords(made?.[0] as Parameters<typeof bandWords>[0])).toBe("Created Writer: Writes drafts");
		expect(JSON.stringify(made)).not.toContain("Argued");
	});

	it("says why a refused call did nothing, in the daemon's words, and claims nothing for one still working", () => {
		const refused = band.call?.(call("update_agent"), "1:c1", {
			result: result({
				name: "update_agent",
				error: true,
				text: "Not updated: helper's instructions are its own and the owner's to change.",
			}),
			asks: () => [],
			context: {},
		});
		expect(refused?.[0]).toMatchObject({
			state: "refused",
			why: "helper's instructions are its own and the owner's to change",
		});
		expect(bandWords(refused?.[0] as Parameters<typeof bandWords>[0])).toBe(
			"Agent not updated: helper's instructions are its own and the owner's to change",
		);
		const working = band.call?.(call("create_group"), "1:c1", { asks: () => [], context: {} });
		expect(working?.[0]).toMatchObject({ state: "working" });
		expect(bandWords(working?.[0] as Parameters<typeof bandWords>[0])).toBe("Creating a group…");
		// answered without the receipt only the daemon writes: nothing to claim
		const bare = band.call?.(call("create_group"), "1:c1", {
			result: result({ name: "create_group" }),
			asks: () => [],
			context: {},
		});
		expect(bare?.[0]).toMatchObject({ state: "refused" });
		expect(band.call?.(call("bash"), "1:c1", { asks: () => [], context: {} })).toBeUndefined();
	});

	it("names a group and an update by what the receipt says", () => {
		expect(
			bandWords({
				tool: "create_group",
				state: "done",
				receipt: {
					kind: "group",
					room: 7,
					name: "Research",
					members: [
						{ id: "a", name: "Mara" },
						{ id: "b", name: "Atlas" },
					],
				},
			}),
		).toBe("Created the group Research: Mara, Atlas");
		expect(
			bandWords({
				tool: "update_agent",
				state: "done",
				receipt: {
					kind: "agent",
					change: "updated",
					id: "a",
					agent: { name: "Mara", face, description: "d", instructions: "i" },
					before: { description: "was" },
				},
			}),
		).toBe("Updated Mara: description");
	});
});
