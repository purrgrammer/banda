/** Google Calendar's event cards: timed, all-day across days, cancelled, declined, long words, and no description. */
import { Bubble } from "../chat/Feed.tsx";
import { type CalendarEvent, EventCard, ObjectLink } from "../chat/Object.tsx";
import { Section } from "./stage.tsx";

const PLANNING: CalendarEvent = {
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
			meet: "https://zoom.example/j/123456789",
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

export function CalendarSection() {
	return (
		<Section
			id="calendar"
			title="Google Calendar"
			note="Events an agent names, drawn from banda's own reading. Read-only: nothing here answers or changes an event."
		>
			<div className="grid gap-6 lg:grid-cols-2">
				{EVENTS.map(([label, event]) => (
					<div key={label} className="flex min-w-0 flex-col gap-1.5">
						<span className="text-meta text-ink-2">{label}</span>
						<EventCard event={event} />
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
