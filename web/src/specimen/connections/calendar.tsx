/** Google Calendar's event cards: timed, all-day across days, cancelled, declined, long words, and no description. */
import { DraftApproval } from "../../app/DraftApproval.tsx";
import { Bubble } from "../../chat/Feed.tsx";
import { type CalendarEvent, EventCard, ObjectLink } from "../../chat/Object.tsx";
import { Section } from "../stage.tsx";

export const PLANNING: CalendarEvent = {
	title: "Quarterly planning with Northstar",
	start: "2026-11-09T10:00:00+01:00",
	end: "2026-11-09T11:30:00+01:00",
	allDay: false,
	timeZone: "Europe/Madrid",
	location: "Northstar HQ, 4th floor",
	organizer: "Mira from Northstar",
	who: "Ana García, Mira, Teo +3",
	attendees: 7,
	response: "accepted",
	status: "confirmed",
	description: "Agenda:\n1. Dates and owners for Q1\n2. The rollout plan\n\nBring last quarter's numbers.",
	meet: "https://meet.google.com/abc-defg-hij",
	url: "https://www.google.com/calendar/event?eid=cGxhbm5pbmc",
};

export const EVENTS: readonly (readonly [string, CalendarEvent])[] = [
	["Timed, accepted, with a call", PLANNING],
	[
		"All day across three days, not answered",
		{
			...PLANNING,
			title: "Team offsite",
			start: "2026-11-11",
			end: "2026-11-14",
			allDay: true,
			location: "Lisbon",
			organizer: "Ana García",
			who: "Ana García, Teo",
			attendees: 3,
			response: "needs-action",
			description: "Flights are booked; the hotel is a short walk from the venue.",
			meet: undefined,
		},
	],
	["Cancelled", { ...PLANNING, title: "Design review", status: "cancelled", response: "accepted" }],
	[
		"Declined",
		{ ...PLANNING, title: "Vendor demo", response: "declined", location: "", who: "Sales team +12", meet: undefined },
	],
	[
		"Very long title and location, tentative",
		{
			...PLANNING,
			title:
				"A very long event title that a calendar invitation might carry, naming every team, the quarter and the reason we meet at all",
			location:
				"Northstar Headquarters, Building C, Conference Room Grand-Canal-Overlook-With-A-Name-That-Does-Not-Break, 1200 Market Street",
			status: "tentative",
			response: "tentative",
			meet: "https://acme.zoom.us/j/123456789",
		},
	],
	[
		"No description, no guests",
		{
			...PLANNING,
			title: "Focus time",
			start: "2026-11-10T15:00:00+01:00",
			end: "2026-11-10T17:00:00+01:00",
			location: "",
			organizer: "",
			who: "",
			attendees: 0,
			response: "none",
			description: "",
			meet: undefined,
		},
	],
];

type Draft = Parameters<typeof DraftApproval>[0]["ask"];
const AS = "alice@example.test on Google Calendar";
const REF = { refs: ["calendar:event:cHJpbWFyeSBldnQx"], account: "alice" };

/** A draft of each change, as the daemon words them: a new event with guests and a call, a change, an answer, a deletion. */
const DRAFTS: readonly (readonly [string, Draft, string, boolean])[] = [
	[
		"Draft: create, with guests and a Meet link",
		{
			type: "approval",
			tool: "calendar__create_event",
			verb: "Create",
			as: AS,
			args: {
				title: "Tea with Ana",
				start: "2026-11-09T16:00:00+01:00",
				end: "2026-11-09T17:00:00+01:00",
				location: "Café Comercial",
				description: "Catch up before the offsite.",
				attendees: "ana@example.test, teo@example.test",
				add_meet: true,
				account: "alice",
			},
			editable: ["title", "start", "end", "location", "description", "attendees"],
		},
		"Create “Tea with Ana”",
		false,
	],
	[
		"Draft: change the time and place",
		{
			type: "approval",
			tool: "calendar__update_event",
			verb: "Change",
			as: AS,
			on: REF,
			args: {
				event_id: "cHJpbWFyeSBldnQx",
				start: "2026-11-09T12:00:00+01:00",
				end: "2026-11-09T13:30:00+01:00",
				location: "Room 4",
				send_updates: "all",
				account: "alice",
			},
			editable: ["start", "end", "location"],
		},
		"Change this event",
		true,
	],
	[
		"Draft: answer maybe, with a note",
		{
			type: "approval",
			tool: "calendar__respond_to_event",
			verb: "Maybe",
			as: AS,
			on: REF,
			args: {
				event_id: "cHJpbWFyeSBldnQx",
				response: "tentative",
				comment: "Might be 10 minutes late.",
				account: "alice",
			},
		},
		"Answer maybe to this invitation, saying “Might be 10 minutes late.”",
		true,
	],
	[
		"Draft: delete, telling no one",
		{
			type: "approval",
			tool: "calendar__delete_event",
			verb: "Delete",
			as: AS,
			on: REF,
			args: { event_id: "cHJpbWFyeSBldnQx", send_updates: "none", account: "alice" },
		},
		"Delete this event without telling its guests",
		true,
	],
];

export function CalendarSection() {
	return (
		<Section id="calendar" note="Events an agent names, as cards; an agent's change is a draft you approve.">
			<div className="grid gap-6 lg:grid-cols-2">
				{EVENTS.map(([label, event]) => (
					<div key={label} className="flex min-w-0 flex-col gap-1.5">
						<span className="text-meta text-ink-2">{label}</span>
						<EventCard event={event} />
					</div>
				))}
				{DRAFTS.map(([label, ask, words, drawn]) => (
					<div key={label} className="flex min-w-0 flex-col gap-1.5">
						<span className="text-meta text-ink-2">{label}</span>
						<DraftApproval
							chat={0}
							agent={{ name: "Iris" }}
							label={words}
							ask={ask}
							wait={`specimen-${label}`}
							drawn={drawn ? <EventCard event={PLANNING} /> : undefined}
						/>
					</div>
				))}
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-meta text-ink-2">Named in a message</span>
					<Bubble mine>
						Move my 1:1 if it clashes with{" "}
						<ObjectLink object={{ ...PLANNING, card: "event" }} href={PLANNING.url ?? ""} />
					</Bubble>
				</div>
			</div>
		</Section>
	);
}
