/**
 * The chat's feed (docs/experience.md): each area's line, in every state, derived from what the store and the
 * workspace hold as the daemon reports them, never from a call's arguments; and the one line component they share.
 */
import { describe, expect, it } from "vitest";
import type { FactView, Item, MemoryView, RoutineView } from "../src/server/api.ts";
import { type Live, type Segment, view } from "../web/src/lib/chat.ts";
import { artifactLine } from "../web/src/lib/segments/artifacts.ts";
import { changeWords } from "../web/src/lib/segments/changes.ts";
import { memoryWords } from "../web/src/lib/segments/memory.ts";
import { PROPOSALS, refusalWords } from "../web/src/lib/segments/refusals.ts";
import { routineWords } from "../web/src/lib/segments/routines.ts";
import type { ViewContext } from "../web/src/lib/segments/types.ts";

const IDLE: Live = { busy: false, running: [], thinking: false };
const BUSY: Live = { busy: true, running: [], thinking: false };

const called = (id: number, call: string, name: string, args: Record<string, unknown>): Item => ({
	id,
	role: "assistant",
	text: "",
	calls: [{ id: call, name, args }],
});
const answered = (
	id: number,
	call: string,
	name: string,
	extra: Partial<Extract<Item, { role: "tool" }>> = {},
): Item => ({
	id,
	role: "tool",
	call,
	name,
	text: "ok",
	error: false,
	at: 1_700_000_000_000,
	...extra,
});

const only = <K extends Segment["kind"]>(segments: Segment[], kind: K) =>
	segments.filter((segment): segment is Extract<Segment, { kind: K }> => segment.kind === kind);

describe("skill load lines", () => {
	it("shows a pre-request load only after its matching owner input, never its instructions", () => {
		const load: Item = {
			id: 1,
			role: "tool",
			call: "owner-skill",
			name: "skill",
			text: "Instructions not for the feed",
			error: false,
			receipt: {
				kind: "skill",
				name: "research",
				sha: "a".repeat(64),
				by: "owner",
				description: "Research",
				files: [],
				invocation: { gateway: "web", message: "m1" },
			},
		};
		expect(view([load], [], IDLE).some((segment) => segment.kind === "skill")).toBe(false);
		const owner: Item = {
			id: 2,
			role: "user",
			text: "Use /research",
			origin: { gateway: "web", peer: "owner" },
			message: "m1",
		};
		expect(view([load, owner], [], IDLE).filter((segment) => segment.kind === "skill")).toMatchObject([
			{ name: "research" },
		]);
		// recorded before the message for the model, it shows after the message that asked for it
		expect(view([load, owner], [], IDLE).map((segment) => segment.kind)).toEqual(["owner-message", "skill"]);
		expect(view([load, { ...owner, message: "other" }], [], IDLE).some((segment) => segment.kind === "skill")).toBe(
			false,
		);
	});
});

describe("memory lines", () => {
	const fact = (id: string, text: string): FactView => ({ id, text, scope: "agent", agent: "sancho" });
	const remember = (receipt?: { id: string; text: string }, extra: Partial<Extract<Item, { role: "tool" }>> = {}) => [
		called(1, "c1", "remember", { fact: "the model's words, never shown" }),
		answered(2, "c1", "remember", receipt === undefined ? extra : { receipt: { kind: "fact", ...receipt }, ...extra }),
	];
	const lines = (items: Item[], memory?: MemoryView, live = IDLE) =>
		only(view(items, [], live, memory === undefined ? {} : ({ memory } as ViewContext)), "memory").map((segment) => [
			segment.state,
			memoryWords(segment),
		]);
	const EMPTY: MemoryView = { facts: [] };
	const seats = { id: "m0000000001", text: "Prefers window seats" };

	it("reads Remembered only for a fact memory holds", () => {
		expect(lines(remember(seats), { ...EMPTY, facts: [fact(seats.id, seats.text)] })).toEqual([
			["done", "Remembered: Prefers window seats"],
		]);
	});
	it("while its call goes it is working; a call that never answered is stopped, never done", () => {
		const [call] = remember(seats);
		expect(lines([call as Item], EMPTY, BUSY)).toEqual([["working", "Remembering…"]]);
		expect(lines([call as Item], EMPTY)).toEqual([["stopped", "Didn't finish remembering"]]);
	});
	it("a call the daemon refused wrote nothing, and says so without the model's words", () => {
		const shown = lines(remember(undefined, { error: true, text: "Not remembered: …" }), EMPTY);
		expect(shown).toEqual([["refused", "Not remembered"]]);
		expect(JSON.stringify(shown)).not.toContain("the model's words");
	});
	it("an unavailable box does not claim a saved fact was forgotten", () => {
		expect(lines(remember(seats), { facts: [], unavailable: true })).toEqual([
			["pending", "Can't check memory right now"],
		]);
	});
	it("a fact gone since reads removed", () => {
		expect(lines(remember(seats), EMPTY)).toEqual([["removed", "Forgotten since: Prefers window seats"]]);
	});
	it("before memory is known, a named fact claims nothing", () => {
		expect(lines(remember(seats))).toEqual([["working", "Remembering…"]]);
	});
	it("a forget reads Forgot once memory no longer holds the fact; kept otherwise", () => {
		const forget = [
			called(1, "c2", "forget", { id: seats.id }),
			answered(2, "c2", "forget", { receipt: { kind: "fact", ...seats } }),
		];
		expect(lines(forget, EMPTY)).toEqual([["done", "Forgot: Prefers window seats"]]);
		expect(lines(forget, { ...EMPTY, facts: [fact(seats.id, seats.text)] })).toEqual([
			["declined", "Kept: Prefers window seats"],
		]);

		// a forget of no fact names none: nothing changed
		expect(lines([called(1, "c3", "forget", { id: seats.id }), answered(2, "c3", "forget")], EMPTY)).toEqual([
			["refused", "Nothing forgotten"],
		]);
	});
});

