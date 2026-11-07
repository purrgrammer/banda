import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	CALENDAR_TOOLS,
	CALENDAR_WRITES,
	calendarCall,
	calendarDraft,
	calendarExpand,
	calendarWriteCall,
	createdEventId,
	eventOfRef,
	eventRef,
	whenWords,
} from "../src/core/calendar-rest.ts";
import { parseConnection } from "../src/core/connections.ts";
import { discover } from "../src/core/oauth.ts";
import { cardOf, readArgs, recognise } from "../src/core/objects.ts";
import { REST_APIS, type RestApi } from "../src/core/rest.ts";

const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NOW = Date.parse("2026-11-07T09:00:00Z");
const call = (fetcher: typeof fetch, name: string, args: Record<string, unknown> = {}, token = "t") =>
	calendarCall(token, name, args, undefined, fetcher, () => NOW);
const shipped = () => {
	const parsed = parseConnection(
		"calendar",
		readFileSync(new URL("../shipped/connections/calendar.md", import.meta.url), "utf8"),
	);
	if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
	return parsed.connection;
};

describe("Google Calendar REST connection", () => {
	it("declares five reads and four changes, each change asking", () => {
		expect(CALENDAR_TOOLS.map((tool) => tool.name)).toEqual([
			"get_profile",
			"list_calendars",
			"list_events",
			"get_event",
			"free_busy",
			"create_event",
			"update_event",
			"respond_to_event",
			"delete_event",
		]);
		expect(CALENDAR_TOOLS.filter((tool) => tool.readOnlyHint !== true).map((tool) => tool.name)).toEqual([
			...CALENDAR_WRITES,
		]);
		expect(REST_APIS.calendar.tools).toBe(CALENDAR_TOOLS);
		expect(REST_APIS.calendar.idempotent).toBe(CALENDAR_WRITES);
	});

	it("ships a file the registry accepts, reading by default, its changes needing calendar.events", () => {
		const connection = shipped();
		expect(connection).toMatchObject({
			api: "calendar",
			service: "Google Calendar",
			scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
		});
		expect(connection.reads).toEqual(CALENDAR_TOOLS.filter((tool) => tool.readOnlyHint).map((tool) => tool.name));
		expect(connection.needs).toEqual(
			Object.fromEntries(CALENDAR_WRITES.map((tool) => [tool, ["https://www.googleapis.com/auth/calendar.events"]])),
		);
		expect(connection.objects?.event?.card).toBe("event");
		expect(connection.objects?.event?.writes?.map((write) => [write.tool, write.verb])).toEqual([
			["update_event", "Change"],
			["respond_to_event", "Answer"],
			["delete_event", "Delete"],
		]);
		const text = readFileSync(new URL("../shipped/connections/calendar.md", import.meta.url), "utf8");
		const errors = (from: string, to: string) => {
			const parsed = parseConnection("calendar", text.replace(from, to));
			return "errors" in parsed ? parsed.errors.join() : "";
		};
		const read = "https://www.googleapis.com/auth/calendar.readonly";
		expect(errors(`scopes: [${read}]`, `scopes: [${read}, https://www.googleapis.com/auth/calendar.events]`)).toBe("");
		expect(errors(`scopes: [${read}]`, "scopes: [https://www.googleapis.com/auth/calendar]")).toContain(
			"Google Calendar uses OAuth client",
		);
		expect(
			errors("url: https://www.googleapis.com/calendar/v3", "url: https://www.googleapis.com/calendar/v4"),
		).toContain("built-in API");
	});

	it("signs in at Google's fixed endpoints", async () => {
		const fetcher = vi.fn();
		await expect(discover("https://www.googleapis.com/calendar/v3", fetcher)).resolves.toMatchObject({
			issuer: "https://accounts.google.com",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("names the account by the primary calendar's id", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response({ id: "me@example.test", timeZone: "Europe/Madrid", summary: "Me" }));
		const result = await call(fetcher, "get_profile");
		expect(JSON.parse(result.text)).toEqual({ email: "me@example.test", timeZone: "Europe/Madrid" });
		expect(fetcher.mock.calls[0]?.[0]).toBe("https://www.googleapis.com/calendar/v3/calendars/primary");
		expect(REST_APIS.calendar.account).toEqual({ tool: "get_profile", field: "email" });
	});

	it("lists calendars fifty at a time with their page token", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			response({
				items: [
					{ id: "me@example.test", summary: "Me", primary: true, accessRole: "owner", timeZone: "Europe/Madrid" },
					{ id: "bad id with spaces", summary: "Dropped" },
				],
				nextPageToken: "p2",
			}),
		);
		const result = JSON.parse((await call(fetcher, "list_calendars", { page_token: "p1" })).text);
		expect(result).toEqual({
			calendars: [
				{ id: "me@example.test", summary: "Me", primary: true, accessRole: "owner", timeZone: "Europe/Madrid" },
			],
			nextPageToken: "p2",
		});
		const url = new URL(String(fetcher.mock.calls[0]?.[0]));
		expect(url.pathname).toBe("/calendar/v3/users/me/calendarList");
		expect(url.searchParams.get("maxResults")).toBe("50");
		expect(url.searchParams.get("pageToken")).toBe("p1");
	});

	it("lists the next seven days of the primary calendar by default, expanded and in order", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [] }));
		await call(fetcher, "list_events");
		const url = new URL(String(fetcher.mock.calls[0]?.[0]));
		expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			singleEvents: "true",
			orderBy: "startTime",
			timeMin: "2026-11-07T09:00:00.000Z",
			timeMax: "2026-11-14T09:00:00.000Z",
			maxResults: "25",
		});
	});

	it("refuses ranges that are backwards, too long or not RFC 3339 before asking Google", async () => {
		const fetcher = vi.fn<typeof fetch>();
		for (const args of [
			{ time_min: "2026-11-07T10:00:00Z", time_max: "2026-11-07T10:00:00Z" },
			{ time_min: "2026-11-08T10:00:00Z", time_max: "2026-11-07T10:00:00Z" },
			{ time_min: "2026-01-01T00:00:00Z", time_max: "2027-01-03T00:00:00Z" },
			{ time_min: "2026-11-07" },
			{ time_min: "2026-11-07T10:00:00" },
			{ query: "x".repeat(201) },
			{ calendar_id: "has space" },
			{ calendar_id: "x".repeat(255) },
			{ calendar_id: ".." },
			{ page_token: "x".repeat(2049) },
		]) {
			const result = await call(fetcher, "list_events", args);
			expect(result.isError).toBe(true);
		}
		expect(fetcher).not.toHaveBeenCalled();
		await call(fetcher.mockResolvedValue(response({ items: [] })), "list_events", {
			time_min: "2026-01-01T00:00:00+01:00",
			time_max: "2027-01-01T00:00:00+01:00",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("returns compact events whose refs read the same event back", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				response({
					items: [
						{
							id: "abc123_20261109T100000Z",
							summary: "Design review",
							start: { dateTime: "2026-11-09T11:00:00+01:00" },
							end: { dateTime: "2026-11-09T12:00:00+01:00" },
							location: "Room 4",
							status: "confirmed",
							attendees: [{ email: "me@example.test", self: true, responseStatus: "tentative" }],
						},
						{ id: "allday1", start: { date: "2026-11-10" }, end: { date: "2026-11-12" } },
					],
					nextPageToken: "more",
				}),
			)
			.mockResolvedValueOnce(response({ id: "abc123_20261109T100000Z", summary: "Design review" }));
		const listed = JSON.parse(
			(await call(fetcher, "list_events", { calendar_id: "team@group.calendar.google.com" })).text,
		);
		expect(listed.nextPageToken).toBe("more");
		expect(listed.events[0]).toMatchObject({
			title: "Design review",
			start: "2026-11-09T11:00:00+01:00",
			allDay: false,
			location: "Room 4",
			response: "tentative",
		});
		expect(listed.events[1]).toMatchObject({
			title: "(No title)",
			start: "2026-11-10",
			allDay: true,
			response: "none",
		});
		const ref: string = listed.events[0].ref;
		expect(ref).toMatch(/^calendar\/[A-Za-z0-9_-]+$/);
		const [found] = recognise(ref, [{ name: "calendar", objects: shipped().objects }]);
		expect(found).toMatchObject({ connection: "calendar", kind: "event" });
		const args = readArgs(shipped().objects?.event?.reads.event ?? { tool: "", args: {} }, found!, undefined);
		await call(fetcher, "get_event", args);
		expect(fetcher.mock.calls[1]?.[0]).toBe(
			"https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events/abc123_20261109T100000Z",
		);
	});

	it("pairs a calendar and an event in a ref, and rejects malformed refs without a request", async () => {
		const id = eventRef("en.usa#holiday@group.v.calendar.google.com", "e1");
		expect(id).toBeDefined();
		expect(eventOfRef(id!)).toEqual({ calendarId: "en.usa#holiday@group.v.calendar.google.com", eventId: "e1" });
		expect(eventOfRef(`calendar/${id}`)).toEqual(eventOfRef(id!));
		expect(eventRef("primary", "x".repeat(400))).toBeUndefined();
		const fetcher = vi.fn<typeof fetch>();
		const encode = (raw: string) => Buffer.from(raw, "utf8").toString("base64url");
		for (const bad of [
			"",
			"not base64!",
			encode("primary"),
			encode("primary e1 extra"),
			encode(" e1"),
			encode("primary "),
			encode("primary ../../x"),
			encode(".. e1"),
			encode("pri\nmary e1"),
			`${encode("primary e1")}=`,
			42,
		]) {
			const result = await call(fetcher, "get_event", { event_id: bad });
			expect(result.isError).toBe(true);
		}
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("reads one event in full for its card", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			response({
				id: "e1",
				summary: "Quarterly planning",
				start: { dateTime: "2026-11-09T10:00:00+01:00", timeZone: "Europe/Madrid" },
				end: { dateTime: "2026-11-09T11:30:00+01:00", timeZone: "Europe/Madrid" },
				location: "Northstar HQ",
				organizer: { email: "mira@northstar.example", displayName: "Mira" },
				attendees: [
					{ email: "me@example.test", self: true, responseStatus: "needsAction" },
					{ email: "ana@example.test", displayName: "Ana" },
					{ email: "b@example.test" },
					{ email: "c@example.test" },
					{ email: "d@example.test" },
					{ email: "room@resource.calendar.google.com", resource: true },
				],
				description: "<p>Agenda:</p><ul><li>Dates &amp; owners</li></ul><br>See you",
				hangoutLink: "https://meet.google.com/abc-defg-hij",
				htmlLink: "https://www.google.com/calendar/event?eid=xyz",
				status: "tentative",
			}),
		);
		const event = JSON.parse((await call(fetcher, "get_event", { event_id: eventRef("primary", "e1") })).text);
		expect(event).toEqual({
			title: "Quarterly planning",
			start: "2026-11-09T10:00:00+01:00",
			end: "2026-11-09T11:30:00+01:00",
			allDay: false,
			timeZone: "Europe/Madrid",
			location: "Northstar HQ",
			organizer: "Mira",
			who: "Ana, b@example.test, c@example.test +1",
			attendees: 5,
			response: "needs-action",
			status: "tentative",
			description: "Agenda:\nDates & owners\n\nSee you",
			meet: "https://meet.google.com/abc-defg-hij",
			url: "https://www.google.com/calendar/event?eid=xyz",
		});
	});

	it("asks free/busy with a bounded POST", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			response({
				calendars: {
					primary: { busy: [{ start: "2026-11-09T09:00:00Z", end: "2026-11-09T10:00:00Z" }] },
					"ana@example.test": { busy: [], errors: [{ domain: "global", reason: "notFound" }] },
				},
			}),
		);
		const result = await call(fetcher, "free_busy", {
			time_min: "2026-11-09T00:00:00Z",
			time_max: "2026-11-10T00:00:00Z",
			calendars: ["primary", "ana@example.test"],
		});
		expect(JSON.parse(result.text).calendars).toEqual({
			primary: { busy: [{ start: "2026-11-09T09:00:00Z", end: "2026-11-09T10:00:00Z" }] },
			"ana@example.test": { busy: [], errors: ["notFound"] },
		});
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({
			timeMin: "2026-11-09T00:00:00.000Z",
			timeMax: "2026-11-10T00:00:00.000Z",
			items: [{ id: "primary" }, { id: "ana@example.test" }],
		});
		const refused = vi.fn<typeof fetch>();
		for (const args of [
			{ time_min: "2026-11-01T00:00:00Z", time_max: "2027-01-03T00:00:00Z" },
			{ time_min: "2026-11-01T00:00:00Z" },
			{ time_min: "2026-11-01T00:00:00Z", time_max: "2026-11-02T00:00:00Z", calendars: [] },
			{
				time_min: "2026-11-01T00:00:00Z",
				time_max: "2026-11-02T00:00:00Z",
				calendars: Array.from({ length: 21 }, (_, i) => `c${i}@example.test`),
			},
		])
			expect((await call(refused, "free_busy", args)).isError).toBe(true);
		expect(refused).not.toHaveBeenCalled();
	});

	it("lets the shared OAuth path refresh a rejected token, and never puts the URL or token in an error", async () => {
		await expect(
			call(vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 })), "get_profile"),
		).rejects.toThrow("Google Calendar did not take the credentials");
		const failing = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("secret-body https://www.googleapis.com/x", { status: 403 }));
		const result = await call(failing, "list_events", {}, "private-token");
		expect(result).toEqual({ text: "Google Calendar answered 403", isError: true });
		expect(new Headers(failing.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer private-token");
		const disabled = vi.fn<typeof fetch>().mockResolvedValue(
			response(
				{
					error: {
						code: 403,
						message: "Google Calendar API has not been used in project 1 https://console.developers.google.com/x",
						errors: [{ reason: "accessNotConfigured" }],
						details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
					},
				},
				403,
			),
		);
		expect((await call(disabled, "get_profile")).text).toBe(
			"Google Calendar answered 403 (SERVICE_DISABLED): the Google Calendar API is not enabled for banda's Google Cloud project",
		);
		const odd = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response({ error: { errors: [{ reason: "x https://evil.example/" }] } }, 403));
		expect((await call(odd, "get_profile")).text).toBe("Google Calendar answered 403");
		const unknown = await call(failing, "create_event");
		expect(unknown.isError).toBe(true);
		expect((await (REST_APIS.calendar as RestApi).write("t", "move_event", {})).text).toBe(
			"That Calendar change is not available.",
		);
	});

	it("draws an event card from bounded fields", () => {
		const kind = shipped().objects?.event;
		if (kind === undefined) throw new Error("no event kind");
		const ref = { connection: "calendar", kind: "event", values: { id: "abc" } };
		const card = (event: Record<string, unknown>) => cardOf(kind, ref, { event });
		expect(
			card({
				title: "Offsite",
				start: "2026-11-10",
				end: "2026-11-12",
				allDay: true,
				timeZone: "",
				location: "Lisbon",
				organizer: "me@example.test",
				who: "",
				attendees: 0,
				response: "accepted",
				status: "confirmed",
				description: "Bring layers",
				meet: "javascript:alert(1)",
				url: "http://www.google.com/calendar/event?eid=x",
			}),
		).toEqual({
			card: "event",
			title: "Offsite",
			start: "2026-11-10",
			end: "2026-11-12",
			allDay: true,
			timeZone: "",
			location: "Lisbon",
			organizer: "me@example.test",
			who: "",
			attendees: 0,
			response: "accepted",
			status: "confirmed",
			description: "Bring layers",
		});
		expect(card({ title: "Odd", response: "maybe", status: "gone", attendees: null })).toMatchObject({
			response: "none",
			status: "confirmed",
			attendees: null,
			allDay: false,
		});
		expect(card({ title: "Call", meet: "https://meet.google.com/abc", description: "x".repeat(5000) })).toMatchObject({
			meet: "https://meet.google.com/abc",
			description: "x".repeat(1000),
		});
		expect(() => card({ title: "" })).toThrow("Incomplete object");
	});
});

