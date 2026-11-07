/**
 * A bounded Google Calendar REST surface: reads, and the changes the owner approves (create, change, answer, delete).
 * Tokens are supplied per call by the daemon and never enter a box.
 */
import { createHash } from "node:crypto";
import { type GoogleMethod, GoogleRefused, googleRequest } from "./google-rest.ts";
import { type McpResult, type McpTool, Unauthorized } from "./mcp.ts";

const CALENDAR = { service: "Google Calendar", base: "https://www.googleapis.com/calendar/v3" };
const LIMIT = 1_000_000;
const DAY = 86_400_000;
/** The longest event id a ref carries: a ref is one object id, and those are at most 400 characters. */
const MAX_REF = 400;

/** The changes: each always asks the owner, and runs once as approved. */
export const CALENDAR_WRITES = ["create_event", "update_event", "respond_to_event", "delete_event"] as const;

const tool = (
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[] = [],
): McpTool => ({
	name,
	description,
	inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
	readOnlyHint: !(CALENDAR_WRITES as readonly string[]).includes(name),
});

const time = (what: string) => ({
	type: "string",
	maxLength: 40,
	description: `${what}, an RFC 3339 date-time with an offset, such as 2026-11-07T09:00:00+01:00`,
});

const MAX_TITLE = 500;
const MAX_LOCATION = 1000;
const MAX_DESCRIPTION = 8000;
const MAX_COMMENT = 500;
const MAX_GUESTS = 50;

const eventId = {
	type: "string",
	minLength: 1,
	maxLength: MAX_REF,
	description: "The id of a calendar/<id> reference, as list_events returns it",
};
const span = {
	start: {
		type: "string",
		maxLength: 40,
		description:
			"When it starts: an RFC 3339 date-time with an offset (2026-11-09T09:00:00+01:00), or a date (2026-11-09) with all_day",
	},
	end: {
		type: "string",
		maxLength: 40,
		description: "When it ends, as start; for an all-day event, the day after its last day, as Google counts",
	},
	all_day: { type: "boolean", description: "start and end are dates" },
	time_zone: { type: "string", maxLength: 100, description: "An IANA time zone, such as Europe/Madrid" },
};
const attendees = {
	type: "array",
	maxItems: MAX_GUESTS,
	items: { type: "string", minLength: 3, maxLength: 254 },
	description: "Guests' email addresses",
};
const send_updates = {
	type: "string",
	enum: ["all", "external", "none"],
	description: 'Whom Google emails about it: "all" (default), "external" (guests outside the organization) or "none"',
};

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
	tool(
		"create_event",
		"Create an event, with guests and a Google Meet link if asked. The owner approves it first, and may edit it. Returns the new event's calendar/<id> reference.",
		{
			calendar_id: { type: "string", minLength: 1, maxLength: 254, description: 'A calendar id; default "primary"' },
			title: { type: "string", minLength: 1, maxLength: MAX_TITLE },
			...span,
			location: { type: "string", maxLength: MAX_LOCATION },
			description: { type: "string", maxLength: MAX_DESCRIPTION },
			attendees,
			add_meet: { type: "boolean", description: "Add a Google Meet video call" },
			send_updates,
		},
		["title", "start", "end"],
	),
	tool(
		"update_event",
		"Change an event: only the fields given change (start and end together). attendees is the whole new guest list. The owner approves it first, and may edit it.",
		{
			event_id: eventId,
			title: { type: "string", minLength: 1, maxLength: MAX_TITLE },
			...span,
			location: { type: "string", maxLength: MAX_LOCATION },
			description: { type: "string", maxLength: MAX_DESCRIPTION },
			attendees,
			send_updates,
		},
		["event_id"],
	),
	tool(
		"respond_to_event",
		"Answer an invitation as the owner: accepted, declined or tentative (maybe), with an optional note to the organizer. The owner approves it first.",
		{
			event_id: eventId,
			response: { type: "string", enum: ["accepted", "declined", "tentative"] },
			comment: { type: "string", maxLength: MAX_COMMENT, description: "A note to the organizer" },
		},
		["event_id", "response"],
	),
	tool("delete_event", "Delete an event. The owner approves it first.", { event_id: eventId, send_updates }, [
		"event_id",
	]),
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