describe("changes to before files", () => {
	const noted = (path: string) => ({
		notes: [
			{ severity: "info" as const, code: "awaits-acceptance", text: `${path} takes effect only once the owner…` },
		],
	});
	const write = (path: string, extra = noted(path)) => [
		called(1, "w1", "write", { path: "whatever the model said" }),
		answered(2, "w1", "write", extra),
	];
	const lines = (items: Item[], context: ViewContext) =>
		only(view(items, [], IDLE, context), "change").map((segment) => [segment.state, changeWords(segment)]);

	it("a write the daemon did not mark as a before file draws nothing, whatever its arguments say", () => {
		expect(lines(write("tools/x.md", { notes: [] }), {})).toEqual([]);
		expect(lines([called(1, "w1", "write", { path: "tools/x.md" })], {})).toEqual([]);
	});
	it("a command the daemon told of changing before files draws a line for each, even when it failed", () => {
		const notes = [...noted("tools/weather.md").notes, ...noted("connections/notion.md").notes];
		const bash = (error: boolean) => [
			called(1, "b1", "bash", { command: "whatever the model ran" }),
			answered(2, "b1", "bash", { notes, error }),
		];
		const context = { capabilities: { tools: [], connections: [] } };
		const expected = [
			["declined", "Not allowed: a tool it made: weather"],
			["declined", "Not allowed: a connection to notion"],
		];
		expect(lines(bash(false), context)).toEqual(expected);
		expect(lines(bash(true), context)).toEqual(expected);
		// a write that failed wrote nothing, whatever it noted
		expect(lines(write("tools/x.md", { ...noted("tools/x.md"), error: true } as never), context)).toEqual([]);
	});
	it("a connection waits for the owner, then reads allowed by its service's name", () => {
		const base = { name: "notion", state: "waiting" as const, tools: [] };
		const connection = {
			service: "Notion",
			where: "mcp.notion.com",
			boxed: false,
			auth: "oauth" as const,
			reads: [],
			floors: {},
			why: "notes",
		};
		expect(
			lines(write("connections/notion.md"), {
				capabilities: { tools: [], connections: [{ ...base, change: { kind: "added", sha: "a", connection } }] },
			}),
		).toEqual([["pending", "Allow this change? A connection to Notion"]]);
		expect(
			lines(write("connections/notion.md"), {
				capabilities: { tools: [], connections: [{ ...base, state: "connected", accepted: { sha: "a", connection } }] },
			}),
		).toEqual([["done", "Allowed: a connection to Notion"]]);
	});
});

