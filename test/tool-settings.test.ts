/**
 * What each of a connection's tools does and what the owner sets it to, against a fake MCP server on loopback: a read's
 * Ask and a write's Always ask put it on the floor, where no permission covers it; Off refuses it; the setting is read
 * in the commit that starts a call, so a registration already held obeys it; a stale view cannot set a newer version;
 * and nothing set on a connection lets a known write run unasked, whatever the definition says next.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId, ToolExecutionApi } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { Connected, connectionTools, ToolSettings } from "../src/core/connections.ts";
import { OWNER } from "../src/core/gateway.ts";
import { offeredScopes } from "../src/core/permissions.ts";
import { openWaits } from "../src/core/status.ts";
import { context } from "../src/core/store.ts";
import {
	classOf,
	defaultOf,
	inGroup,
	type Kind,
	nameGroup,
	nameGroups,
	optionsOf,
	type Said,
	SETTINGS,
	type Setting,
} from "../src/core/tool-kinds.ts";
import type { TurnResult } from "../src/core/turn.ts";
import { answer } from "../src/core/wait.ts";
import { type Connected as Opened, openConnected, signInAsOwner } from "./fixtures/connected.ts";
import { type FakeMcp, startFakeMcp } from "./fixtures/mcp-server.ts";
import { tempHome, until } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const opened: Opened[] = [];
const fakes: FakeMcp[] = [];
afterEach(async () => {
	for (const s of opened.splice(0)) await s.close();
	for (const fake of fakes.splice(0)) await fake.close();
});

const web = { gateway: "web", peer: OWNER };
const SIGNED = { auth: "oauth", registeredClient: "banda-app", device: true } as const;

function chatModel() {
	const queue: AssistantMessage[][] = [];
	let n = 0;
	const respond = (request: { messages: { role: string; content?: unknown }[] }) => {
		// what tools changed since is said in a system entry: what it answers is the message before
		const last = [...request.messages].reverse().find((message) => message.role !== "system");
		if (last?.role === "user" && String(last.content).startsWith("You ended your turn without answering"))
			return fauxAssistantMessage("Done.");
		if (last?.role === "toolResult") {
			const next = queue[0]?.shift();
			if (next !== undefined) return next;
			queue.shift();
			return fauxAssistantMessage("Done.");
		}
		return queue[0]?.shift() ?? fauxAssistantMessage("Done.");
	};
	const plan = (...rounds: { tool: string; args?: Record<string, unknown> }[][]) =>
		queue.push(
			rounds.map((calls) =>
				fauxAssistantMessage(
					calls.map((call) => fauxToolCall(call.tool, (call.args ?? {}) as never, { id: `c${++n}` })),
					{ stopReason: "toolUse" },
				),
			),
		);
	return { respond, plan };
}

/** A build that ships connection `cal`, as the tests' fake server serves it; `change` is what this build changes. */
function definition(fake: FakeMcp, change: (d: { [key: string]: unknown }) => void = () => {}) {
	const shipped: { [key: string]: unknown } = {
		service: "Calendar",
		about: "Your days and invites",
		url: fake.url,
		auth: "oauth",
		client: "banda-app",
		scopes: ["cal.write"],
		reads: ["whoami", "list_events"],
		needs: { create_event: ["cal.write"] },
		floors: { money: ["send_payment"] },
	};
	change(shipped);
	return `${JSON.stringify(shipped, null, "\t")}\n`;
}

async function shipping(fake: FakeMcp, change?: (d: { [key: string]: unknown }) => void) {
	const dir = join(await tempHome(), "shipped");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "cal.json"), definition(fake, change));
	return dir;
}

async function open(home: string, shipped?: string, model = chatModel()) {
	const s = await openConnected({
		home,
		respond: model.respond as never,
		...(shipped === undefined ? {} : { shipped }),
	});
	opened.push(s);
	const say = async (text: string) => {
		const received = await s.core.receive(s.harness, {
			id: crypto.randomUUID(),
			origin: { gateway: "fake", peer: OWNER },
			text,
		});
		if (!("turn" in received)) throw new Error(JSON.stringify(received));
		return received;
	};
	const done = (turn: number) => s.harness.waitForTask(turn as TaskId<TurnResult>, context);
	const view = async () => {
		const found = (await s.capabilities.view()).connections.find((each) => each.name === "cal");
		if (found === undefined) throw new Error("no connection cal");
		return found;
	};
	const version = async () => (await view()).accepted?.sha as string;
	const tool = async (name: string) => (await view()).tools.find((each) => each.title === name);
	const set = async (settings: { [tool: string]: Setting }) =>
		s.capabilities.setTools("cal", settings, await version());
	return { ...s, model, say, done, view, version, tool, set };
}

