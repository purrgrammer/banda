import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { Accepted, AgentChats, shaOf } from "../src/core/agents.ts";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import { Connected } from "../src/core/connections.ts";
import { Groups } from "../src/core/groups.ts";
import { keepReading, MAX_READINGS, Readings } from "../src/core/objects.ts";
import { context } from "../src/core/store.ts";
import { openObjects } from "../src/server/objects.ts";
import { openConnected } from "./fixtures/connected.ts";
import { added, definition, shipping } from "./fixtures/shipped.ts";
import { tempHome } from "./helpers.ts";

const opened: Awaited<ReturnType<typeof openConnected>>[] = [];
afterEach(async () => {
	for (const s of opened.splice(0)) await s.close();
});
const kinds = {
	issue: {
		card: "issue",
		name: "{owner}/{repo} #{number}",
		urls: ["https://example.com/{owner}/{repo}/issues/{number}"],
		ids: ["{owner}/{repo}#{number}"],
		reads: { issue: { tool: "get", args: { owner: "{owner}", repo: "{repo}", number: "{number}" } } },
		fields: { title: "issue.title", state: "issue.state" },
	},
};
/** The definition of the connection the objects are from: what it reads, and what it draws. */
const definitionText = (objects: object, reads: readonly string[] = ["get"]) =>
	JSON.stringify({
		service: "Example",
		about: "An example",
		url: "https://example.com/mcp",
		auth: "key",
		reads,
		objects,
	});
const text = definitionText(kinds);
async function setup() {
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
			tools: { get: { description: "read", schema: { type: "object", properties: { number: { type: "integer" } } } } },
		};
		c.accounts.example = { alice: { id: "alice", at: 1 }, bob: { id: "bob", at: 1 } };
		c.on.reader = { example: ["alice"] };
	}, context);
	let calls = 0;
	let clock = 100;
	const service = openObjects({
		harness: s.harness,
		now: () => clock,
		capabilities: {
			shipped: async () => [definition("example", text)],
			listedSchema: async () => ({ type: "object", properties: { number: { type: "integer" } } }),
			readFor: async () => {
				calls++;
				return { text: JSON.stringify({ title: "private", state: "open" }) };
			},
		},
	});
	return {
		...s,
		service,
		calls: () => calls,
		tick: () => {
			clock += 3600000;
		},
	};
}
it("URL, ambiguous shorthand and canonical aliases are read once, each given the card, without spending the card budget", async () => {
	const s = await setup();
	const next = definitionText({
		pull_request: {
			...kinds.issue,
			card: "pull-request",
			urls: ["https://example.com/{owner}/{repo}/pull/{number}"],
		},
		...kinds,
	});
	shipping(definition("example", next));
	await s.harness.commit(async (tx) => {
		(await tx.doc(Connected)).connections.example!.version = shaOf(next);
	}, context);
	const shown = await s.service.show(1, [
		{ ref: "https://example.com/a/b/pull/1" },
		{ ref: "a/b#1" },
		{ refs: ["example:pull_request:a/b#1"], account: "alice" },
		{ ref: "https://example.com/a/b/issues/2" },
		{ ref: "https://example.com/a/b/issues/3" },
	]);
	// read once, and each link given the reading: the prose draws each, the cards beneath each object once by its key
	expect(shown.map((one) => one.shown)).toEqual(["card", "card", "card", "card", "card"]);
	expect(shown[1]).toBe(shown[0]);
	expect(shown[2]).toBe(shown[0]);
	expect(s.calls()).toBe(3);
});

it("refreshes each fallback candidate at most once per request, including failures", async () => {
	const s = await setup();
	const next = definitionText(
		{
			pull_request: {
				...kinds.issue,
				card: "pull-request",
				urls: ["https://example.com/{owner}/{repo}/pull/{number}"],
				reads: { issue: { tool: "pull", args: { number: "{number}" } } },
			},
			...kinds,
		},
		["get", "pull"],
	);
	shipping(definition("example", next));
	await s.harness.commit(async (tx) => {
		const connected = await tx.doc(Connected);
		connected.connections.example!.version = shaOf(next);
		connected.connections.example!.tools.pull = connected.connections.example!.tools.get!;
	}, context);
	const calls: string[] = [];
	const service = openObjects({
		harness: s.harness,
		capabilities: {
			shipped: async () => [],
			listedSchema: async () => ({ type: "object" }),
			readFor: async (_connection, _account, tool) => {
				calls.push(tool);
				return tool === "pull"
					? { failed: "Not a pull request" }
					: { text: JSON.stringify({ title: "An issue", state: "open" }) };
			},
		},
	});
	const shown = await service.show(
		1,
		[{ ref: "https://example.com/a/b/issues/35" }, { ref: "https://example.com/a/b/pull/35" }, { ref: "a/b#35" }],
		true,
	);
	expect(shown.map((one) => one.shown)).toEqual(["card", "failed", "card"]);
	expect(shown[2]).toBe(shown[0]);
	expect(calls).toEqual(["get", "pull"]);
});

