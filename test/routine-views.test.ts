import { describe, expect, it } from "vitest";
import type { Item, RoutineView } from "../src/server/api.ts";
import { type Live, shown, view } from "../web/src/lib/chat.ts";

describe("routines in the app", () => {
	const idle: Live = { busy: false, running: [], thinking: false };
	/** The receipt of the daemon's write of tea: the line names the routine by it. */
	const wrote = { kind: "routine" as const, name: "tea", sha: "a".repeat(64), change: "added" as const };
	const call = (
		id: number,
		name: string,
		args: object,
		result?: { error: boolean; text: string; receipt?: Extract<Item, { role: "tool" }>["receipt"] },
	): Item[] => [
		{ id, role: "assistant", text: "", calls: [{ id: `c${id}`, name, args: args as never }] },
		...(result === undefined ? [] : [{ id: id + 1, role: "tool" as const, call: `c${id}`, name, ...result }]),
	];

	it("a schedule call is the routine's line, once per routine, where the chat last changed it", () => {
		const items: Item[] = [
			{ id: 1, role: "user", text: "tea every day" },
			...call(
				2,
				"schedule",
				{ name: "tea", description: "Tea time", every: "1d", ask: "Tea." },
				{ error: false, text: "Wrote routines/tea.md.", receipt: wrote },
			),
			...call(
				4,
				"schedule",
				{ name: "price", description: "Price", every: "1h", ask: "Tell me." },
				{ error: true, text: "Not written: that time has passed." },
			),
			{ id: 6, role: "user", text: "make it 9am" },
			...call(7, "schedule", { name: "tea", description: "Tea at nine", cron: "0 9 * * *", ask: "Tea." }),
		];
		const routines: RoutineView[] = [
			{
				agent: "sancho",
				name: "tea",
				state: "active",
				accepted: {
					sha: "a".repeat(64),
					routine: { description: "Tea time", when: "Every day", schedule: "every 1d", runsADay: 2, ask: "Tea." },
				},
			},
		];
		// the call still going names nothing yet; the refused one says nothing was set up; tea reads as it is now
		const busy = view(items, [], { ...idle, busy: true }, { routines });
		expect(busy.map((segment) => segment.kind)).toEqual([
			"owner-message",
			"routine",
			"routine",
			"owner-message",
			"routine",
			"working",
		]);
		expect(busy.filter((segment) => segment.kind === "routine").flatMap(shown)).toEqual([
			"Routine scheduled: Tea time",
			"No routine set up: that time has passed",
			"Setting up a routine…",
		]);
		// its run over, the call that never answered never will
		expect(view(items, [], idle, { routines }).flatMap(shown).at(-1)).toBe("Didn't finish setting up a routine");
		// the call that answered moves the line to where the chat last changed the routine
		const answered = [
			...items,
			{ id: 8, role: "tool" as const, call: "c7", name: "schedule", text: "Wrote", error: false, receipt: wrote },
		];
		const lines = view(answered, [], idle, { routines }).filter((segment) => segment.kind === "routine");
		expect(lines.map((segment) => segment.key)).toEqual(["4:c4", "7:c7"]);
	});

	it("a routine's line follows the routine: waiting, scheduled, paused, ran, not set up, removed since", () => {
		const items = call(
			2,
			"schedule",
			{ name: "tea", description: "model words" },
			{ error: false, text: "Wrote", receipt: wrote },
		);
		const summary = { description: "Tea time", when: "Every day", schedule: "every 1d", runsADay: 2, ask: "Tea." };
		const line = (routines: RoutineView[], removed?: { [path: string]: number }) =>
			view(items, [], idle, { routines, ...(removed === undefined ? {} : { removed }) }).flatMap(shown);
		expect(
			line([
				{
					agent: "sancho",
					name: "tea",
					state: "allow",
					change: { kind: "added", sha: "a".repeat(64), routine: summary },
				},
			]),
		).toEqual(["New routine: Tea time · waiting for you"]);
		const accepted = { sha: "a".repeat(64), routine: summary };
		expect(
			line([
				{
					agent: "sancho",
					name: "tea",
					state: "active",
					accepted,
					change: { kind: "changed", sha: "b".repeat(64), routine: summary },
				},
			]),
		).toEqual(["Routine change: Tea time · waiting for you"]);
		expect(line([{ agent: "sancho", name: "tea", state: "active", accepted, change: { kind: "removed" } }])).toEqual([
			"Remove routine Tea time? Waiting for you",
		]);
		expect(line([{ agent: "sancho", name: "tea", state: "active", accepted }])).toEqual([
			"Routine scheduled: Tea time",
		]);
		expect(line([{ agent: "sancho", name: "tea", state: "paused", accepted, paused: "owner" }])).toEqual([
			"Routine paused: Tea time",
		]);
		expect(line([{ agent: "sancho", name: "tea", state: "done", accepted, done: 5 }])).toEqual([
			"Routine ran: Tea time",
		]);
		expect(line([])).toEqual(["Routine not set up: tea"]);
		expect(line([], { "routines/tea.md": 9 })).toEqual(["Routine removed: tea"]);
	});
});
