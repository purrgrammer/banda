/** A bounded, read-only Google Calendar REST surface. Tokens are supplied per call by the daemon and never enter a box. */
import { googleRequest } from "./google-rest.ts";
import { type McpResult, type McpTool, Unauthorized } from "./mcp.ts";

const CALENDAR = { service: "Google Calendar", base: "https://www.googleapis.com/calendar/v3" };
const LIMIT = 1_000_000;
const DAY = 86_400_000;
/** The longest event id a ref carries: a ref is one object id, and those are at most 400 characters. */
const MAX_REF = 400;

const tool = (
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[] = [],
): McpTool => ({
	name,
	description,
	inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
	readOnlyHint: true,
});

const time = (what: string) => ({
	type: "string",
	maxLength: 40,
	description: `${what}, an RFC 3339 date-time with an offset, such as 2026-11-07T09:00:00+01:00`,
});

export const CALENDAR_TOOLS: McpTool[] = [
	tool("get_profile", "Read the signed-in Google account's address and its calendar's time zone.", {}),
	tool(
		"list_calendars",
		"List the calendars the owner can see, with their ids. Use page_token with a returned nextPageToken to continue.",
		{ page_token: { type: "string", minLength: 1, maxLength: 2048 } },
	),
	tool(
		"list_events",
		"List events in a calendar between time_min and time_max (default: the next 7 days, at most 366 days), in start order, recurring events expanded. Returns a ref for each event: include them as calendar/<id> references in your answer so banda can show event cards.",
		{
			calendar_id: { type: "string", minLength: 1, maxLength: 254, description: 'A calendar id; default "primary"' },
			time_min: time("Where the range starts"),
			time_max: time("Where the range ends"),
			query: { type: "string", maxLength: 200, description: "Free text matched against the events" },
			max_results: { type: "integer", minimum: 1, maximum: 50 },
			page_token: { type: "string", minLength: 1, maxLength: 2048 },
		},
	),
	tool(
		"get_event",
		"Read one event: its time, place, organizer, guests, the owner's response, its description and its video call. Include its calendar/<id> reference in your answer so banda shows its card.",
		{
			event_id: {
				type: "string",
				minLength: 1,
				maxLength: MAX_REF,
				description: "The id of a calendar/<id> reference, as list_events returns it",
			},
		},
		["event_id"],
	),
	tool(
		"free_busy",
		"Read when calendars are busy between time_min and time_max (at most 62 days), without the events' details.",
		{
			time_min: time("Where the range starts"),
			time_max: time("Where the range ends"),
			calendars: {
				type: "array",
				maxItems: 20,
				items: { type: "string", minLength: 1, maxLength: 254 },
				description: 'Calendar ids; default ["primary"]',
			},
		},
		["time_min", "time_max"],
	),
];

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
/** A calendar id: printable ASCII with no spaces (an address, `primary`, or `…#holiday@group.v.calendar.google.com`). */
const CALENDAR_ID = /^(?!\.{1,2}$)[\x21-\x7e]{1,254}$/;
/** An event id: Google's base32hex ids, and recurring instances' `<id>_<start>`. */
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;

/** An event's id in banda: its calendar and its id, the way Google's own `eid` pairs them, as one URL-safe word. */
export function eventRef(calendarId: string, eventId: string): string | undefined {
	if (!CALENDAR_ID.test(calendarId) || !EVENT_ID.test(eventId)) return undefined;
	const id = Buffer.from(`${calendarId} ${eventId}`, "utf8").toString("base64url");
	return id.length <= MAX_REF ? id : undefined;
}

export function eventOfRef(id: string): { readonly calendarId: string; readonly eventId: string } | undefined {
	const bare = id.startsWith("calendar/") ? id.slice("calendar/".length) : id;
	if (!/^[A-Za-z0-9_-]{1,400}$/.test(bare)) return undefined;
	const parts = Buffer.from(bare, "base64url").toString("utf8").split(" ");
	const [calendarId = "", eventId = ""] = parts;
	if (parts.length !== 2 || eventRef(calendarId, eventId) !== bare) return undefined;
	return { calendarId, eventId };
}

const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
function instant(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	const at = typeof value === "string" && OFFSET_TIME.test(value) ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(at))
		throw new Error(`Give ${name} as an RFC 3339 date-time with an offset, such as 2026-11-07T09:00:00+01:00.`);
	return at;
}

