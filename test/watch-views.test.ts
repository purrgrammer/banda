import { describe, expect, it } from "vitest";
import type { Item, WatchView } from "../src/server/api.ts";
import { type Live, shown, view, watchWords } from "../web/src/lib/chat.ts";
import { sawWords, watchRows } from "../web/src/lib/watches.ts";

const NOW = new Date(2026, 10, 2, 9, 0).getTime();
const SHA = "a".repeat(64);
const summary = {
	object: "https://github.com/acme/banda/pull/142",
	account: "bandarra",
	until: "merged",
	ask: "Tell me when it is approved.",
};
const object = {
	key: "github/bandarra/pull_request:acme/banda#142",
	ref: "github:pull_request:acme/banda#142",
	name: "acme/banda #142",
	connection: "github",
	service: "GitHub",
};

describe("watches in the app", () => {
	const idle: Live = { busy: false, running: [], thinking: false };
	const wrote = { kind: "watch" as const, name: "banda-142", sha: SHA, change: "added" as const };
	const call = (
		id: number,
		args: object,
		result?: { error: boolean; text: string; receipt?: Extract<Item, { role: "tool" }>["receipt"] },
	): Item[] => [
		{ id, role: "assistant", text: "", calls: [{ id: `c${id}`, name: "watch", args: args as never }] },
		...(result === undefined ? [] : [{ id: id + 1, role: "tool" as const, call: `c${id}`, name: "watch", ...result }]),
	];

	it("a watch call's line follows the watch: waiting, following, paused, done, not set up, removed since", () => {
		const items = call(
			2,
			{ object: summary.object, ask: summary.ask },
			{ error: false, text: "Wrote", receipt: wrote },
		);
		const line = (watches: WatchView[], removed?: { [path: string]: number }) =>
			view(items, [], idle, { watches, ...(removed === undefined ? {} : { removed }) }).flatMap(shown);
		expect(
			line([{ agent: "mara", name: "banda-142", state: "allow", change: { kind: "added", sha: SHA, watch: summary } }]),
		).toEqual(["Follow https://github.com/acme/banda/pull/142? Waiting for you"]);
		const accepted = { sha: SHA, watch: summary };
		expect(line([{ agent: "mara", name: "banda-142", state: "active", accepted, object }])).toEqual([
			"Following acme/banda #142",
		]);
		expect(line([{ agent: "mara", name: "banda-142", state: "paused", accepted, object, paused: "owner" }])).toEqual([
			"Watch paused: acme/banda #142",
		]);
		expect(
			line([{ agent: "mara", name: "banda-142", state: "done", accepted, object, done: { at: NOW, why: "merged" } }]),
		).toEqual(["Done following acme/banda #142: merged"]);
		expect(line([])).toEqual(["Not following banda-142"]);
		expect(line([], { "watches/banda-142.md": NOW })).toEqual(["Stopped following banda-142"]);
		expect(
			view(
				call(2, {}, { error: true, text: "Not written: no connection can follow that link." }),
				[],
				idle,
				{},
			).flatMap(shown),
		).toEqual(["No watch set up: no connection can follow that link"]);
	});

	it("a watch's change is a line in the chat, with the object beneath; the last says what ended it", () => {
		const items: Item[] = [
			{ id: 1, role: "watch", watch: "banda-142", object, changes: ["ana approved", "lint failed"], text: "", at: NOW },
			{ id: 2, role: "watch", watch: "banda-142", object, changes: ["merged"], text: "", ended: "merged", at: NOW },
			{ id: 3, role: "watch", watch: "banda-142", object, changes: ["checks finished"], text: "", tell: true, at: NOW },
		];
		const segments = view(items, [], idle, {});
		expect(segments.map((segment) => segment.kind)).toEqual(["watch", "watch", "watch"]);
		expect(segments.flatMap((segment) => shown(segment)[0])).toEqual([
			"acme/banda #142 · ana approved, lint failed",
			"acme/banda #142 · done: merged",
			"acme/banda #142 · checks finished",
		]);
		expect(watchWords({ object, changes: ["merged", "closed"], ended: "merged" })).toBe(
			"acme/banda #142 · closed · done: merged",
		);
	});

	it("a watch unable to look for an hour is an error line that opens the watch", () => {
		const items: Item[] = [
			{
				id: 4,
				role: "notice",
				text: "",
				watch: {
					watch: "banda-142",
					name: "acme/banda #142",
					service: "GitHub",
					why: "GitHub did not answer",
					since: NOW,
					at: NOW + 60 * 60_000,
				},
				at: NOW + 60 * 60_000,
			},
		];
		const [line] = view(items, [], idle, {});
		expect(line).toMatchObject({ kind: "notice", watch: "banda-142" });
		expect(shown(line as Parameters<typeof shown>[0])[0]).toMatch(
			/^acme\/banda #142 · can't reach GitHub since 09:00.* · GitHub did not answer$/,
		);
	});

	it("the panel's rows: what it follows, until what, what it last saw, and a change waiting for the owner", () => {
		const accepted = { sha: SHA, watch: summary };
		const rows = watchRows(
			[
				{
					agent: "mara",
					name: "banda-142",
					state: "active",
					accepted,
					object,
					looked: NOW - 60_000,
					next: NOW + 29 * 60_000,
					saw: ["ana approved"],
					sawAt: NOW - 60_000,
				},
				{ agent: "mara", name: "banda-150", state: "allow", change: { kind: "added", sha: SHA, watch: summary } },
				{
					agent: "mara",
					name: "banda-98",
					state: "failing",
					accepted,
					object,
					looked: NOW,
					failed: { at: NOW, why: "GitHub did not answer", since: NOW - 50 * 60_000 },
				},
				{ agent: "mara", name: "banda-77", state: "done", accepted, object, done: { at: NOW, why: "merged" } },
				{
					agent: "mara",
					name: "banda-60",
					state: "done",
					accepted,
					object,
					failed: { at: NOW, why: "GitHub is not connected for Mara", since: NOW },
					done: { at: NOW, why: "GitHub as @bandarra was switched off for Mara", authority: true },
				},
				{ agent: "otto", name: "other", state: "active", accepted, object },
			],
			"mara",
			NOW,
		);
		expect(rows.map((row) => row.id)).toEqual(["banda-142", "banda-150", "banda-98", "banda-77", "banda-60"]);
		expect(rows[0]).toMatchObject({ name: "acme/banda #142", service: "GitHub", until: "until merged", paused: false });
		// the clock's words are the locale's: "today 09:29", or "today 09:29 AM"
		expect(rows[0]?.next).toMatch(/^today 09:29/);
		expect(rows[0]?.saw).toMatch(/^Saw today 08:59.*: ana approved$/);
		expect(rows[1]).toMatchObject({ waiting: "set up", name: summary.object });
		// failing, it says since when it could not reach the service, never "nothing new"
		expect(rows[2]?.failing).toBe(true);
		expect(rows[2]?.saw).toMatch(/^Can't reach GitHub since today 08:10.*: GitHub did not answer$/);
		expect(rows[3]?.done).toBe(true);
		expect(rows[3]?.ended).toBe(false);
		expect(rows[3]?.saw).toMatch(/^Done today 09:00.*: merged$/);
		// ended by authority: it says why, and no longer says it fails
		expect(rows[4]).toMatchObject({ done: true, ended: true, failing: false });
		expect(rows[4]?.saw).toMatch(/^Ended today 09:00.*: GitHub as @bandarra was switched off for Mara$/);
		expect(sawWords({ agent: "mara", name: "x", state: "active", looked: NOW }, NOW)).toMatch(
			/^Looked today 09:00.*, nothing new$/,
		);
	});
});