/** A daemon with `cal` shipped and added, connected and on for the first agent. */
async function added(fake: FakeMcp, change?: (d: { [key: string]: unknown }) => void) {
	const s = await open(await tempHome(), await shipping(fake, change));
	await s.capabilities.addShipped("cal");
	expect(await signInAsOwner(s.capabilities, "cal", { fake })).toEqual({ ok: true, words: "connected" });
	return s;
}

const restart = async (s: Awaited<ReturnType<typeof open>>, shipped: string) => {
	opened.splice(opened.indexOf(s), 1);
	await s.close();
	return open(s.home, shipped, s.model);
};

/** Reads `name`'s approval the next call asks for, and denies it. */
async function asked(s: Awaited<ReturnType<typeof open>>, tool: string, args: Record<string, unknown>) {
	s.model.plan([{ tool, args }]);
	const { turn } = await s.say(`use ${tool}`);
	const wait = await until(async () => (await openWaits(s.harness)).find((w) => w.ask.type === "approval"));
	await answer(s.harness, wait.key, "deny", web, "bearer");
	await s.done(turn);
	return wait.ask as Parameters<typeof offeredScopes>[0] & { floor?: string };
}

const inForce = async (s: Awaited<ReturnType<typeof open>>) =>
	Object.fromEntries(
		(
			await s.harness.commit(
				async (tx) =>
					JSON.parse(JSON.stringify(await connectionTools(tx))) as Awaited<ReturnType<typeof connectionTools>>,
				context,
			)
		)
			.filter((tool) => tool.connection.name === "cal")
			.map((tool) => [tool.tool, { read: tool.read, ...(tool.floor === undefined ? {} : { floor: tool.floor }) }]),
	);