describe("library documents", () => {
	const base = { kind: "artifact", key: "a", by: "companion", title: "the call's title" } as const;
	it("reads published or updated only for the version the Library holds, never the call's title before", () => {
		expect(artifactLine({ ...base })).toEqual({ state: "working", text: "Publishing a document…" });
		expect(artifactLine({ ...base, failed: true, ended: true })).toEqual({ state: "refused", text: "Not published" });
		expect(artifactLine({ ...base, removed: true, ended: true })).toEqual({
			state: "removed",
			text: "A document, removed from the Library since",
		});
		expect(artifactLine({ ...base, id: "x", n: 1, title: "Lisbon plan" })).toEqual({
			state: "done",
			text: "Published: Lisbon plan",
		});
		expect(artifactLine({ ...base, id: "x", n: 3, title: "Lisbon plan" })).toEqual({
			state: "done",
			text: "Updated: Lisbon plan · v3",
		});
	});
});

describe("routines", () => {
	const SHA = "a".repeat(64);
	const OTHER = "b".repeat(64);
	const summary = { description: "Tea at nine", when: "Every day", schedule: "every 1d", runsADay: 24, ask: "Tea." };
	const wrote = (change: "added" | "changed" | "same", sha = SHA) => ({
		receipt: { kind: "routine" as const, name: "tea", sha, change },
	});
	const schedule = (id: number, extra: Partial<Extract<Item, { role: "tool" }>>, args = { name: "tea" }) => [
		called(id, `s${id}`, "schedule", { ...args, description: "the model's words, never shown" }),
		answered(id + 1, `s${id}`, "schedule", extra),
	];
	const lines = (items: Item[], context: ViewContext, live = IDLE) =>
		view(items, [], live, context).flatMap((segment) =>
			segment.kind === "routine"
				? [[segment.state, routineWords(segment)]]
				: segment.kind === "refusal"
					? [[segment.state, refusalWords(segment)]]
					: [],
		);
	const routine = (extra: Partial<RoutineView>): RoutineView => ({
		agent: "sancho",
		name: "tea",
		state: "active",
		...extra,
	});

	it("names the routine by the receipt of the daemon's write, never the call's arguments", () => {
		// no receipt, no routine: the call claims nothing
		expect(lines(schedule(1, {}), { routines: [routine({ accepted: { sha: SHA, routine: summary } })] })).toEqual([
			["refused", "No routine set up"],
		]);
		expect(
			lines(schedule(1, wrote("added")), { routines: [routine({ accepted: { sha: SHA, routine: summary } })] }),
		).toEqual([["done", "Routine scheduled: Tea at nine"]]);
	});
	it("a routine rewritten under its name is a change: waiting for the owner, then changed, or not changed", () => {
		const accepted = { sha: OTHER, routine: summary };
		const change = { kind: "changed" as const, sha: SHA, routine: { ...summary, description: "Tea at ten" } };
		expect(lines(schedule(1, wrote("changed")), { routines: [routine({ state: "allow", accepted, change })] })).toEqual(
			[["pending", "Routine change: Tea at nine · waiting for you"]],
		);
		// allowed: what the call wrote is in effect, or was, whatever the owner changed since
		expect(
			lines(schedule(1, wrote("changed")), {
				routines: [routine({ accepted: { sha: SHA, routine: summary }, allowed: [SHA] })],
			}),
		).toEqual([["done", "Routine changed: Tea at nine"]]);
		expect(lines(schedule(1, wrote("changed")), { routines: [routine({ accepted, allowed: [OTHER, SHA] })] })).toEqual([
			["done", "Routine changed: Tea at nine"],
		]);
		// declined: the version in effect stays, and what the call wrote was never allowed
		expect(lines(schedule(1, wrote("changed")), { routines: [routine({ accepted, allowed: [OTHER] })] })).toEqual([
			["declined", "Routine not changed: Tea at nine"],
		]);
	});
	it("shows the face of the agent it runs as; the lead's is the companion's", () => {
		const accepted = { sha: SHA, routine: summary };
		const mara = { name: "Mara", face: { emoji: "🔎" } };
		const [line] = view(schedule(1, wrote("added")), [], IDLE, {
			routines: [routine({ accepted, agent: "researcher" })],
			agents: [{ name: "researcher", accepted: { sha: "c", text: "", agent: mara as never } }],
		});
		expect(line?.kind === "routine" && line.runsAs).toEqual(mara);
		const [lead] = view(schedule(1, wrote("added")), [], IDLE, { routines: [routine({ accepted })] });
		expect(lead?.kind === "routine" && lead.runsAs).toBeUndefined();
	});
	it("a refusal the same run then did draws one line, for what was done; one nothing followed stays", () => {
		const refused = { error: true, text: 'Not written: give one of "every", "at" and "cron".' };
		const context = { routines: [routine({ accepted: { sha: SHA, routine: summary } })] };
		expect(lines([...schedule(1, refused), ...schedule(3, wrote("added"))], context)).toEqual([
			["done", "Routine scheduled: Tea at nine"],
		]);
		expect(lines(schedule(1, refused), context)).toEqual([
			["refused", 'No routine set up: give one of "every", "at" and "cron"'],
		]);
		// another routine, or the owner's next message between them, is not the same attempt
		expect(lines([...schedule(1, refused, { name: "walk" }), ...schedule(3, wrote("added"))], context)).toEqual([
			["refused", 'No routine set up: give one of "every", "at" and "cron"'],
			["done", "Routine scheduled: Tea at nine"],
		]);
		const owner: Item = { id: 3, role: "user", text: "try again", origin: { gateway: "web", peer: "owner" } };
		expect(lines([...schedule(1, refused), owner, ...schedule(4, wrote("added"))], context)).toEqual([
			["refused", 'No routine set up: give one of "every", "at" and "cron"'],
			["done", "Routine scheduled: Tea at nine"],
		]);
	});
});