/** The range a read covers: as given, or a week from what is given, or from now. */
function range(args: Record<string, unknown>, maxDays: number, now: number): { timeMin: string; timeMax: string } {
	const givenMin = instant(args.time_min, "time_min");
	const givenMax = instant(args.time_max, "time_max");
	const min = givenMin ?? (givenMax === undefined ? now : givenMax - 7 * DAY);
	const max = givenMax ?? min + 7 * DAY;
	if (max <= min) throw new Error("time_max must come after time_min.");
	if (max - min > maxDays * DAY) throw new Error(`Read at most ${maxDays} days at a time.`);
	return { timeMin: new Date(min).toISOString(), timeMax: new Date(max).toISOString() };
}

function calendarIdOf(value: unknown): string {
	if (value === undefined) return "primary";
	if (typeof value !== "string" || !CALENDAR_ID.test(value)) throw new Error("Give a valid calendar id.");
	return value;
}

function pageToken(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > 2048)
		throw new Error("Give a valid Calendar page token.");
	return value;
}

function nextPage(answer: Json): { nextPageToken?: string } {
	const next = answer.nextPageToken;
	if (next === undefined) return {};
	if (typeof next !== "string" || next.length === 0 || next.length > 2048)
		throw new Error("Google Calendar returned an invalid page token.");
	return { nextPageToken: next };
}

const when = (value: unknown) => {
	const at = object(value);
	return typeof at.date === "string" ? text(at.date, 40) : text(at.dateTime, 40);
};

const RESPONSES: Record<string, string> = {
	accepted: "accepted",
	declined: "declined",
	tentative: "tentative",
	needsAction: "needs-action",
};

const attendeesOf = (event: Json) => (Array.isArray(event.attendees) ? event.attendees.map(object) : []);
function responseOf(event: Json): string {
	const self = attendeesOf(event).find((each) => each.self === true);
	return self === undefined ? "none" : (RESPONSES[String(self.responseStatus)] ?? "none");
}

const titleOf = (event: Json) => (text(event.summary, 500).trim() === "" ? "(No title)" : text(event.summary, 500));