describe("a tool's kind, as said", () => {
	const said: Said = {
		reads: ["read_it", "partly"],
		readsWhen: { partly: [{ arg: "uri", value: "x" }] },
		floors: { pay: "money" },
		named: new Set(["read_it", "partly", "pay", "named_write"]),
	};

	it("says what the definition says, then the owner, then the server, and never guesses", () => {
		expect(classOf(said, "pay", [], undefined)).toEqual({ kind: "floor", floor: "money", from: "definition" });
		// a floor beats anything the owner said
		expect(classOf(said, "pay", ["pay"], { readOnlyHint: true }).kind).toBe("floor");
		expect(classOf(said, "read_it", [], undefined)).toEqual({ kind: "read", from: "definition" });
		expect(classOf(said, "partly", [], undefined)).toEqual({ kind: "read", from: "definition" });
		expect(classOf(said, "named_write", [], { readOnlyHint: true })).toEqual({ kind: "write", from: "definition" });
		expect(classOf({ ...said, ask: "always" }, "named_write", [], undefined)).toEqual({
			kind: "floor",
			floor: "private",
			from: "definition",
		});
		expect(classOf(said, "new", ["new"], undefined)).toEqual({ kind: "read", from: "you" });
		expect(classOf(said, "new", [], { readOnlyHint: true })).toEqual({ kind: "read", from: "server" });
		expect(classOf(said, "new", [], { readOnlyHint: false })).toEqual({ kind: "write", from: "server" });
		expect(classOf(said, "new", [], { destructiveHint: true })).toEqual({ kind: "write", from: "server" });
		// a conflict resolves toward asking
		expect(classOf(said, "new", [], { readOnlyHint: true, destructiveHint: true })).toEqual({
			kind: "write",
			from: "server",
		});
		expect(classOf(said, "new", [], undefined)).toEqual({ kind: "unknown", from: "nobody" });
		expect(classOf(said, "new", [], {})).toEqual({ kind: "unknown", from: "nobody" });
	});

	it("offers only what narrows: a known write or floor never Allow, and a server's read only proposed", () => {
		expect(optionsOf({ kind: "read", from: "definition" }, undefined)).toEqual(["allow", "ask", "off"]);
		expect(optionsOf({ kind: "write", from: "definition" }, undefined)).toEqual(["ask", "always", "off"]);
		expect(optionsOf({ kind: "write", from: "server" }, "always")).toEqual(["always", "off"]);
		expect(optionsOf({ kind: "floor", from: "definition" }, undefined)).toEqual(["always", "off"]);
		expect(optionsOf({ kind: "unknown", from: "nobody" }, undefined)).toEqual(["allow", "ask", "always", "off"]);
		expect(optionsOf({ kind: "unknown", from: "nobody" }, "always")).toEqual(["allow", "always", "off"]);
		expect(defaultOf({ kind: "read", from: "definition" }, undefined)).toBe("allow");
		expect(defaultOf({ kind: "read", from: "you" }, "always")).toBe("allow");
		expect(defaultOf({ kind: "read", from: "server" }, undefined)).toBe("ask");
		expect(defaultOf({ kind: "write", from: "definition" }, undefined)).toBe("ask");
		expect(defaultOf({ kind: "write", from: "server" }, "always")).toBe("always");
		expect(defaultOf({ kind: "floor", from: "definition" }, undefined)).toBe("always");
		expect(defaultOf({ kind: "unknown", from: "nobody" }, undefined)).toBe("ask");
	});

	it("groups set each tool to the nearest it has, and name their tools by what they act on", () => {
		expect(inGroup("ask", ["always", "off"])).toBe("always");
		expect(inGroup("always", ["allow", "ask", "off"])).toBe("ask");
		expect(inGroup("allow", ["ask", "always", "off"])).toBeUndefined();
		expect(nameGroup("list_issues")).toBe("Issues");
		expect(nameGroup("create_pull_request")).toBe("Pull requests");
		expect(nameGroup("whoami")).toBe("Whoamis");
		const tools = Array.from({ length: 30 }, (_, i) => `create_things${i}`);
		expect(new Set(Object.values(nameGroups(tools))).size).toBeLessThanOrEqual(8);
		expect(Object.keys(nameGroups(["list_issues", "get_issue", "whoami"]))).toHaveLength(3);
	});

	it("a property: no write or floor is ever offered Allow, and a setting a tool may take keeps it", () => {
		const kinds = fc.constantFrom<Kind>("read", "write", "floor", "unknown");
		const from = fc.constantFrom("definition", "you", "server", "nobody" as const);
		const ask = fc.constantFrom(undefined, "always" as const);
		fc.assert(
			fc.property(kinds, from, ask, fc.constantFrom(...SETTINGS), (kind, source, mode, setting) => {
				const options = optionsOf({ kind, from: source }, mode);
				if (kind === "write" || kind === "floor") expect(options).not.toContain("allow");
				expect(options).toContain("off");
				if (options.includes(setting)) expect(inGroup(setting, options)).toBe(setting);
			}),
			{ numRuns: pbtRuns(200) },
		);
	});
});

describe("a tool's setting", () => {
	it("Ask on a read and Always ask on a write ask every time, offering no scope, for every agent; Off refuses", async () => {
		const fake = await startFakeMcp(SIGNED);
		fakes.push(fake);
		const s = await added(fake);
		expect(await inForce(s)).toEqual({
			create_event: { read: false },
			list_events: { read: true },
			send_payment: { read: false, floor: "money" },
			whoami: { read: true },
		});
		const shown = (await s.view()).tools.map((tool) => [tool.title, tool.classed, tool.setting, tool.options]);
		expect(shown).toEqual([
			["create_event", { kind: "write", from: "definition" }, "ask", ["ask", "always", "off"]],
			["list_events", { kind: "read", from: "definition" }, "allow", ["allow", "ask", "off"]],
			["send_payment", { kind: "floor", floor: "money", from: "definition" }, "always", ["always", "off"]],
			["whoami", { kind: "read", from: "definition" }, "allow", ["allow", "ask", "off"]],
		]);
		// a plain write offers a scope to allow it ahead
		expect(offeredScopes(await asked(s, "cal__create_event", { title: "Tea", day: "mon" })).length).toBeGreaterThan(0);

		await s.set({ list_events: "ask", create_event: "always" });
		expect(await inForce(s)).toMatchObject({
			create_event: { read: false, floor: "owner" },
			list_events: { read: false, floor: "owner" },
		});
		const read = await asked(s, "cal__list_events", { day: "mon" });
		expect(read.floor).toBe("owner");
		expect(offeredScopes(read)).toEqual([]);
		const write = await asked(s, "cal__create_event", { title: "Tea", day: "mon" });
		expect(write.floor).toBe("owner");
		expect(offeredScopes(write)).toEqual([]);
		expect(fake.calls).toEqual([]);
		expect((await s.tool("list_events"))?.setting).toBe("ask");
		expect((await s.tool("create_event"))?.setting).toBe("always");

		await s.set({ create_event: "off" });
		expect(s.offered()).not.toContain("cal__create_event");
		expect((await s.tool("create_event"))?.setting).toBe("off");
		// and back: Off is its switch, what it was set to before stays
		await s.set({ create_event: "always" });
		expect((await s.tool("create_event"))?.setting).toBe("always");
		// Allow on a read takes the setting away
		await s.set({ list_events: "allow" });
		expect((await inForce(s)).list_events).toEqual({ read: true });
		expect((await s.harness.snapshot(ToolSettings, context))?.set).toEqual({ cal__create_event: "always" });
	});

	it("refuses what a connection cannot be set to, and never stores anything wider than Ask", async () => {
		const fake = await startFakeMcp(SIGNED);
		fakes.push(fake);
		const s = await added(fake);
		await expect(s.set({ create_event: "allow" })).rejects.toThrow(/only narrows/);
		await expect(s.set({ send_payment: "ask" })).rejects.toThrow(/only narrows/);
		await expect(s.set({ send_payment: "allow" })).rejects.toThrow(/only narrows/);
		await expect(s.set({ nope: "off" })).rejects.toThrow(/lists no tool named nope/);
		await expect(s.set({ list_events: "sometimes" as never })).rejects.toThrow();
		await expect(s.set({ create_event: "always", send_payment: "allow" })).rejects.toThrow(/only narrows/);
		expect((await s.harness.snapshot(ToolSettings, context))?.set).toEqual({});
		await s.set({ create_event: "ask", list_events: "ask" });
		expect(Object.values((await s.harness.snapshot(ToolSettings, context))?.set ?? {})).toEqual(["ask", "ask"]);
	});
});

