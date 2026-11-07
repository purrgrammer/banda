---
service: Google Calendar
url: https://www.googleapis.com/calendar/v3
api: calendar
auth: oauth
client: google
scopes: [https://www.googleapis.com/auth/calendar.readonly]
ask: always
account: get_profile.email
reads: [get_profile, list_calendars, list_events, get_event, free_busy]
---
Read your Google Calendar: your calendars, the events in a bounded range of days, one event in full, and when you are
busy. Reference events as `calendar/<id>` in the answer, as list_events returns them, to show their event cards in chat.
The owner starts with read-only access. Creating, changing, answering and deleting events are separate tools that always
ask for approval; they require the owner to add the matching Google scope and sign in again. The daemon keeps
credentials outside the store and the agent's computer.

```json
{
	"needs": {
		"create_event": ["https://www.googleapis.com/auth/calendar.events"],
		"update_event": ["https://www.googleapis.com/auth/calendar.events"],
		"respond_to_event": ["https://www.googleapis.com/auth/calendar.events"],
		"delete_event": ["https://www.googleapis.com/auth/calendar.events"]
	},
	"objects": {
		"event": {
			"card": "event",
			"name": "{id}",
			"ids": ["calendar/{id}"],
			"reads": {
				"event": { "tool": "get_event", "args": { "event_id": "{id}" } }
			},
			"fields": {
				"title": "event.title",
				"start": "event.start",
				"end": "event.end",
				"all_day": "event.allDay",
				"time_zone": "event.timeZone",
				"location": "event.location",
				"organizer": "event.organizer",
				"who": "event.who",
				"attendees": "event.attendees",
				"response": "event.response",
				"status": "event.status",
				"description": "event.description",
				"meet": "event.meet",
				"url": "event.url"
			},
			"writes": [
				{ "tool": "update_event", "id": { "id": "event_id" }, "verb": "Change" },
				{
					"tool": "respond_to_event",
					"id": { "id": "event_id" },
					"verb": "Answer",
					"verbs": [
						{ "when": { "response": "accepted" }, "verb": "Accept" },
						{ "when": { "response": "declined" }, "verb": "Decline" },
						{ "when": { "response": "tentative" }, "verb": "Maybe" }
					]
				},
				{ "tool": "delete_event", "id": { "id": "event_id" }, "verb": "Delete" }
			]
		}
	}
}
```