describe("refused proposals", () => {
	const refused = (id: number, tool: string, text: string, args: Record<string, unknown> = {}) => [
		called(id, `p${id}`, tool, { ...args, question: "the model's words, never shown" }),
		answered(id + 1, `p${id}`, tool, { error: true, text }),
	];
	const lines = (items: Item[], context: ViewContext = {}) =>
		view(items, [], IDLE, context).flatMap((segment) => (segment.kind === "refusal" ? [refusalWords(segment)] : []));

	it("says why in the daemon's words, for each tool that proposes", () => {
		for (const tool of PROPOSALS)
			expect(lines(refused(1, tool, "Not proposed: only the lead proposes changes to the companion."))).toEqual([
				"Not proposed: only the lead proposes changes to the companion",
			]);
		// turned away before it ran: never the arguments the harness quotes back
		const invalid =
			'Validation failed for tool "propose_send":\n  - topic: must be string\n\nReceived arguments:\n{"x":1}';
		expect(lines(refused(1, "propose_send", invalid))).toEqual(["Not proposed: it was not asked in a form that works"]);
	});
	it("a call that was not refused, or another tool's refusal, draws no refusal line", () => {
		expect(lines([called(1, "p1", "propose_send", {}), answered(2, "p1", "propose_send")])).toEqual([]);
		expect(lines(refused(1, "bash", "Command failed"))).toEqual([]);
	});
});

describe("a routine's events", () => {
	const wake = (id: number, owner = false): Item => ({
		id,
		role: "wake",
		routine: "tea-time",
		text: "Tea time",
		...(owner ? { owner: true as const } : {}),
		at: 1,
	});
	const shownOf = (items: Item[], live = IDLE) =>
		view(items, [], live).map((segment) => [segment.kind, "text" in segment ? segment.text : ""]);

	it("draws a wake only when the agent replied or the run failed: a quiet run leaves no trace", () => {
		const items: Item[] = [
			wake(1),
			{ id: 2, role: "assistant", text: "nothing worth saying" },
			{ id: 3, role: "user", text: "hi" },
			wake(4, true),
			called(5, "c5", "message_user", { text: "Drink tea" }),
			answered(6, "c5", "message_user"),
			wake(7),
			{ id: 8, role: "assistant", text: "", error: "overloaded" },
			{
				id: 9,
				role: "notice",
				text: 'Routine "Tea time" failed: overloaded',
				routine: { routine: "tea-time", description: "Tea time", at: 2, trouble: "failed", why: "the model is down" },
			},
			{
				id: 10,
				role: "notice",
				text: 'Routine "Tea time" paused',
				routine: { routine: "tea-time", description: "Tea time", at: 3, trouble: "limit", runsADay: 4 },
			},
		];
		expect(shownOf(items)).toEqual([
			["owner-message", "hi"],
			["wake", "You ran Tea time"],
			["companion", "Drink tea"],
			// the failure is said once, as the routine's
			["wake", "Tea time ran"],
			["notice", "Tea time failed: the model is down"],
			["notice", "Tea time paused: it ran 4 times today, the most it may. Resume it in the panel"],
		]);
	});

	it("a run still going shows nothing of its wake until it says something", () => {
		expect(shownOf([wake(1)], { busy: true, running: [], thinking: true })).toEqual([["working", "thinking…"]]);
	});
});