describe("the check at the call's start", () => {
	it("a registration held across a change obeys the setting now: a read set to Ask refuses, and asks when called again", async () => {
		const fake = await startFakeMcp(SIGNED);
		fakes.push(fake);
		const s = await added(fake);
		const warm = await s.say("hello");
		await s.done(warm.turn);
		const old = s.registry
			.snapshot()
			.tools()
			.find(({ tool }) => tool.name === "cal__list_events")?.tool;
		if (old === undefined) throw new Error("no registration");
		await s.set({ list_events: "ask" });
		const api = { conversationId: warm.chat, commit: s.harness.commit.bind(s.harness) } as unknown as ToolExecutionApi;
		const result = await old.execute({ day: "mon" }, api, context);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.output)).toContain("the owner set it to ask first");
		expect(fake.calls).toEqual([]);
		expect(offeredScopes(await asked(s, "cal__list_events", { day: "mon" }))).toEqual([]);
	});

	it("once Always ask, an open permission no longer covers a call, whatever was granted before; a card from before refuses a scope", async () => {
		const fake = await startFakeMcp(SIGNED);
		fakes.push(fake);
		const s = await added(fake);
		const ask = async (args: Record<string, unknown>) => {
			s.model.plan([{ tool: "cal__create_event", args }]);
			const { turn } = await s.say(`create ${JSON.stringify(args)}`);
			const wait = await until(async () => (await openWaits(s.harness)).find((w) => w.ask.type === "approval"));
			return { turn, wait };
		};
		const first = await ask({ title: "Tea", day: "mon" });
		await answer(s.harness, first.wait.key, "approve", web, "bearer", {
			approving: { permission: { scope: "always" } },
		});
		await s.done(first.turn);
		// a card still open from before the setting changed
		const pending = await ask({ title: "Lunch", day: "tue" });
		await s.set({ create_event: "always" });
		expect(
			await answer(s.harness, pending.wait.key, "approve", web, "bearer", {
				approving: { permission: { scope: "always" } },
			}),
		).toMatchObject({ refused: expect.stringContaining("never allowed ahead") });
		await answer(s.harness, pending.wait.key, "deny", web, "bearer");
		await s.done(pending.turn);
		// the permission given before does not cover it now: it asks, on the floor
		const again = await ask({ title: "Tea", day: "mon" });
		expect(again.wait.ask).toMatchObject({ floor: "owner" });
		expect(offeredScopes(again.wait.ask as never)).toEqual([]);
		await answer(s.harness, again.wait.key, "deny", web, "bearer");
		await s.done(again.turn);
		expect(fake.calls.map((call) => call.tool)).toEqual(["create_event"]);
	});
});