describe("Google Calendar changes", () => {
	const KEY = "8a7f0c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
	const write = (fetcher: typeof fetch, name: string, args: Record<string, unknown>, key: string | undefined = KEY) =>
		calendarWriteCall("t", name, args, undefined, fetcher, key);
	const sent = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, n = 0) => {
		const [url, init] = fetcher.mock.calls[n] ?? [];
		const at = new URL(String(url));
		return {
			method: init?.method,
			path: at.pathname.replace("/calendar/v3/", ""),
			params: Object.fromEntries(at.searchParams),
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		};
	};
	const event = eventRef("primary", "evt1") as string;

	it("gives a created event an id from the approved effect's key: base32hex, the same for the same key", () => {
		const id = createdEventId(KEY);
		expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
		expect(createdEventId(KEY)).toBe(id);
		expect(createdEventId(`${KEY}x`)).not.toBe(id);
	});

	it("creates an event with guests and a Meet link, as one POST with its id and request id", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			return response({ ...body, hangoutLink: "https://meet.google.com/abc-defg-hij" });
		});
		const result = await write(fetcher, "create_event", {
			title: " Tea ",
			start: "2026-11-09T09:00:00+01:00",
			end: "2026-11-09T10:00:00+01:00",
			time_zone: "Europe/Madrid",
			location: "Café",
			description: "Bring cake",
			attendees: ["ana@example.test", "Ana@example.test", "bo@example.test"],
			add_meet: true,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const id = createdEventId(KEY);
		expect(sent(fetcher)).toEqual({
			method: "POST",
			path: "calendars/primary/events",
			params: { sendUpdates: "all", conferenceDataVersion: "1" },
			body: {
				id,
				summary: "Tea",
				start: { dateTime: "2026-11-09T09:00:00+01:00", timeZone: "Europe/Madrid" },
				end: { dateTime: "2026-11-09T10:00:00+01:00", timeZone: "Europe/Madrid" },
				location: "Café",
				description: "Bring cake",
				attendees: [{ email: "ana@example.test" }, { email: "bo@example.test" }],
				conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: "hangoutsMeet" } } },
			},
		});
		expect(JSON.parse(result.text)).toEqual({
			ok: true,
			ref: `calendar/${eventRef("primary", id)}`,
			meet: "https://meet.google.com/abc-defg-hij",
		});
	});

	it("creates an all-day event on a named calendar, telling no one, with guests edited as text", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async (_url, init) => response(JSON.parse(String(init?.body))));
		const result = await write(fetcher, "create_event", {
			calendar_id: "team@group.calendar.google.com",
			title: "Offsite",
			start: "2026-11-10",
			end: "2026-11-12",
			all_day: true,
			attendees: "ana@example.test,\nbo@example.test",
			location: "",
			description: "",
			send_updates: "none",
		});
		expect(result.isError).toBe(false);
		expect(sent(fetcher)).toMatchObject({
			path: "calendars/team%40group.calendar.google.com/events",
			params: { sendUpdates: "none" },
			body: {
				start: { date: "2026-11-10" },
				end: { date: "2026-11-12" },
				attendees: [{ email: "ana@example.test" }, { email: "bo@example.test" }],
			},
		});
		expect(sent(fetcher).body).not.toHaveProperty("location");
		expect(sent(fetcher).body).not.toHaveProperty("conferenceData");
		expect(sent(fetcher).params).not.toHaveProperty("conferenceDataVersion");
	});

	it("reads back the event its id names when Google says it exists: a repeat after a crash makes no second", async () => {
		const id = createdEventId(KEY);
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ error: { code: 409, errors: [{ reason: "duplicate" }] } }, 409))
			.mockResolvedValueOnce(response({ id, summary: "Tea" }));
		const result = await write(fetcher, "create_event", {
			title: "Tea",
			start: "2026-11-09T09:00:00+01:00",
			end: "2026-11-09T10:00:00+01:00",
		});
		expect(JSON.parse(result.text)).toEqual({ ok: true, ref: `calendar/${eventRef("primary", id)}` });
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(sent(fetcher, 1)).toMatchObject({ method: "GET", path: `calendars/primary/events/${id}` });
	});

	it("never retries a change Google failed, and says why without its URL, body or token", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			response(
				{
					error: {
						message: "Request had insufficient authentication scopes. https://example.test/x private-token",
						details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
					},
				},
				403,
			),
		);
		const result = await calendarWriteCall(
			"private-token",
			"delete_event",
			{ event_id: event },
			undefined,
			fetcher,
			KEY,
		);
		expect(result).toEqual({
			text: "Google Calendar answered 403 (ACCESS_TOKEN_SCOPE_INSUFFICIENT): the sign-in did not grant this access; sign in again and allow it",
			isError: true,
		});
		const busy = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
		expect(
			(
				await write(busy, "create_event", {
					title: "Tea",
					start: "2026-11-09T09:00:00+01:00",
					end: "2026-11-09T10:00:00+01:00",
				})
			).text,
		).toBe("Google Calendar answered 503");
		expect(busy).toHaveBeenCalledTimes(1);
	});

	it("refuses a change that is out of bounds in words, before asking Google", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const base = { title: "Tea", start: "2026-11-09T09:00:00+01:00", end: "2026-11-09T10:00:00+01:00" };
		const cases: [string, Record<string, unknown>, string, string | undefined][] = [
			["create_event", base, "A Calendar change runs only as the owner approved it.", ""],
			["create_event", { ...base, title: "  " }, "Give the event a title.", KEY],
			["create_event", { ...base, end: base.start }, "end must come after start.", KEY],
			["create_event", { ...base, start: "tomorrow" }, "Give start as an RFC 3339", KEY],
			["create_event", { ...base, end: "2027-12-09T10:00:00+01:00" }, "An event lasts at most a year.", KEY],
			["create_event", { ...base, all_day: true }, "as dates", KEY],
			["create_event", { ...base, start: "2026-11-09", end: "2026-11-09", all_day: true }, "after its start", KEY],
			["create_event", { ...base, time_zone: "Mars/Olympus" }, "IANA time zone", KEY],
			["create_event", { ...base, description: "x".repeat(8001) }, "at most 8000 characters", KEY],
			["create_event", { ...base, attendees: ["not an address"] }, "email address", KEY],
			[
				"create_event",
				{ ...base, attendees: Array.from({ length: 51 }, (_, n) => `g${n}@example.test`) },
				"at most 50 guests",
				KEY,
			],
			["create_event", { ...base, send_updates: "some" }, "send_updates", KEY],
			["create_event", { ...base, calendar_id: "a b" }, "valid calendar id", KEY],
			["update_event", { event_id: "nope!", title: "x" }, "calendar/<id> reference", KEY],
			["update_event", { event_id: event }, "Say what to change.", KEY],
			["update_event", { event_id: event, start: base.start }, "start and end together", KEY],
			["respond_to_event", { event_id: event, response: "maybe" }, '"accepted", "declined" or "tentative"', KEY],
			["respond_to_event", { event_id: event, response: "accepted", comment: "x".repeat(501) }, "500", KEY],
			["delete_event", { event_id: "calendar/!!" }, "calendar/<id> reference", KEY],
		];
		for (const [name, args, words, key] of cases) {
			const result = await write(fetcher, name, args, key);
			expect(result.isError, `${name} ${JSON.stringify(args).slice(0, 80)}`).toBe(true);
			expect(result.text).toContain(words);
		}
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("changes only the fields given, keeping the answers of the guests kept, and the owner and organizer", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				response({
					id: "evt1",
					attendees: [
						{ email: "me@example.test", self: true, organizer: true, responseStatus: "accepted" },
						{ email: "ana@example.test", responseStatus: "declined" },
						{ email: "old@example.test", responseStatus: "accepted" },
						{ email: "room@resource.calendar.google.com", resource: true },
					],
				}),
			)
			.mockImplementationOnce(async (_url, init) => response({ id: "evt1", ...JSON.parse(String(init?.body)) }));
		const result = await write(fetcher, "update_event", {
			event_id: event,
			title: "Tea at four",
			start: "2026-11-09T16:00:00+01:00",
			end: "2026-11-09T17:00:00+01:00",
			location: "",
			attendees: "ana@example.test, new@example.test",
			send_updates: "external",
		});
		expect(JSON.parse(result.text)).toEqual({ ok: true, ref: `calendar/${event}` });
		expect(sent(fetcher, 0)).toMatchObject({ method: "GET", path: "calendars/primary/events/evt1" });
		expect(sent(fetcher, 1)).toEqual({
			method: "PATCH",
			path: "calendars/primary/events/evt1",
			params: { sendUpdates: "externalOnly" },
			body: {
				summary: "Tea at four",
				start: { dateTime: "2026-11-09T16:00:00+01:00" },
				end: { dateTime: "2026-11-09T17:00:00+01:00" },
				location: "",
				attendees: [
					{ email: "me@example.test", self: true, organizer: true, responseStatus: "accepted" },
					{ email: "room@resource.calendar.google.com", resource: true },
					{ email: "ana@example.test", responseStatus: "declined" },
					{ email: "new@example.test" },
				],
			},
		});
		const titled = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "evt1" }));
		await write(titled, "update_event", { event_id: `calendar/${event}`, description: "New notes" });
		expect(titled).toHaveBeenCalledTimes(1);
		expect(sent(titled)).toEqual({
			method: "PATCH",
			path: "calendars/primary/events/evt1",
			params: { sendUpdates: "all" },
			body: { description: "New notes" },
		});
	});

	it("answers an invitation as the owner's attendee, telling the organizer, and refuses one not theirs", async () => {
		const invited = {
			id: "evt1",
			attendees: [
				{ email: "boss@example.test", organizer: true, responseStatus: "accepted" },
				{ email: "me@example.test", self: true, responseStatus: "needsAction" },
			],
		};
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(invited))
			.mockImplementationOnce(async (_url, init) => response({ id: "evt1", ...JSON.parse(String(init?.body)) }));
		const result = await write(fetcher, "respond_to_event", {
			event_id: event,
			response: "tentative",
			comment: "May be late",
		});
		expect(result.isError).toBe(false);
		expect(sent(fetcher, 1)).toEqual({
			method: "PATCH",
			path: "calendars/primary/events/evt1",
			params: { sendUpdates: "all" },
			body: {
				attendees: [
					{ email: "boss@example.test", organizer: true, responseStatus: "accepted" },
					{ email: "me@example.test", self: true, responseStatus: "tentative", comment: "May be late" },
				],
			},
		});
		const notMine = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "evt1", attendees: [] }));
		const refused = await write(notMine, "respond_to_event", { event_id: event, response: "accepted" });
		expect(refused).toEqual({
			text: "The owner is not among this event's guests: there is no invitation to answer.",
			isError: true,
		});
		expect(notMine).toHaveBeenCalledTimes(1);
	});

	it("deletes an event, and takes one already gone as deleted", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		expect(JSON.parse((await write(fetcher, "delete_event", { event_id: event, send_updates: "none" })).text)).toEqual({
			ok: true,
			ref: `calendar/${event}`,
		});
		expect(sent(fetcher)).toEqual({
			method: "DELETE",
			path: "calendars/primary/events/evt1",
			params: { sendUpdates: "none" },
			body: undefined,
		});
		for (const status of [404, 410]) {
			const gone = vi.fn<typeof fetch>().mockResolvedValue(response({ error: { code: status } }, status));
			expect((await write(gone, "delete_event", { event_id: event })).isError).toBe(false);
			expect(gone).toHaveBeenCalledTimes(1);
		}
		const other = vi.fn<typeof fetch>().mockResolvedValue(response({ error: { code: 403 } }, 403));
		expect((await write(other, "delete_event", { event_id: event })).isError).toBe(true);
	});

	it("says what each change does in the owner's words, with its button", () => {
		expect(
			calendarDraft("create_event", {
				title: "Tea",
				start: "2026-11-09T09:00:00+01:00",
				end: "2026-11-09T10:00:00+01:00",
				attendees: "ana@example.test, bo@example.test, cy@example.test, di@example.test",
				add_meet: true,
			}),
		).toEqual({
			what: "Create “Tea” on Mon 9 Nov 2026, 09:00–10:00 with ana@example.test, bo@example.test, cy@example.test and 1 more, with a Google Meet link",
			verb: "Create",
		});
		expect(whenWords("2026-11-10", "2026-11-12", true)).toBe("Tue 10 Nov 2026 to Wed 11 Nov 2026, all day");
		expect(whenWords("2026-11-10", "2026-11-11", true)).toBe("Tue 10 Nov 2026, all day");
		expect(whenWords("2026-11-09T23:00:00Z", "2026-11-10T01:00:00Z", false)).toBe(
			"Mon 9 Nov 2026, 23:00 to Tue 10 Nov 2026, 01:00",
		);
		expect(calendarDraft("update_event", { event_id: "x", title: "Tea at four", location: "" })).toEqual({
			what: "Change this event: title to “Tea at four”, no location",
			verb: "Change",
		});
		expect(calendarDraft("respond_to_event", { event_id: "x", response: "declined", comment: "Away" })).toEqual({
			what: "Decline this invitation, saying “Away”",
			verb: "Decline",
		});
		expect(calendarDraft("respond_to_event", { event_id: "x", response: "tentative" })?.verb).toBe("Maybe");
		expect(calendarDraft("delete_event", { event_id: "x", send_updates: "none" })).toEqual({
			what: "Delete this event without telling its guests",
			verb: "Delete",
		});
		expect(calendarDraft("list_events", {})).toBeUndefined();
	});

	it("draws a draft with every field the owner may fill in, the guests as text, and the event by its card's id", () => {
		expect(
			calendarExpand("create_event", {
				title: "Tea",
				start: "a",
				end: "b",
				attendees: ["ana@example.test", "bo@example.test"],
			}),
		).toEqual({
			title: "Tea",
			start: "a",
			end: "b",
			location: "",
			description: "",
			attendees: "ana@example.test, bo@example.test",
		});
		expect(calendarExpand("update_event", { event_id: `calendar/${event}`, title: "x" })).toEqual({
			event_id: event,
			title: "x",
		});
	});
});
