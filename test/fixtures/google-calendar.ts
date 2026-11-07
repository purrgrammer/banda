/**
 * A fake Google for the Calendar connection, as a `fetch`: its sign-in's token endpoint, the primary calendar's
 * profile, and events created, read, changed and deleted as Google does (a taken id is a 409, a deleted event a 410).
 * With `file`, its events are kept there, written whole before it answers, so a process killed after Google applied a
 * change and before banda recorded it leaves the change applied, as the real one would.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type FakeEvent = { [key: string]: unknown };
export type FakeCalendar = {
	readonly fetch: typeof fetch;
	/** Events by id, deleted ones with status "cancelled". */
	events(): { [id: string]: FakeEvent };
	/** Each request a change made: its method and path. */
	readonly writes: { method: string; path: string; body?: unknown }[];
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeCalendar({
	file,
	email = "alice@example.test",
}: {
	file?: string;
	email?: string;
} = {}): FakeCalendar {
	let memory: { [id: string]: FakeEvent } = {};
	const load = () =>
		file === undefined
			? memory
			: existsSync(file)
				? (JSON.parse(readFileSync(file, "utf8")) as { [id: string]: FakeEvent })
				: {};
	const save = (events: { [id: string]: FakeEvent }) => {
		if (file === undefined) memory = events;
		else {
			writeFileSync(`${file}.tmp`, JSON.stringify(events));
			renameSync(`${file}.tmp`, file);
		}
	};
	const writes: FakeCalendar["writes"] = [];
	let made = 0;
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
		if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token")
			return json({
				access_token: "fake-calendar-access-token",
				refresh_token: "fake-calendar-refresh-token",
				expires_in: 3600,
				scope: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events",
			});
		if (url.origin !== "https://www.googleapis.com" || !url.pathname.startsWith("/calendar/v3/"))
			return json({ error: { code: 404 } }, 404);
		const path = url.pathname.slice("/calendar/v3/".length);
		if (path === "calendars/primary" && method === "GET") return json({ id: email, timeZone: "Europe/Madrid" });
		const match = /^calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
		if (match === null) return json({ error: { code: 404 } }, 404);
		const id = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
		const events = load();
		if (method !== "GET") writes.push({ method, path, ...(body === undefined ? {} : { body }) });
		if (id === undefined && method === "POST") {
			const given = (body ?? {}) as FakeEvent;
			const at = typeof given.id === "string" ? given.id : `made${++made}`;
			if (events[at] !== undefined) return json({ error: { code: 409, errors: [{ reason: "duplicate" }] } }, 409);
			const event: FakeEvent = {
				...given,
				id: at,
				status: "confirmed",
				...(given.conferenceData === undefined ? {} : { hangoutLink: `https://meet.google.com/${at.slice(-10)}` }),
			};
			events[at] = event;
			save(events);
			return json(event);
		}
		const event = id === undefined ? undefined : events[id];
		if (event === undefined) return json({ error: { code: 404 } }, 404);
		if (method === "GET") return json(event);
		if (event.status === "cancelled") return json({ error: { code: 410 } }, 410);
		if (method === "PATCH") {
			Object.assign(event, body);
			save(events);
			return json(event);
		}
		if (method === "DELETE") {
			event.status = "cancelled";
			save(events);
			return new Response(null, { status: 204 });
		}
		return json({ error: { code: 405 } }, 405);
	}) as typeof fetch;
	return { fetch: fetcher, events: load, writes };
}
