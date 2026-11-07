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
Access is read-only: nothing here creates, answers or changes an event. The daemon keeps credentials outside the store
and the agent's computer.

```json
{
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
			}
		}
	}
}
```
