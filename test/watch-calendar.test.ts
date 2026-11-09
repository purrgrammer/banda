import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eventAnswer, eventRef } from "../src/core/calendar-rest.ts";
import type { Json } from "../src/core/follow.ts";
import { REST_APIS } from "../src/core/rest.ts";
import { Faults } from "./fault/faults.ts";
import { type Answer, failure, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

/** Google Calendar as banda ships it, signed in as ana@example.com. */
const CALENDAR = {
	name: "calendar",
	file: readFileSync(new URL("../shipped/connections/calendar.md", import.meta.url), "utf8"),
	tools: REST_APIS.calendar.tools,
	account: "ana@example.com",
};

const EVENT = `calendar/${eventRef("primary", "e1")}`;

type Event = { [key: string]: Json };
type Guest = { [key: string]: Json };

/**
 * An event Bob organises, as Google keeps it: Ana (the account) and Cy invited, no one has answered. `change` makes
 * the event at each step from a copy of it; get_event answers it as banda's own read does.
 */
const event =
	(change: (event: Event, guests: Guest[], step: number) => void): Answer =>
	(tool, args, step) => {
		if (tool !== "get_event") return failure(`no ${tool}`);
		if (args.event_id !== EVENT.slice("calendar/".length)) return failure("no such event");
		const guests: Guest[] = [
			{ email: "ana@example.com", self: true, responseStatus: "needsAction" },
			{ email: "bob@example.com", displayName: "Bob", organizer: true, responseStatus: "accepted" },
			{ email: "cy@example.com", displayName: "Cy", responseStatus: "needsAction" },
			{ email: "room-4@resource.calendar.google.com", resource: true, responseStatus: "accepted" },
		];
		const google: Event = {
			id: "e1",
			status: "confirmed",
			summary: "Quarterly planning",
			start: { dateTime: "2026-11-09T10:00:00+01:00", timeZone: "Europe/Madrid" },
			end: { dateTime: "2026-11-09T11:00:00+01:00", timeZone: "Europe/Madrid" },
			location: "Room 4",
			description: "Agenda: dates and owners",
			organizer: { email: "bob@example.com", displayName: "Bob" },
			htmlLink: "https://www.google.com/calendar/event?eid=e1",
			updated: `2026-11-02T09:0${step}:00Z`,
		};
		change(google, guests, step);
		return eventAnswer({ ...google, attendees: guests }) as unknown as Json;
	};

const follow = async (answer: Answer, clicks = ["k1", "k2"]) => {
	const summary = await watchScenario(await tempHome(), new Faults(), {
		connection: CALENDAR,
		object: EVENT,
		answer,
		clicks,
	});
	expect(watchInvariants(summary)).toEqual([]);
	expect(summary.record.failed).toBeUndefined();
	return summary;
};

const sorted = (words: readonly string[]) => [...words].sort();

describe("a watch on a calendar event", () => {
	it("moved wakes, saying when it starts and ends now", async () => {
		const summary = await follow(
			event((google, _, step) => {
				if (step < 1) return;
				google.start = { dateTime: "2026-11-09T12:00:00+01:00", timeZone: "Europe/Madrid" };
				google.end = { dateTime: "2026-11-09T13:00:00+01:00", timeZone: "Europe/Madrid" };
			}),
		);
		expect(summary.tells).toEqual([]);
		expect(summary.wakes.map((wake) => sorted(wake.changes))).toEqual([
			["moved to 2026-11-09T12:00:00+01:00", "now ends 2026-11-09T13:00:00+01:00"],
		]);
		expect(summary.wakes[0]?.object).toMatchObject({ service: "Google Calendar" });
		expect(summary.record.done).toBeUndefined();
	}, 60_000);

	it("made longer wakes on its end alone", async () => {
		const summary = await follow(
			event((google, _, step) => {
				if (step >= 1) google.end = { dateTime: "2026-11-09T11:30:00+01:00", timeZone: "Europe/Madrid" };
			}),
		);
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([["now ends 2026-11-09T11:30:00+01:00"]]);
	}, 60_000);

	it("cancelled wakes and ends the watch", async () => {
		const summary = await follow(
			event((google, _, step) => {
				if (step >= 1) google.status = "cancelled";
			}),
		);
		expect(summary.wakes.map((wake) => [wake.changes, wake.ended])).toEqual([[["cancelled"], "cancelled"]]);
		expect(summary.record.done?.why).toBe("cancelled");
	}, 60_000);

	it("another guest's reply wakes in words, with their note; the account's own reply is nothing", async () => {
		const summary = await follow(
			event((_, guests, step) => {
				const [ana, bob, cy] = guests as [Guest, Guest, Guest];
				if (step >= 1) {
					cy.responseStatus = "accepted";
					ana.responseStatus = "accepted";
				}
				if (step >= 2) {
					cy.responseStatus = "declined";
					cy.comment = "Clash, sorry";
					bob.responseStatus = "tentative";
				}
				// a note taken back says nothing new
				if (step >= 3) delete cy.comment;
			}),
			["k1", "k2", "k3"],
		);
		expect(summary.wakes.map((wake) => sorted(wake.changes))).toEqual([
			["Cy accepted"],
			["Bob said maybe", "Cy declined", "Cy: Clash, sorry"],
		]);
		expect(summary.tells).toEqual([]);
	}, 60_000);

	it("a guest invited or dropped tells", async () => {
		const summary = await follow(
			event((_, guests, step) => {
				if (step >= 1) guests.push({ email: "di@example.com", displayName: "Di", responseStatus: "needsAction" });
				if (step >= 2) guests.splice(2, 1);
			}),
		);
		expect(summary.wakes).toEqual([]);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["Di invited"], ["Cy no longer invited"]]);
	}, 60_000);

	it("its place, title, description or call changing tells, and nothing else of it is a change", async () => {
		const summary = await follow(
			event((google, guests, step) => {
				if (step >= 1) {
					google.location = "Room 9";
					google.summary = "Planning, Q1";
					// a guest's name as their address book has it is no change
					(guests[2] as Guest).displayName = "Cy Doe";
				}
				if (step >= 2) {
					google.description = "Agenda: dates, owners and the budget";
					google.location = "";
					google.hangoutLink = "https://meet.google.com/abc-defg-hij";
				}
			}),
		);
		expect(summary.wakes).toEqual([]);
		expect(summary.tells.map((tell) => sorted(tell.changes))).toEqual([
			["location: Room 9", "retitled: Planning, Q1"],
			["description changed", "no location now", "video call: https://meet.google.com/abc-defg-hij"],
		]);
	}, 60_000);
});
