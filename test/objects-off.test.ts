import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { Accepted, AgentChats, shaOf } from "../src/core/agents.ts";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import { Connected, ToolSettings } from "../src/core/connections.ts";
import { Readings } from "../src/core/objects.ts";
import { context } from "../src/core/store.ts";
import { openObjects } from "../src/server/objects.ts";
import { openConnected } from "./fixtures/connected.ts";
import { added, definition, shipping } from "./fixtures/shipped.ts";
import { tempHome } from "./helpers.ts";

const opened: Awaited<ReturnType<typeof openConnected>>[] = [];
afterEach(async () => {
	for (const s of opened.splice(0)) await s.close();
});

const args = { owner: "{owner}", repo: "{repo}", number: "{number}" };
const issue = {
	follow: { ends: {}, rules: [{ on: "issue.state", does: "wake", says: "{to}" }] },
	card: "issue",
	name: "{owner}/{repo} #{number}",
	urls: ["https://example.com/{owner}/{repo}/issues/{number}"],
	ids: ["{owner}/{repo}#{number}"],
	fields: { title: "issue.title", state: "issue.state" },
};
const TOOLS = ["get", "extra", "history", "activity"];

async function setup(reads: { [as: string]: object }) {
	const text = JSON.stringify({
		service: "Example",
		about: "An example",
		url: "https://example.com/mcp",
		auth: "key",
		reads: TOOLS,
		objects: { issue: { ...issue, reads } },
	});
	const s = await openConnected({ home: await tempHome(), respond: () => fauxAssistantMessage("done") });
	opened.push(s);
	shipping(definition("example", text));
	await s.harness.commit(async (tx) => {
		const a = await tx.doc(Accepted);
		await added(tx, "example");
		const agent = `---\nname: Reader\ndescription: Reads objects\nface: ${JSON.stringify(defaultAvatarFace())}\nstate: active\nconnections: [example]\n---\nReader`;
		a.files["agents/reader.md"] = { text: agent, sha: shaOf(agent), at: 1 };
		(await tx.doc(AgentChats)).chats[1] = "reader";
		const c = await tx.doc(Connected);
		c.connections.example = {
			version: shaOf(text),
			at: 1,
			tools: Object.fromEntries(
				TOOLS.map((tool) => [
					tool,
					{ description: "read", schema: { type: "object", properties: { number: { type: "integer" } } } },
				]),
			),
		};
		c.accounts.example = { alice: { id: "alice", at: 1 } };
		c.on.reader = { example: ["alice"] };
	}, context);
	const calls: string[] = [];
	const service = openObjects({
		harness: s.harness,
		now: () => 100,
		capabilities: {
			shipped: async () => [definition("example", text)],
			listedSchema: async () => ({ type: "object", properties: { number: { type: "integer" } } }),
			readFor: async (_name, _account, tool) => {
				calls.push(tool);
				return { text: JSON.stringify({ title: "private", state: "open" }) };
			},
		},
	});
	const off = (tool: string, why: "owner" | "waiting" = "owner") =>
		s.harness.commit(async (tx) => {
			(await tx.doc(Connected)).off[`example__${tool}`] = why;
		}, context);
	const on = (tool: string) =>
		s.harness.commit(async (tx) => {
			delete (await tx.doc(Connected)).off[`example__${tool}`];
		}, context);
	const show = async (refresh = false) => (await service.show(1, [{ ref: "a/b#1" }], refresh))[0];
	return { ...s, calls, off, on, show };
}

describe("a card whose tool is off", () => {
	it("a read it needs is off: unavailable, saying why and how to change it, with no call, kept reading or not", async () => {
		const s = await setup({ issue: { tool: "get", args } });
		expect((await s.show())?.shown).toBe("card");
		expect(s.calls).toEqual(["get"]);
		await s.off("get");
		for (const refresh of [false, true]) {
			const shown = await s.show(refresh);
			expect(shown).toMatchObject({ shown: "failed", off: true, name: "a/b #1", service: "Example" });
			expect(shown).toHaveProperty("why", expect.stringContaining("You turned off"));
			expect(shown).toHaveProperty("why", expect.stringContaining("get"));
			expect(shown).toHaveProperty("why", expect.stringContaining("Connections"));
		}
		expect(s.calls).toEqual(["get"]);
		await s.on("get");
		expect((await s.show())?.shown).toBe("card");
	});

	it("says it differently when the tool waits for the owner to turn it on", async () => {
		const s = await setup({ issue: { tool: "get", args } });
		await s.off("get", "waiting");
		const shown = await s.show();
		expect(shown).toMatchObject({ shown: "failed", off: true });
		expect(shown).toHaveProperty("why", expect.stringContaining("until you turn it on"));
		expect(s.calls).toEqual([]);
	});

	it("an optional read that is off is skipped, and a reading kept with it is not served as if it were on", async () => {
		const s = await setup({
			issue: { tool: "get", args },
			extra: { tool: "extra", args, optional: true },
		});
		expect((await s.show())?.shown).toBe("card");
		expect(s.calls).toEqual(["get", "extra"]);
		await s.off("extra");
		expect((await s.show())?.shown).toBe("card");
		// read again, and without the optional one
		expect(s.calls).toEqual(["get", "extra", "get"]);
		const kept = await s.harness.snapshot(Readings, context);
		expect(Object.values(kept?.readings ?? {})[0]?.source).toContain("false");
	});

	it("a read only a watch makes being off leaves the card as it is", async () => {
		const s = await setup({
			issue: { tool: "get", args },
			activity: { tool: "activity", args, follow: true },
		});
		expect((await s.show())?.shown).toBe("card");
		await s.off("activity");
		expect((await s.show())?.shown).toBe("card");
		expect(s.calls).toEqual(["get", "get"]);
	});

	it("Ask and Always ask change nothing for a card", async () => {
		const s = await setup({ issue: { tool: "get", args } });
		expect((await s.show())?.shown).toBe("card");
		for (const setting of ["ask", "always"] as const) {
			await s.harness.commit(async (tx) => {
				(await tx.doc(ToolSettings)).set.example__get = setting;
			}, context);
			expect((await s.show())?.shown).toBe("card");
		}
		expect(s.calls).toEqual(["get"]);
	});
});