it("revocation during a later read withholds earlier cards in the same response", async () => {
	const s = await setup();
	let calls = 0;
	const service = openObjects({
		harness: s.harness,
		capabilities: {
			shipped: async () => [],
			listedSchema: async () => ({ type: "object" }),
			readFor: async () => {
				if (++calls === 2)
					await s.harness.commit(async (tx) => {
						(await tx.doc(Connected)).on.reader = { example: [] };
					}, context);
				return { text: JSON.stringify({ title: "Private", state: "open" }) };
			},
		},
	});
	const shown = await service.show(1, [{ ref: "a/b#1" }, { ref: "a/b#2" }]);
	expect(shown.every((one) => one.shown === "link")).toBe(true);
	expect(calls).toBe(2);
});

it("stored readings are bounded by oldest time and retain account identity", async () => {
	const s = await setup();
	await s.harness.commit(async (tx) => {
		for (let n = 0; n < MAX_READINGS + 5; n++)
			await keepReading(tx, `example/alice/issue:a/b#${n}`, {
				connection: "example",
				account: "alice",
				kind: "issue",
				at: n,
				source: "accepted-source",
				failed: "Unavailable",
			});
	}, context);
	const readings = (await s.harness.snapshot(Readings, context))?.readings ?? {};
	expect(Object.keys(readings)).toHaveLength(MAX_READINGS);
	expect(Object.values(readings).every((r) => r.at >= 5 && r.account === "alice")).toBe(true);
});
it("group attribution never lends another member's account and removal ends access", async () => {
	const s = await setup();
	await s.harness.commit(async (tx) => {
		const a = await tx.doc(Accepted);
		const reader = a.files["agents/reader.md"]!;
		a.files["agents/outsider.md"] = { ...reader, text: reader.text.replace("Reader", "Outsider") };
		(await tx.doc(AgentChats)).chats[2] = "outsider";
		const g = await tx.doc(Groups);
		g.groups[100] = {
			name: "Room",
			at: 1,
			members: ["reader", "outsider"],
			executions: { reader: { chat: 1 }, outsider: { chat: 2 } },
		};
		g.byExecution[1] = { room: 100, agent: "reader" };
		g.byExecution[2] = { room: 100, agent: "outsider" };
	}, context);
	expect((await s.service.show(100, [{ ref: "a/b#1", agent: "reader" }]))[0]?.shown).toBe("card");
	expect((await s.service.show(100, [{ ref: "a/b#1", agent: "outsider" }]))[0]?.shown).not.toBe("card");
	expect((await s.service.show(100, [{ ref: "a/b#1", agent: "invented" }]))[0]?.shown).not.toBe("card");
	await s.harness.commit(async (tx) => {
		(await tx.doc(Groups)).groups[100]!.members = ["outsider"];
	}, context);
	expect((await s.service.show(100, [{ ref: "a/b#1", agent: "reader" }]))[0]?.shown).not.toBe("card");
	expect(s.calls()).toBe(1);
});
it("caller-supplied draft refs cannot select another agent's account", async () => {
	const s = await setup();
	const shown = await s.service.show(1, [{ refs: ["a/b#1"], account: "bob" }]);
	expect(shown[0]?.shown).not.toBe("card");
	expect(s.calls()).toBe(0);
});
it("tool switches apply to cards including cached readings", async () => {
	const s = await setup();
	expect((await s.service.show(1, [{ ref: "a/b#1" }]))[0]?.shown).toBe("card");
	await s.harness.commit(async (tx) => {
		(await tx.doc(Connected)).off.example__get = "owner";
	}, context);
	expect((await s.service.show(1, [{ ref: "a/b#1" }]))[0]?.shown).not.toBe("card");
	expect(s.calls()).toBe(1);
});
it("old readings do not reread without a tap; all ask shapes share the fanout bound", async () => {
	const s = await setup();
	await s.service.show(1, [{ ref: "a/b#1" }]);
	s.tick();
	await s.service.show(1, [{ ref: "a/b#1" }]);
	expect(s.calls()).toBe(1);
	await s.service.show(
		1,
		Array.from({ length: 8 }, (_, i) => ({ refs: [`a/b#${i + 2}`], account: "alice" })),
	);
	expect(s.calls()).toBe(4);
	expect(Object.keys((await s.harness.snapshot(Readings, context))?.readings ?? {})).toHaveLength(4);
});