describe("a stale view", () => {
	it("cannot change a setting for a newer version, and an owner's setting does not move the version", async () => {
		const fake = await startFakeMcp(SIGNED);
		fakes.push(fake);
		const s = await added(fake);
		const version = await s.version();
		await s.capabilities.setTools("cal", { list_events: "ask" }, version);
		// a setting does not move it: another change on the same view still lands
		expect(await s.version()).toBe(version);
		await s.capabilities.setTools("cal", { whoami: "ask" }, version);
		// the owner's own read is a new version, in the commit that makes it: the old token is refused
		fake.tools = fake.tools.map((tool) => (tool.name === "create_event" ? { ...tool, readOnlyHint: true } : tool));
		await expect(s.capabilities.setTools("cal", { list_events: "allow" }, "s999")).rejects.toThrow(/changed/);
		await expect(s.capabilities.setTools("cal", { list_events: "allow" }, undefined)).rejects.toThrow(/version/);
		const shipped = await shipping(fake, (d) => {
			d.about = "A newer build";
		});
		const after = await restart(s, shipped);
		await expect(after.capabilities.setTools("cal", { whoami: "allow" }, version)).rejects.toThrow(/changed/);
		await after.capabilities.setTools("cal", { whoami: "allow" }, await after.version());
	});

	it("a request with no version is refused at the route's edge", async () => {
		const fake = await startFakeMcp(SIGNED);
		fakes.push(fake);
		const s = await added(fake);
		await expect(s.capabilities.setTools("cal", { whoami: "ask" }, undefined)).rejects.toThrow(/version/);
		await expect(s.capabilities.setTools("cal", "whoami", await s.version())).rejects.toThrow(/settings/);
	});
});

