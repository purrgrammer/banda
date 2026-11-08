/**
 * A fake Google for the Contacts connection, as a `fetch`: its sign-in's token endpoint, OpenID's userinfo, and people
 * created, read, changed (against their etag) and deleted as the People API does. With `file`, its people are kept
 * there, written whole before it answers, so a process killed after Google applied a change and before banda
 * recorded it leaves the change applied, as the real one would.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type FakePerson = { [key: string]: unknown };
export type FakeContacts = {
	readonly fetch: typeof fetch;
	/** People by resource name. */
	people(): { [resourceName: string]: FakePerson };
	/** Each request a change made: its method and path. */
	readonly writes: { method: string; path: string; body?: unknown }[];
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeContacts({
	file,
	email = "alice@example.test",
	seed = {},
}: {
	file?: string;
	email?: string;
	seed?: { [resourceName: string]: FakePerson };
} = {}): FakeContacts {
	let memory: { [name: string]: FakePerson } = seed;
	const load = () =>
		file === undefined
			? memory
			: existsSync(file)
				? (JSON.parse(readFileSync(file, "utf8")) as { [name: string]: FakePerson })
				: seed;
	const save = (people: { [name: string]: FakePerson }) => {
		if (file === undefined) memory = people;
		else {
			writeFileSync(`${file}.tmp`, JSON.stringify(people));
			renameSync(`${file}.tmp`, file);
		}
	};
	const writes: FakeContacts["writes"] = [];
	let version = 0;
	const named = (person: FakePerson) => {
		const names = Array.isArray(person.names) ? (person.names as FakePerson[]) : [];
		return names.map((each) => ({
			...each,
			displayName: each.unstructuredName ?? [each.givenName, each.familyName].filter(Boolean).join(" "),
			metadata: { primary: true },
		}));
	};
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
		if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token")
			return json({
				access_token: "fake-contacts-access-token",
				refresh_token: "fake-contacts-refresh-token",
				expires_in: 3600,
				scope:
					"https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/contacts",
			});
		if (url.origin === "https://openidconnect.googleapis.com" && url.pathname === "/v1/userinfo")
			return json({ sub: "1", email });
		if (url.origin !== "https://people.googleapis.com" || !url.pathname.startsWith("/v1/"))
			return json({ error: { code: 404 } }, 404);
		const path = url.pathname.slice("/v1/".length);
		const people = load();
		if (method !== "GET") writes.push({ method, path, ...(body === undefined ? {} : { body }) });
		if (path === "people:createContact" && method === "POST") {
			const resourceName = `people/c${1000 + Object.keys(people).length + ++version}`;
			const person: FakePerson = { ...body, resourceName, etag: `e${version}` };
			people[resourceName] = person;
			save(people);
			return json({ ...person, names: named(person) });
		}
		const match = /^(people\/[^/:]+)(?::(updateContact|deleteContact))?$/.exec(path);
		const person = match === null ? undefined : people[match[1] as string];
		if (match === null || person === undefined) return json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
		if (method === "GET") return json({ ...person, names: named(person) });
		if (match[2] === "deleteContact" && method === "DELETE") {
			delete people[match[1] as string];
			save(people);
			return json({});
		}
		if (match[2] === "updateContact" && method === "PATCH") {
			const mask = (url.searchParams.get("updatePersonFields") ?? "").split(",");
			if ((body as FakePerson | undefined)?.etag !== person.etag)
				return json({ error: { code: 400, status: "FAILED_PRECONDITION" } }, 400);
			for (const field of mask) person[field] = (body as FakePerson)[field];
			person.etag = `e${++version}`;
			save(people);
			return json({ ...person, names: named(person) });
		}
		return json({ error: { code: 405 } }, 405);
	}) as typeof fetch;
	return { fetch: fetcher, people: load, writes };
}