function compact(event: Json, calendarId: string) {
	const id = typeof event.id === "string" ? eventRef(calendarId, event.id) : undefined;
	return {
		...(id === undefined ? {} : { ref: `calendar/${id}` }),
		title: titleOf(event),
		start: when(event.start),
		end: when(event.end),
		allDay: typeof object(event.start).date === "string",
		location: text(event.location, 500),
		status: text(event.status, 20) || "confirmed",
		response: responseOf(event),
	};
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Google keeps descriptions written in its web app as HTML: the card and the model read them as plain text. */
export function plainDescription(value: unknown, max = 4000): string {
	if (typeof value !== "string") return "";
	return value
		.slice(0, max * 4)
		.replace(/<\s*(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,6});/gi, (entity, name: string) => {
			if (name.startsWith("#")) {
				const point = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
				return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
			}
			return ENTITIES[name.toLowerCase()] ?? entity;
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, max);
}

function meetOf(event: Json): string {
	if (typeof event.hangoutLink === "string") return text(event.hangoutLink, 500);
	const points = Array.isArray(object(event.conferenceData).entryPoints)
		? (object(event.conferenceData).entryPoints as unknown[]).map(object)
		: [];
	return text(points.find((point) => point.entryPointType === "video")?.uri, 500);
}

function full(event: Json) {
	const people = attendeesOf(event).filter((each) => each.resource !== true);
	const others = people.filter((each) => each.self !== true);
	const names = others.map((each) => text(each.displayName, 100) || text(each.email, 250)).filter(Boolean);
	const shown = names.slice(0, 3).join(", ");
	const organizer = object(event.organizer);
	return {
		title: titleOf(event),
		start: when(event.start),
		end: when(event.end),
		allDay: typeof object(event.start).date === "string",
		timeZone: text(object(event.start).timeZone, 100),
		location: text(event.location, 500),
		organizer: text(organizer.displayName, 100) || text(organizer.email, 250),
		who: names.length > 3 ? `${shown} +${names.length - 3}` : shown,
		attendees: event.attendeesOmitted === true ? null : people.length,
		response: responseOf(event),
		status: text(event.status, 20) || "confirmed",
		description: plainDescription(event.description),
		meet: meetOf(event),
		url: text(event.htmlLink, 500),
	};
}

/** Execute one Calendar read. Error text never contains a URL, response body, or token. */
export async function calendarCall(
	token: string,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
	now: () => number = Date.now,
): Promise<McpResult> {
	const request = (path: string, method: "GET" | "POST" = "GET", body?: unknown) =>
		googleRequest(CALENDAR, fetcher, token, path, signal, undefined, method, body);
	try {
		let answer: unknown;
		switch (name) {
			case "get_profile": {
				const primary = object(await request("calendars/primary"));
				answer = { email: text(primary.id, 254), timeZone: text(primary.timeZone, 100) };
				break;
			}
			case "list_calendars": {
				const params = new URLSearchParams({ maxResults: "50" });
				const page = pageToken(args.page_token);
				if (page !== undefined) params.set("pageToken", page);
				const list = object(await request(`users/me/calendarList?${params}`));
				answer = {
					calendars: (Array.isArray(list.items) ? list.items : []).slice(0, 50).flatMap((entry) => {
						const calendar = object(entry);
						if (typeof calendar.id !== "string" || !CALENDAR_ID.test(calendar.id)) return [];
						return [
							{
								id: calendar.id,
								summary: text(calendar.summaryOverride, 300) || text(calendar.summary, 300),
								primary: calendar.primary === true,
								accessRole: text(calendar.accessRole, 30),
								timeZone: text(calendar.timeZone, 100),
							},
						];
					}),
					...nextPage(list),
				};
				break;
			}
			case "list_events": {
				const calendarId = calendarIdOf(args.calendar_id);
				const { timeMin, timeMax } = range(args, 366, now());
				const max = typeof args.max_results === "number" ? Math.max(1, Math.min(50, Math.floor(args.max_results))) : 25;
				const params = new URLSearchParams({
					singleEvents: "true",
					orderBy: "startTime",
					timeMin,
					timeMax,
					maxResults: String(max),
				});
				if (args.query !== undefined) {
					if (typeof args.query !== "string" || args.query.length > 200)
						throw new Error("Give a search of at most 200 characters.");
					if (args.query.trim() !== "") params.set("q", args.query);
				}
				const page = pageToken(args.page_token);
				if (page !== undefined) params.set("pageToken", page);
				const list = object(await request(`calendars/${encodeURIComponent(calendarId)}/events?${params}`));
				answer = {
					timeMin,
					timeMax,
					events: (Array.isArray(list.items) ? list.items : [])
						.slice(0, max)
						.map((each) => compact(object(each), calendarId)),
					...nextPage(list),
				};
				break;
			}
			case "get_event": {
				const ref = typeof args.event_id === "string" ? eventOfRef(args.event_id) : undefined;
				if (ref === undefined) throw new Error("Give the id of a calendar/<id> reference that list_events returned.");
				answer = full(
					object(
						await request(`calendars/${encodeURIComponent(ref.calendarId)}/events/${encodeURIComponent(ref.eventId)}`),
					),
				);
				break;
			}
			case "free_busy": {
				if (args.time_min === undefined || args.time_max === undefined) throw new Error("Give time_min and time_max.");
				const { timeMin, timeMax } = range(args, 62, now());
				const given = args.calendars ?? ["primary"];
				if (!Array.isArray(given) || given.length === 0 || given.length > 20)
					throw new Error("Give between 1 and 20 calendar ids.");
				const ids = [...new Set(given.map(calendarIdOf))];
				const busy = object(await request("freeBusy", "POST", { timeMin, timeMax, items: ids.map((id) => ({ id })) }));
				const calendars = object(busy.calendars);
				answer = {
					timeMin,
					timeMax,
					calendars: Object.fromEntries(
						ids.map((id) => {
							const one = object(Object.hasOwn(calendars, id) ? calendars[id] : undefined);
							const errors = (Array.isArray(one.errors) ? one.errors : [])
								.map((error) => text(object(error).reason, 100))
								.filter(Boolean)
								.slice(0, 5);
							return [
								id,
								{
									busy: (Array.isArray(one.busy) ? one.busy : []).slice(0, 500).map((each) => ({
										start: text(object(each).start, 40),
										end: text(object(each).end, 40),
									})),
									...(errors.length === 0 ? {} : { errors }),
								},
							];
						}),
					),
				};
				break;
			}
			default:
				throw new Error("That Calendar read is not available.");
		}
		const json = JSON.stringify(answer);
		return json.length > LIMIT
			? { text: JSON.stringify({ error: "Calendar result too large; read a shorter range." }), isError: true }
			: { text: json, isError: false };
	} catch (error) {
		if (error instanceof Unauthorized) throw error;
		return { text: error instanceof Error ? error.message : "Google Calendar could not be read.", isError: true };
	}
}

/** Calendar changes are not offered yet: every tool reads. */
export async function calendarWriteCall(): Promise<McpResult> {
	return { text: "That Calendar change is not available.", isError: true };
}
