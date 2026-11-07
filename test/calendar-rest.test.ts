import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CALENDAR_TOOLS, calendarCall, eventOfRef, eventRef } from "../src/core/calendar-rest.ts";
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
	it("declares five reads and nothing that writes", () => {
		expect(CALENDAR_TOOLS.map((tool) => tool.name)).toEqual([
			"get_profile",
			"list_calendars",
			"list_events",
			"get_event",
			"free_busy",
		]);
		expect(CALENDAR_TOOLS.every((tool) => tool.readOnlyHint === true)).toBe(true);
		expect(REST_APIS.calendar.tools).toBe(CALENDAR_TOOLS);
	});

	it("ships a file the registry accepts, with every tool a read, and refuses other scopes", () => {
		const connection = shipped();
		expect(connection).toMatchObject({
			api: "calendar",
			service: "Google Calendar",
			scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
		});
		expect(connection.reads).toEqual(CALENDAR_TOOLS.map((tool) => tool.name));
		expect(connection.objects?.event?.card).toBe("event");
		const text = readFileSync(new URL("../shipped/connections/calendar.md", import.meta.url), "utf8");
		const errors = (from: string, to: string) => {
			const parsed = parseConnection("calendar", text.replace(from, to));
			return "errors" in parsed ? parsed.errors.join() : "";
		};
		const read = "https://www.googleapis.com/auth/calendar.readonly";
		expect(errors(`scopes: [${read}]`, `scopes: [${read}, https://www.googleapis.com/auth/calendar.events]`)).toContain(
			"Google Calendar uses OAuth client",
		);
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
		const unknown = await call(failing, "create_event");
		expect(unknown.isError).toBe(true);
		expect((await (REST_APIS.calendar as RestApi).write("t", "create_event", {})).isError).toBe(true);
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