describe("over versions, and on a server the owner added", () => {
	it("settings outlast a new definition; nothing the owner set lets a write run unasked, and a floor it names wins", async () => {
		const fake = await startFakeMcp(SIGNED);
		fakes.push(fake);
		let s = await added(fake);
		await s.set({ list_events: "ask", create_event: "always" });
		s = await restart(
			s,
			await shipping(fake, (d) => {
				d.about = "A newer build";
			}),
		);
		expect((await s.harness.snapshot(ToolSettings, context))?.set).toMatchObject({
			cal__list_events: "ask",
			cal__create_event: "always",
		});
		expect(await inForce(s)).toMatchObject({ list_events: { read: false, floor: "owner" } });
		// the next build says list_events writes: an Ask kept for it still asks, and Allow is gone from its options
		s = await restart(
			s,
			await shipping(fake, (d) => {
				d.about = "A build that says it writes";
				d.reads = ["whoami"];
				d.needs = { create_event: ["cal.write"], list_events: ["cal.write"] };
			}),
		);
		expect(await inForce(s)).toMatchObject({ list_events: { read: false } });
		expect((await s.tool("list_events"))?.options).toEqual(["ask", "always", "off"]);
		expect((await s.tool("list_events"))?.classed).toEqual({ kind: "write", from: "definition" });
		// and the build after puts create_event on the floor: Always ask was already there, and it stays floored
		s = await restart(
			s,
			await shipping(fake, (d) => {
				d.floors = { money: ["send_payment"], account: ["create_event"] };
			}),
		);
		expect(await inForce(s)).toMatchObject({ create_event: { floor: "account" } });
		expect((await s.tool("create_event"))?.options).toEqual(["always", "off"]);
	});

	it("an allowed read outlives a definition change, and the owner's Allow on what a server proposes is a read of theirs", async () => {
		const fake = await startFakeMcp(SIGNED);
		fakes.push(fake);
		// list_events is not named here: the server says it reads
		let s = await added(fake, (d) => {
			d.reads = ["whoami"];
			d.needs = { create_event: ["cal.write"] };
		});
		expect((await s.tool("list_events"))?.classed).toEqual({ kind: "read", from: "server" });
		expect((await s.tool("list_events"))?.setting).toBe("off");
		expect((await s.tool("list_events"))?.waiting).toBe(true);
		const before = await s.version();
		await s.capabilities.setTools("cal", { list_events: "allow" }, before);
		expect((await s.tool("list_events"))?.classed).toEqual({ kind: "read", from: "you" });
		expect((await s.tool("list_events"))?.waiting).toBeUndefined();
		expect(await inForce(s)).toMatchObject({ list_events: { read: true } });
		// the version moved, as a read the owner allowed always has
		expect(await s.version()).not.toBe(before);
		await expect(s.capabilities.setTools("cal", { list_events: "ask" }, before)).rejects.toThrow(/changed/);
		s = await restart(
			s,
			await shipping(fake, (d) => {
				d.about = "A newer build";
				d.reads = ["whoami"];
				d.needs = { create_event: ["cal.write"] };
			}),
		);
		expect((await s.tool("list_events"))?.classed).toEqual({ kind: "read", from: "you" });
		expect(await inForce(s)).toMatchObject({ list_events: { read: true } });
	});

	it("a read the owner allowed never makes a tool a later definition says writes run unasked, and comes back if it stops naming it", async () => {
		const fake = await startFakeMcp(SIGNED);
		fakes.push(fake);
		let s = await added(fake, (d) => {
			d.reads = ["whoami"];
			d.needs = { create_event: ["cal.write"] };
		});
		await s.capabilities.setTools("cal", { list_events: "allow" }, await s.version());
		expect(await inForce(s)).toMatchObject({ list_events: { read: true } });
		s = await restart(
			s,
			await shipping(fake, (d) => {
				d.about = "A build that says it writes";
				d.reads = ["whoami"];
				d.needs = { create_event: ["cal.write"], list_events: ["cal.write"] };
			}),
		);
		expect(await inForce(s)).toMatchObject({ list_events: { read: false } });
		expect((await s.tool("list_events"))?.classed).toEqual({ kind: "write", from: "definition" });
		s = await restart(
			s,
			await shipping(fake, (d) => {
				d.about = "A build that names it no more";
				d.reads = ["whoami"];
				d.needs = { create_event: ["cal.write"] };
			}),
		);
		expect(await inForce(s)).toMatchObject({ list_events: { read: true } });
		expect((await s.tool("list_events"))?.classed).toEqual({ kind: "read", from: "you" });
	});

	it("a server added by address: each tool's source is said, unknowns say so, and a tool's waiting is told from the owner's off", async () => {
		const fake = await startFakeMcp();
		fakes.push(fake);
		fake.tools = [
			...fake.tools,
			{ name: "drop_table", description: "Delete everything.", inputSchema: { type: "object" }, destructiveHint: true },
		];
		const home = await tempHome();
		const s = await open(home, undefined);
		const name = await s.capabilities.addMcp({ url: fake.url, service: "Cal" });
		expect(name).toBe("cal");
		const tools = Object.fromEntries((await s.view()).tools.map((tool) => [tool.title, tool]));
		expect(tools.create_event?.classed).toEqual({ kind: "unknown", from: "nobody" });
		expect(tools.create_event?.options).toEqual(["allow", "always", "off"]);
		expect(tools.create_event?.setting).toBe("always");
		expect(tools.list_events?.classed).toEqual({ kind: "read", from: "server" });
		expect(tools.list_events?.setting).toBe("ask");
		expect(tools.drop_table?.classed).toEqual({ kind: "write", from: "server" });
		expect(tools.drop_table?.options).toEqual(["always", "off"]);
		await expect(s.set({ drop_table: "allow" })).rejects.toThrow(/only narrows/);
		// Allow on an unknown the owner vouches for: a read of theirs, in effect
		await s.set({ create_event: "allow" });
		expect((await s.tool("create_event"))?.classed).toEqual({ kind: "read", from: "you" });
		expect(await inForce(s)).toMatchObject({ create_event: { read: true } });
		// a tool listed later waits, and says it is waiting, not that the owner switched it off
		await s.capabilities.setTools("cal", { list_events: "off" }, await s.version());
		expect((await s.tool("list_events"))?.waiting).toBeUndefined();
		fake.tools = [...fake.tools, { name: "new_one", description: "New.", inputSchema: { type: "object" } }];
		await s.capabilities.refresh("cal");
		expect((await s.tool("new_one"))?.waiting).toBe(true);
		expect((await s.tool("new_one"))?.setting).toBe("off");
		// switching it settles it
		await s.set({ new_one: "always" });
		expect((await s.tool("new_one"))?.waiting).toBeUndefined();
	});

	it("removing a connection forgets its settings and switches", async () => {
		const fake = await startFakeMcp(SIGNED);
		fakes.push(fake);
		const s = await added(fake);
		await s.set({ list_events: "ask", create_event: "off" });
		await s.capabilities.remove("connections", "cal");
		expect((await s.harness.snapshot(ToolSettings, context))?.set).toEqual({});
		expect((await s.harness.snapshot(Connected, context))?.off).toEqual({});
	});
});