// ---- changes

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const EMAIL =
	/^[^\s@<>(),;:"[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
const SEND_UPDATES: Record<string, string> = { all: "all", external: "externalOnly", none: "none" };
const ANSWERS = ["accepted", "declined", "tentative"];
const EDITED = ["title", "start", "end", "location", "description", "attendees"] as const;

/**
 * The id a created event is given, from the approved effect's key: a run repeated after a crash asks Google for the
 * same id, and its 409 says the first one was made. Google's ids are 5-1024 characters of base32hex.
 */
export function createdEventId(key: string): string {
	const digest = createHash("sha256").update(`banda calendar event\n${key}`).digest();
	let bits = 0;
	let value = 0;
	let id = "";
	for (const byte of digest) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			id += "0123456789abcdefghijklmnopqrstuv"[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		value &= (1 << bits) - 1;
	}
	return `banda${id}`;
}

const given = (args: Record<string, unknown>, name: string) => args[name] !== undefined && args[name] !== null;

/** Control characters, but for a tab and the ends of lines, which a description may hold. */
const hasControl = (value: string) =>
	[...value].some((char) => {
		const point = char.codePointAt(0) ?? 0;
		return (point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d) || point === 0x7f;
	});

function textArg(args: Record<string, unknown>, name: string, max: number, words: string): string {
	const value = args[name];
	if (typeof value !== "string" || value.length > max || hasControl(value))
		throw new Error(`Give ${words} of at most ${max} characters.`);
	return value;
}

/** The guests, from a list or from text the owner edited (one per line, or separated by commas). */
export function guestsOf(value: unknown): string[] {
	const listed =
		typeof value === "string"
			? value.split(/[\s,;]+/)
			: Array.isArray(value) && value.every((each) => typeof each === "string")
				? (value as string[])
				: undefined;
	if (listed === undefined) throw new Error("Give attendees as a list of email addresses.");
	const seen = new Set<string>();
	const guests: string[] = [];
	for (const raw of listed) {
		const email = raw.trim();
		if (email === "") continue;
		if (email.length > 254 || !EMAIL.test(email)) throw new Error("Give each guest as an email address.");
		if (seen.has(email.toLowerCase())) continue;
		seen.add(email.toLowerCase());
		guests.push(email);
	}
	if (guests.length > MAX_GUESTS) throw new Error(`Invite at most ${MAX_GUESTS} guests.`);
	return guests;
}

/** An event's start and end as Google takes them: dates for an all-day event, else date-times with offsets. */
function spanOf(args: Record<string, unknown>): { start: Json; end: Json } {
	const allDay = args.all_day === true;
	if (args.all_day !== undefined && typeof args.all_day !== "boolean") throw new Error("all_day is true or false.");
	let zone: string | undefined;
	if (given(args, "time_zone")) {
		zone = typeof args.time_zone === "string" ? args.time_zone : "";
		let known = zone.length <= 100 && ZONE.test(zone);
		try {
			if (known) new Intl.DateTimeFormat("en", { timeZone: zone });
		} catch {
			known = false;
		}
		if (!known) throw new Error("Give time_zone as an IANA time zone, such as Europe/Madrid.");
	}
	const start = args.start;
	const end = args.end;
	if (allDay) {
		if (typeof start !== "string" || typeof end !== "string" || !DATE.test(start) || !DATE.test(end))
			throw new Error("Give an all-day event's start and end as dates, such as 2026-11-09.");
		const from = Date.parse(`${start}T00:00:00Z`);
		const to = Date.parse(`${end}T00:00:00Z`);
		if (!Number.isFinite(from) || !Number.isFinite(to))
			throw new Error("Give an all-day event's start and end as dates.");
		if (to <= from) throw new Error("An all-day event's end is the day after its last day: after its start.");
		if (to - from > 366 * DAY) throw new Error("An event lasts at most a year.");
		return { start: { date: start }, end: { date: end } };
	}
	const from = instant(start, "start");
	const to = instant(end, "end");
	if (from === undefined || to === undefined) throw new Error("Give start and end together.");
	if (to <= from) throw new Error("end must come after start.");
	if (to - from > 366 * DAY) throw new Error("An event lasts at most a year.");
	const at = (value: unknown) => ({ dateTime: value as string, ...(zone === undefined ? {} : { timeZone: zone }) });
	return { start: at(start), end: at(end) };
}

function sendUpdatesOf(value: unknown): string {
	if (value === undefined || value === null) return "all";
	const found = typeof value === "string" && Object.hasOwn(SEND_UPDATES, value) ? SEND_UPDATES[value] : undefined;
	if (found === undefined) throw new Error('Give send_updates as "all", "external" or "none".');
	return found;
}

function refOf(value: unknown) {
	const ref = typeof value === "string" ? eventOfRef(value) : undefined;
	if (ref === undefined) throw new Error("Give the id of a calendar/<id> reference that list_events returned.");
	return ref;
}

/** What a change answers: the event's reference, and its video call when it has one. */
function made(calendarId: string, event: Json, fallbackId: string) {
	const id = eventRef(calendarId, typeof event.id === "string" ? event.id : fallbackId);
	const meet = meetOf(event);
	return { ok: true, ...(id === undefined ? {} : { ref: `calendar/${id}` }), ...(meet === "" ? {} : { meet }) };
}

/**
 * Execute one approved Calendar change. `key` is the approved effect's own, the same in a run repeated after a crash:
 * a created event's id comes from it, so a repeat finds the event made and makes no second. A change and a deletion
 * are the same request again, and an event already gone is deleted. Never retried here: Google may have applied it.
 * Error text never contains a URL, response body, or token.
 */
export async function calendarWriteCall(
	token: string,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
	key?: string,
): Promise<McpResult> {
	const request = (path: string, method: GoogleMethod = "GET", body?: unknown) =>
		googleRequest(CALENDAR, fetcher, token, path, signal, undefined, method, body);
	const eventPath = (calendarId: string, id: string) =>
		`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`;
	try {
		let answer: unknown;
		switch (name) {
			case "create_event": {
				if (key === undefined || key === "") throw new Error("A Calendar change runs only as the owner approved it.");
				const calendarId = calendarIdOf(args.calendar_id);
				const title = textArg(args, "title", MAX_TITLE, "a title").trim();
				if (title === "") throw new Error("Give the event a title.");
				const id = createdEventId(key);
				const event: Json = { id, summary: title, ...spanOf(args) };
				if (given(args, "location") && textArg(args, "location", MAX_LOCATION, "a location").trim() !== "")
					event.location = (args.location as string).trim();
				if (given(args, "description") && textArg(args, "description", MAX_DESCRIPTION, "a description").trim() !== "")
					event.description = args.description;
				const guests = given(args, "attendees") ? guestsOf(args.attendees) : [];
				if (guests.length > 0) event.attendees = guests.map((email) => ({ email }));
				if (args.add_meet !== undefined && typeof args.add_meet !== "boolean")
					throw new Error("add_meet is true or false.");
				const meet = args.add_meet === true;
				// the request id, like the event's, is the same in a repeat: Google makes one call for it
				if (meet)
					event.conferenceData = { createRequest: { requestId: id, conferenceSolutionKey: { type: "hangoutsMeet" } } };
				const params = new URLSearchParams({ sendUpdates: sendUpdatesOf(args.send_updates) });
				if (meet) params.set("conferenceDataVersion", "1");
				let created: Json;
				try {
					created = object(
						await request(`calendars/${encodeURIComponent(calendarId)}/events?${params}`, "POST", event),
					);
				} catch (error) {
					// the id is taken: by this change, made before a crash cut its run short
					if (!(error instanceof GoogleRefused) || error.status !== 409) throw error;
					created = object(await request(eventPath(calendarId, id)));
				}
				answer = made(calendarId, created, id);
				break;
			}
			case "update_event": {
				const ref = refOf(args.event_id);
				const change: Json = {};
				if (given(args, "title")) {
					const title = textArg(args, "title", MAX_TITLE, "a title").trim();
					if (title === "") throw new Error("Give the event a title.");
					change.summary = title;
				}
				if (given(args, "start") || given(args, "end") || given(args, "all_day") || given(args, "time_zone"))
					Object.assign(change, spanOf(args));
				if (given(args, "location")) change.location = textArg(args, "location", MAX_LOCATION, "a location").trim();
				if (given(args, "description"))
					change.description = textArg(args, "description", MAX_DESCRIPTION, "a description");
				if (given(args, "attendees")) {
					const guests = guestsOf(args.attendees);
					// the guests kept keep their answers; the owner, the organizer and rooms are never dropped
					const current = attendeesOf(object(await request(eventPath(ref.calendarId, ref.eventId))));
					const kept = current.filter(
						(each) => each.self === true || each.organizer === true || each.resource === true,
					);
					const byEmail = new Map(current.map((each) => [String(each.email).toLowerCase(), each]));
					const listed = guests
						.filter((email) => !kept.some((each) => String(each.email).toLowerCase() === email.toLowerCase()))
						.map((email) => byEmail.get(email.toLowerCase()) ?? { email });
					change.attendees = [...kept, ...listed];
				}
				if (Object.keys(change).length === 0) throw new Error("Say what to change.");
				const params = new URLSearchParams({ sendUpdates: sendUpdatesOf(args.send_updates) });
				const changed = object(await request(`${eventPath(ref.calendarId, ref.eventId)}?${params}`, "PATCH", change));
				answer = made(ref.calendarId, changed, ref.eventId);
				break;
			}
			case "respond_to_event": {
				const ref = refOf(args.event_id);
				if (typeof args.response !== "string" || !ANSWERS.includes(args.response))
					throw new Error('Give response as "accepted", "declined" or "tentative".');
				const comment = given(args, "comment") ? textArg(args, "comment", MAX_COMMENT, "a comment") : undefined;
				const event = object(await request(eventPath(ref.calendarId, ref.eventId)));
				const people = attendeesOf(event);
				if (!people.some((each) => each.self === true))
					throw new Error("The owner is not among this event's guests: there is no invitation to answer.");
				const attendees = people.map((each) =>
					each.self === true
						? { ...each, responseStatus: args.response, ...(comment === undefined ? {} : { comment }) }
						: each,
				);
				// the organizer hears the answer
				const answered = object(
					await request(`${eventPath(ref.calendarId, ref.eventId)}?sendUpdates=all`, "PATCH", { attendees }),
				);
				answer = made(ref.calendarId, answered, ref.eventId);
				break;
			}
			case "delete_event": {
				const ref = refOf(args.event_id);
				const params = new URLSearchParams({ sendUpdates: sendUpdatesOf(args.send_updates) });
				try {
					await request(`${eventPath(ref.calendarId, ref.eventId)}?${params}`, "DELETE");
				} catch (error) {
					// gone already: deleted by this change before a crash cut its run short, or by someone else
					if (!(error instanceof GoogleRefused) || (error.status !== 404 && error.status !== 410)) throw error;
				}
				answer = { ok: true, ref: `calendar/${eventRef(ref.calendarId, ref.eventId)}` };
				break;
			}
			default:
				throw new Error("That Calendar change is not available.");
		}
		return { text: JSON.stringify(answer), isError: false };
	} catch (error) {
		if (error instanceof Unauthorized) throw error;
		return {
			text: error instanceof Error ? error.message : "Google Calendar could not apply the change.",
			isError: true,
		};
	}
}

// ---- the owner's words for a change

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A day as the owner reads it, from its own digits ("Mon 9 Nov 2026"): never moved to another time zone. */
function dayWords(date: string): string | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
	if (match === null) return undefined;
	const [, y, m, d] = match.map(Number) as [number, number, number, number];
	const at = new Date(Date.UTC(y, m - 1, d));
	if (at.getUTCMonth() !== m - 1) return undefined;
	return `${DAYS[at.getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

/** When an event is, as the owner reads it: "Mon 9 Nov 2026, 09:00–10:00", in the time it was given in. */
export function whenWords(start: unknown, end: unknown, allDay: unknown): string {
	if (typeof start !== "string") return "the time given";
	const day = dayWords(start);
	if (day === undefined) return start;
	if (allDay === true || DATE.test(start)) {
		const last = typeof end === "string" && DATE.test(end) ? Date.parse(`${end}T00:00:00Z`) - DAY : Number.NaN;
		const lastDay = Number.isFinite(last) ? dayWords(new Date(last).toISOString().slice(0, 10)) : undefined;
		return lastDay === undefined || lastDay === day ? `${day}, all day` : `${day} to ${lastDay}, all day`;
	}
	const time = (value: string) => /T(\d{2}:\d{2})/.exec(value)?.[1];
	const from = time(start);
	if (from === undefined) return start;
	if (typeof end !== "string" || time(end) === undefined) return `${day}, ${from}`;
	const endDay = dayWords(end);
	return endDay === day ? `${day}, ${from}–${time(end)}` : `${day}, ${from} to ${endDay}, ${time(end)}`;
}

const quoted = (value: string) => `“${value.trim().slice(0, 200)}”`;
function guestWords(value: unknown): string {
	let guests: string[];
	try {
		guests = guestsOf(value);
	} catch {
		return "the guests given";
	}
	if (guests.length === 0) return "no guests";
	const shown = guests.slice(0, 3).join(", ");
	return guests.length > 3 ? `${shown} and ${guests.length - 3} more` : shown;
}

/**
 * What a change does, in the owner's words, and its button: "Create “Tea” on Mon 9 Nov 2026, 09:00–10:00 with ana@…".
 * The change of one event is drawn beside its card, so its words say what changes, not which event.
 */
export function calendarDraft(name: string, args: Record<string, unknown>): { what: string; verb: string } | undefined {
	switch (name) {
		case "create_event": {
			const title = typeof args.title === "string" && args.title.trim() !== "" ? args.title : "an event";
			const guests = given(args, "attendees") && guestWords(args.attendees) !== "no guests";
			return {
				what:
					`Create ${title === "an event" ? title : quoted(title)} on ${whenWords(args.start, args.end, args.all_day)}` +
					(guests ? ` with ${guestWords(args.attendees)}` : "") +
					(args.add_meet === true ? ", with a Google Meet link" : ""),
				verb: "Create",
			};
		}
		case "update_event": {
			const changes: string[] = [];
			if (typeof args.title === "string") changes.push(`title to ${quoted(args.title)}`);
			if (given(args, "start") || given(args, "end"))
				changes.push(`time to ${whenWords(args.start, args.end, args.all_day)}`);
			if (typeof args.location === "string")
				changes.push(args.location.trim() === "" ? "no location" : `location to ${quoted(args.location)}`);
			if (given(args, "description")) changes.push("the description");
			if (given(args, "attendees")) changes.push(`guests to ${guestWords(args.attendees)}`);
			return {
				what: changes.length === 0 ? "Change this event" : `Change this event: ${changes.join(", ")}`,
				verb: "Change",
			};
		}
		case "respond_to_event": {
			const verb = args.response === "accepted" ? "Accept" : args.response === "declined" ? "Decline" : "Maybe";
			const said =
				typeof args.comment === "string" && args.comment.trim() !== "" ? `, saying ${quoted(args.comment)}` : "";
			return {
				what: `${verb === "Maybe" ? "Answer maybe to" : verb} this invitation${said}`,
				verb,
			};
		}
		case "delete_event":
			return {
				what:
					args.send_updates === "none"
						? "Delete this event without telling its guests"
						: "Delete this event and tell its guests",
				verb: "Delete",
			};
		default:
			return undefined;
	}
}

/** The arguments the owner may edit on a change's draft. */
export const calendarEditable = (name: string): readonly string[] =>
	name === "create_event" || name === "update_event" ? EDITED : [];

/**
 * A change's draft as the owner sees it: the guests as text they can edit, and on a new event every field they may
 * fill in, so a draft without a place can be given one.
 */
export function calendarExpand(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const expanded: Record<string, unknown> = { ...args };
	// the event as its card is named: its id, without the reference's `calendar/`
	if (typeof args.event_id === "string" && args.event_id.startsWith("calendar/"))
		expanded.event_id = args.event_id.slice("calendar/".length);
	if (Array.isArray(args.attendees) && args.attendees.every((each) => typeof each === "string"))
		expanded.attendees = (args.attendees as string[]).join(", ");
	if (name === "create_event")
		for (const field of EDITED) if (expanded[field] === undefined || expanded[field] === null) expanded[field] = "";
	return expanded;
}
