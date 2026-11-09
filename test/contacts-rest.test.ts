import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseConnection } from "../src/core/connections.ts";
import {
	CONTACTS_IDEMPOTENT,
	CONTACTS_TOOLS,
	CONTACTS_WRITES,
	contactOfRef,
	contactRef,
	contactsCall,
	contactsDraft,
	contactsExpand,
	contactsWriteCall,
} from "../src/core/contacts-rest.ts";
import { discover } from "../src/core/oauth.ts";
import { cardOf, readArgs, recognise } from "../src/core/objects.ts";
import { REST_APIS, type RestApi } from "../src/core/rest.ts";

const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const call = (fetcher: typeof fetch, name: string, args: Record<string, unknown> = {}, token = "t") =>
	contactsCall(token, name, args, undefined, fetcher);
const FILE = () => readFileSync(new URL("../shipped/connections/contacts.md", import.meta.url), "utf8");
const shipped = () => {
	const parsed = parseConnection("contacts", FILE());
	if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
	return parsed.connection;
};
const urlOf = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index: number) =>
	new URL(String(fetcher.mock.calls[index]?.[0]));

const ANA = {
	resourceName: "people/c111",
	names: [{ displayName: "Ana García", metadata: { primary: true } }],
	emailAddresses: [
		{ value: "ana@work.example", metadata: {} },
		{ value: "ana@home.example", metadata: { primary: true } },
	],
	phoneNumbers: [{ value: "+34 600 000 000" }],
	addresses: [{ formattedValue: "Calle Mayor 1\n28013 Madrid", metadata: { primary: true } }, { formattedValue: " " }],
	organizations: [{ name: "Northstar", title: "Head of Design" }],
};

describe("Google Contacts REST connection", () => {
	it("declares four reads and three changes, each change asking", () => {
		expect(CONTACTS_TOOLS.map((tool) => tool.name)).toEqual([
			"get_profile",
			"search_contacts",
			"search_other_contacts",
			"get_contact",
			"create_contact",
			"update_contact",
			"delete_contact",
		]);
		expect(CONTACTS_TOOLS.filter((tool) => tool.readOnlyHint !== true).map((tool) => tool.name)).toEqual([
			...CONTACTS_WRITES,
		]);
		// adding has no id of the caller's to make a repeat harmless: only the others run again after a crash
		expect(REST_APIS.contacts.idempotent).toBe(CONTACTS_IDEMPOTENT);
		expect(CONTACTS_IDEMPOTENT).not.toContain("create_contact");
		// nothing on a contact's draft is the owner's to edit, so a permission binds every argument
		expect(CONTACTS_TOOLS.flatMap(() => REST_APIS.contacts.drafts.editable())).toEqual([]);
		expect(REST_APIS.contacts.tools).toBe(CONTACTS_TOOLS);
	});

	it("ships a file the registry accepts, with every tool a read, and refuses other scopes", () => {
		const connection = shipped();
		expect(connection).toMatchObject({ api: "contacts", service: "Google Contacts" });
		// reading by default; the write scope is the owner's to add
		expect(connection.scopes).not.toContain("https://www.googleapis.com/auth/contacts");
		expect(REST_APIS.contacts.scopes).toContain("https://www.googleapis.com/auth/contacts");
		expect(connection.reads).toEqual(CONTACTS_TOOLS.filter((tool) => tool.readOnlyHint).map((tool) => tool.name));
		for (const tool of CONTACTS_WRITES)
			expect(connection.needs?.[tool]).toEqual(["https://www.googleapis.com/auth/contacts"]);
		expect(connection.floors).toEqual({});
		expect(connection.objects?.contact?.card).toBe("contact");
		const errors = (from: string, to: string) => {
			const parsed = parseConnection("contacts", FILE().replace(from, to));
			return "errors" in parsed ? parsed.errors.join() : "";
		};
		const google = "https://www.googleapis.com/auth/";
		const scopes = /scopes: \[.*\]/.exec(FILE())?.[0] ?? "";
		expect(errors(scopes, `scopes: [${google}contacts.readonly, ${google}userinfo.email]`)).toBe("");
		// the address that names the account is read under its own scope, so every file asks for it
		expect(errors(scopes, `scopes: [${google}contacts.readonly]`)).toContain("Google Contacts uses OAuth client");
		expect(errors(scopes, `scopes: [${google}contacts.readonly, ${google}userinfo.email, ${google}contacts]`)).toBe("");
		expect(errors(scopes, `scopes: [${google}contacts.readonly, ${google}contacts]`)).toContain(
			"Google Contacts uses OAuth client",
		);
		expect(errors(scopes, `scopes: [${google}contacts.other.readonly]`)).toContain("Google Contacts uses OAuth client");
		expect(errors("url: https://people.googleapis.com/v1", "url: https://people.googleapis.com/v2")).toContain(
			"built-in API",
		);
	});

	it("signs in at Google's fixed endpoints", async () => {
		const fetcher = vi.fn();
		await expect(discover("https://people.googleapis.com/v1", fetcher)).resolves.toMatchObject({
			issuer: "https://accounts.google.com",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("names the account by the address Google's sign-in gives, and says so when it gives none", async () => {
		// the People API refuses people/me's address to a contacts sign-in: the account is read from OpenID's userinfo
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ sub: "1", email: "me@example.test" }));
		expect(JSON.parse((await call(fetcher, "get_profile")).text)).toEqual({ email: "me@example.test" });
		expect(fetcher.mock.calls[0]?.[0]).toBe("https://openidconnect.googleapis.com/v1/userinfo");
		expect(REST_APIS.contacts.account).toEqual({ tool: "get_profile", field: "email" });
		const none = await call(vi.fn<typeof fetch>().mockResolvedValue(response({ sub: "1" })), "get_profile");
		expect(none).toEqual({
			text: "Google did not share the account's address; sign in again and allow it.",
			isError: true,
		});
		// a refusal with no reason code still says Google's status word
		const denied = await call(
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(
					response({ error: { code: 403, message: "x https://a.example", status: "PERMISSION_DENIED" } }, 403),
				),
			"get_profile",
		);
		expect(denied.text).toBe("Google Contacts answered 403 (PERMISSION_DENIED)");
	});

	it("warms Google's search cache before each search, then returns compact people whose refs read them back", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ results: [{ person: { resourceName: "people/c999" } }] }))
			.mockResolvedValueOnce(
				response({
					results: [
						{ person: ANA },
						{ person: { resourceName: "people/c222", emailAddresses: [{ value: "bo@example.test" }] } },
						{ person: { resourceName: "people/../x", names: [{ displayName: "Odd" }] } },
						{ person: {} },
					],
				}),
			)
			.mockResolvedValueOnce(response({ ...ANA, photos: [{ url: "https://lh3.googleusercontent.com/a" }] }));
		const found = JSON.parse((await call(fetcher, "search_contacts", { query: "ana", max_results: 50 })).text);
		const warm = urlOf(fetcher, 0);
		expect(warm.pathname).toBe("/v1/people:searchContacts");
		expect(warm.searchParams.get("query")).toBe("");
		const asked = urlOf(fetcher, 1);
		expect(asked.pathname).toBe("/v1/people:searchContacts");
		expect(Object.fromEntries(asked.searchParams)).toEqual({
			query: "ana",
			readMask: "names,emailAddresses,phoneNumbers,organizations",
			pageSize: "30",
		});
		expect(found.contacts).toEqual([
			{
				ref: "contacts/pc111",
				name: "Ana García",
				emails: ["ana@home.example", "ana@work.example"],
				phones: ["+34 600 000 000"],
				organization: "Northstar",
			},
			{ ref: "contacts/pc222", name: "bo@example.test", emails: ["bo@example.test"], phones: [], organization: "" },
			{ name: "Odd", emails: [], phones: [], organization: "" },
			{ name: "(No name)", emails: [], phones: [], organization: "" },
		]);
		const [match] = recognise(found.contacts[0].ref, [{ name: "contacts", objects: shipped().objects }]);
		expect(match).toMatchObject({ connection: "contacts", kind: "contact" });
		const args = readArgs(shipped().objects?.contact?.reads.contact ?? { tool: "", args: {} }, match!, undefined);
		const person = JSON.parse((await call(fetcher, "get_contact", args)).text);
		expect(urlOf(fetcher, 2).pathname).toBe("/v1/people/c111");
		expect(urlOf(fetcher, 2).searchParams.get("personFields")).toContain("addresses");
		expect(person).toEqual({
			name: "Ana García",
			emails: ["ana@home.example", "ana@work.example"],
			phones: ["+34 600 000 000"],
			addresses: ["Calle Mayor 1, 28013 Madrid"],
			organization: "Northstar",
			title: "Head of Design",
			other: false,
			photo: "https://lh3.googleusercontent.com/a",
			url: "https://contacts.google.com/person/c111",
		});
	});

	it("searches other contacts with the same warm-up, and finds one again by paging through them", async () => {
		const bo = {
			resourceName: "otherContacts/c333",
			names: [{ displayName: "Bo" }],
			emailAddresses: [{ value: "bo@example.test" }],
			photos: [{ url: "https://lh3.googleusercontent.com/default", default: true }],
		};
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({}))
			.mockResolvedValueOnce(response({ results: [{ person: bo }] }))
			.mockResolvedValueOnce(response({ otherContacts: [{ resourceName: "otherContacts/c1" }], nextPageToken: "n2" }))
			.mockResolvedValueOnce(response({ otherContacts: [bo] }));
		const found = JSON.parse((await call(fetcher, "search_other_contacts", { query: "bo" })).text);
		expect(urlOf(fetcher, 0).pathname).toBe("/v1/otherContacts:search");
		expect(urlOf(fetcher, 0).searchParams.get("query")).toBe("");
		expect(urlOf(fetcher, 1).searchParams.get("readMask")).toBe("names,emailAddresses,phoneNumbers");
		expect(urlOf(fetcher, 1).searchParams.get("pageSize")).toBe("10");
		expect(found.contacts).toEqual([
			{ ref: "contacts/oc333", name: "Bo", emails: ["bo@example.test"], phones: [], organization: "" },
		]);
		const person = JSON.parse((await call(fetcher, "get_contact", { contact_id: "oc333" })).text);
		expect(urlOf(fetcher, 2).pathname).toBe("/v1/otherContacts");
		expect(urlOf(fetcher, 3).searchParams.get("pageToken")).toBe("n2");
		expect(person).toMatchObject({ name: "Bo", other: true, photo: "", url: "" });
		const missing = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => response({ otherContacts: [], nextPageToken: "again" }));
		expect((await call(missing, "get_contact", { contact_id: "oc333" })).isError).toBe(true);
		expect(missing).toHaveBeenCalledTimes(5);
	});

	it("refuses bad searches and malformed refs without a request", async () => {
		const fetcher = vi.fn<typeof fetch>();
		for (const args of [
			{},
			{ query: "" },
			{ query: "  " },
			{ query: "x".repeat(101) },
			{ query: "a", max_results: "5" },
		])
			expect((await call(fetcher, "search_contacts", args)).isError).toBe(true);
		for (const bad of ["", "p", "o", "xc1", "pc1/x", "p../x", "pc 1", `p${"x".repeat(201)}`, "contacts/", 42])
			expect((await call(fetcher, "get_contact", { contact_id: bad })).isError).toBe(true);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("maps refs to resource names and back", () => {
		expect(contactRef("people/c1-_x")).toBe("pc1-_x");
		expect(contactRef("otherContacts/c2")).toBe("oc2");
		for (const bad of ["people/", "people/a/b", "contactGroups/c1", "people/c 1", `people/${"x".repeat(201)}`, 1])
			expect(contactRef(bad)).toBeUndefined();
		expect(contactOfRef("contacts/pc1")).toEqual({ kind: "people", part: "c1", resourceName: "people/c1" });
		expect(contactOfRef("oc2")).toEqual({ kind: "otherContacts", part: "c2", resourceName: "otherContacts/c2" });
	});

	it("lets the shared OAuth path refresh a rejected token, and never puts the URL or token in an error", async () => {
		await expect(
			call(vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 })), "get_profile"),
		).rejects.toThrow("Google Contacts did not take the credentials");
		const failing = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("secret-body https://people.googleapis.com/x", { status: 403 }));
		const result = await call(failing, "search_contacts", { query: "ana" }, "private-token");
		expect(result).toEqual({ text: "Google Contacts answered 403", isError: true });
		expect(new Headers(failing.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer private-token");
		const disabled = vi.fn<typeof fetch>().mockResolvedValue(
			response(
				{
					error: {
						code: 403,
						message: "People API has not been used in project 1 https://console.developers.google.com/x",
						details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
					},
				},
				403,
			),
		);
		expect((await call(disabled, "get_profile")).text).toBe(
			"Google Contacts answered 403 (SERVICE_DISABLED): the Google Contacts API is not enabled for banda's Google Cloud project",
		);
		expect((await call(failing, "create_contact")).isError).toBe(true);
		expect((await (REST_APIS.contacts as RestApi).write("t", "create_contact", {})).isError).toBe(true);
	});

	it("draws a contact card from bounded fields", () => {
		const kind = shipped().objects?.contact;
		if (kind === undefined) throw new Error("no contact kind");
		const ref = { connection: "contacts", kind: "contact", values: { id: "pc1" } };
		const card = (contact: Record<string, unknown>) => cardOf(kind, ref, { contact });
		expect(
			card({
				name: "Ana García",
				emails: ["ana@home.example", "ana@work.example"],
				phones: ["+34 600 000 000"],
				organization: "Northstar",
				title: "Head of Design",
				other: false,
				photo: "https://lh3.googleusercontent.com/a",
				url: "https://contacts.google.com/person/c1",
			}),
		).toEqual({
			card: "contact",
			name: "Ana García",
			emails: "ana@home.example, ana@work.example",
			phones: "+34 600 000 000",
			organization: "Northstar",
			title: "Head of Design",
			other: false,
			photo: "https://lh3.googleusercontent.com/a",
			url: "https://contacts.google.com/person/c1",
		});
		// a photo on any other host is fetched by the card, so it is dropped
		expect(card({ name: "Eve", photo: "https://tracker.example/pixel.png" })).not.toHaveProperty("photo");
		expect(card({ name: "Eve", photo: "https://googleusercontent.com.evil.example/a" })).not.toHaveProperty("photo");
		expect(card({ name: "", emails: ["bo@example.test"], other: true, url: "https://contacts.google.com/x" })).toEqual({
			card: "contact",
			name: "bo@example.test",
			emails: "bo@example.test",
			phones: "",
			organization: "",
			title: "",
			other: true,
		});
		expect(card({ name: "", photo: "http://lh3.googleusercontent.com/a" })).toMatchObject({ name: "(No name)" });
		expect(card({ name: "X", photo: "javascript:alert(1)" })).not.toHaveProperty("photo");
		const many = card({ name: "X", emails: Array.from({ length: 50 }, (_, i) => `p${i}@example.test`) });
		expect(many.card === "contact" && many.emails.length).toBe(300);
		expect(() => card({})).toThrow("Incomplete object");
	});
});

describe("Google Contacts changes", () => {
	const write = (fetcher: typeof fetch, name: string, args: Record<string, unknown> = {}) =>
		contactsWriteCall("t", name, args, undefined, fetcher);
	const requests = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) =>
		fetcher.mock.calls.map(([url, init]) => ({
			method: init?.method ?? "GET",
			url: new URL(String(url)),
			body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
		}));
	const PERSON = { ...ANA, etag: "etag1", resourceName: "people/c111" };

	it("adds a contact: one POST of the fields, no id of ours, answering its ref", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ resourceName: "people/c999" }));
		const done = await write(fetcher, "create_contact", {
			given_name: "Ana",
			family_name: "García",
			emails: ["ana@example.test", "ANA@example.test"],
			phones: ["+34 600 000 000"],
			organization: "Northstar",
			title: "Head of Design",
			notes: "Met at the fair\nlikes tea",
		});
		expect(done).toEqual({ text: JSON.stringify({ ok: true, ref: "contacts/pc999" }), isError: false });
		const [only, ...rest] = requests(fetcher);
		expect(rest).toEqual([]);
		expect(only?.method).toBe("POST");
		expect(only?.url.pathname).toBe("/v1/people:createContact");
		expect(only?.body).toEqual({
			names: [{ givenName: "Ana", familyName: "García" }],
			emailAddresses: [{ value: "ana@example.test" }],
			phoneNumbers: [{ value: "+34 600 000 000" }],
			organizations: [{ name: "Northstar", title: "Head of Design" }],
			biographies: [{ value: "Met at the fair\nlikes tea", contentType: "TEXT_PLAIN" }],
		});
	});

	it("adds a contact by one display name", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ resourceName: "people/c9" }));
		await write(fetcher, "create_contact", { name: "Ana García" });
		expect(requests(fetcher)[0]?.body).toEqual({ names: [{ unstructuredName: "Ana García" }] });
	});

	it("refuses a bad change in words before any request", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const bad: [string, Record<string, unknown>, RegExp][] = [
			["create_contact", {}, /name/],
			["create_contact", { emails: ["a@example.test"] }, /name/],
			["create_contact", { name: "  " }, /name/],
			["create_contact", { name: "A", given_name: "B" }, /not both/],
			["create_contact", { name: "A".repeat(201) }, /at most 200/],
			["create_contact", { name: "A\nB" }, /one line/],
			["create_contact", { name: "A", emails: "a@example.test" }, /list/],
			["create_contact", { name: "A", emails: ["nope"] }, /email address/],
			[
				"create_contact",
				{ name: "A", emails: Array.from({ length: 11 }, (_, i) => `a${i}@example.test`) },
				/at most 10/,
			],
			["create_contact", { name: "A", phones: ["call me"] }, /phone number/],
			["create_contact", { name: "A", notes: "x".repeat(2001) }, /at most 2000/],
			["create_contact", { name: "A", organization: 3 }, /company/],
			["update_contact", { name: "A" }, /contacts\/<id>/],
			["update_contact", { contact_id: "oabc", name: "A" }, /saved contact/],
			["update_contact", { contact_id: "pabc" }, /Say what/],
			["update_contact", { contact_id: "pabc", emails: ["bad"] }, /email address/],
			["delete_contact", { contact_id: "../x" }, /contacts\/<id>/],
			["delete_contact", { contact_id: "oabc" }, /saved contact/],
			["send_contact", {}, /not available/],
		];
		for (const [tool, args, words] of bad) {
			const done = await write(fetcher, tool, args);
			expect([tool, done.isError, done.text]).toEqual([tool, true, expect.stringMatching(words)]);
		}
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("changes a contact: reads it, then PATCHes only the fields that differ, with its etag and a mask", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(PERSON))
			.mockResolvedValueOnce(response({ resourceName: "people/c111" }));
		const done = await write(fetcher, "update_contact", {
			contact_id: "contacts/pc111",
			emails: ["ana@home.example", "new@example.test"],
			title: "Director",
			phones: ["+34 600 000 000"],
		});
		expect(JSON.parse(done.text)).toEqual({ ok: true, ref: "contacts/pc111" });
		const [read, patch, ...rest] = requests(fetcher);
		expect(rest).toEqual([]);
		expect(read?.method).toBe("GET");
		expect(read?.url.pathname).toBe("/v1/people/c111");
		expect(read?.url.searchParams.get("personFields")).toBe(
			"names,emailAddresses,phoneNumbers,organizations,biographies",
		);
		expect(patch?.method).toBe("PATCH");
		expect(patch?.url.pathname).toBe("/v1/people/c111:updateContact");
		// the phone already holds the change: it is not in the mask
		expect(patch?.url.searchParams.get("updatePersonFields")).toBe("emailAddresses,organizations");
		expect(patch?.body).toEqual({
			etag: "etag1",
			emailAddresses: [{ value: "ana@home.example" }, { value: "new@example.test" }],
			// the company stays when only the title changes
			organizations: [{ name: "Northstar", title: "Director" }],
		});
	});

	it("keeps the other half of a name, and clears a field with an empty value", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				response({ ...PERSON, names: [{ givenName: "Ana", familyName: "García", metadata: { primary: true } }] }),
			)
			.mockResolvedValueOnce(response({ resourceName: "people/c111" }));
		await write(fetcher, "update_contact", { contact_id: "pc111", given_name: "Anita", phones: [], notes: "" });
		const patch = requests(fetcher)[1];
		expect(patch?.url.searchParams.get("updatePersonFields")).toBe("names,phoneNumbers");
		expect(patch?.body).toEqual({
			etag: "etag1",
			names: [{ givenName: "Anita", familyName: "García" }],
			phoneNumbers: [],
		});
	});

	it("sends nothing when the contact already holds the change", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(PERSON));
		const done = await write(fetcher, "update_contact", {
			contact_id: "pc111",
			name: "Ana García",
			emails: ["ANA@HOME.EXAMPLE", "ana@work.example"],
			organization: "Northstar",
			title: "Head of Design",
			notes: "",
		});
		expect(JSON.parse(done.text)).toEqual({ ok: true, ref: "contacts/pc111" });
		expect(requests(fetcher).map((each) => each.method)).toEqual(["GET"]);
	});

	it("says in words when the contact changed while the change waited, by either of Google's refusals", async () => {
		for (const refusal of [
			response({ error: { code: 400, status: "FAILED_PRECONDITION", message: "https://secret.example/x" } }, 400),
			response({ error: { code: 412 } }, 412),
		]) {
			const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(PERSON)).mockResolvedValueOnce(refusal);
			const done = await write(fetcher, "update_contact", { contact_id: "pc111", title: "Boss" });
			expect(done.isError).toBe(true);
			expect(done.text).toMatch(/changed while this change waited/);
			expect(done.text).not.toMatch(/secret|http|Bearer/);
		}
		// any other 400 is not taken for a stale version
		const other = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(PERSON))
			.mockResolvedValueOnce(response({ error: { status: "INVALID_ARGUMENT" } }, 400));
		expect((await write(other, "update_contact", { contact_id: "pc111", title: "Boss" })).text).toMatch(
			/answered 400 \(INVALID_ARGUMENT\)/,
		);
	});

	it("says a contact is not there, for a change and for a deletion run again", async () => {
		const gone = () => vi.fn<typeof fetch>().mockImplementation(async () => response({ error: { code: 404 } }, 404));
		const changed = await write(gone(), "update_contact", { contact_id: "pc111", title: "Boss" });
		expect(changed).toMatchObject({ isError: true, text: expect.stringMatching(/not there/) });
		const fetcher = gone();
		const done = await write(fetcher, "delete_contact", { contact_id: "contacts/pc111" });
		expect(done.isError).toBe(false);
		expect(JSON.parse(done.text)).toMatchObject({ ok: true, already: expect.stringMatching(/was not there/) });
		expect(requests(fetcher)[0]).toMatchObject({ method: "DELETE" });
		expect(requests(fetcher)[0]?.url.pathname).toBe("/v1/people/c111:deleteContact");
	});

	it("deletes a contact with one DELETE", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		const done = await write(fetcher, "delete_contact", { contact_id: "pc111" });
		expect(JSON.parse(done.text)).toEqual({ ok: true, ref: "contacts/pc111" });
		expect(requests(fetcher)).toHaveLength(1);
	});

	it("never repeats a change by itself, and never puts a URL, body or token in a refusal", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: { code: 503 } }, 503));
		const done = await write(fetcher, "create_contact", { name: "Ana" });
		expect(done.isError).toBe(true);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(done.text).not.toMatch(/https?:|people\.googleapis|\bt\b.*Bearer/);
		await expect(
			write(vi.fn<typeof fetch>().mockResolvedValue(response({}, 401)), "delete_contact", { contact_id: "pc111" }),
		).rejects.toThrow(/did not take the credentials/);
	});

	it("words each draft by the contact's name, or 'this contact'", () => {
		expect(contactsDraft("create_contact", { name: "Ana García" })).toEqual({
			what: "Add “Ana García” to your contacts",
			verb: "Add",
		});
		expect(contactsDraft("create_contact", { given_name: "Ana", family_name: "García" })?.what).toBe(
			"Add “Ana García” to your contacts",
		);
		expect(contactsDraft("update_contact", { contact_id: "pc1", name: "Ana García" })).toEqual({
			what: "Change “Ana García”",
			verb: "Change",
		});
		expect(contactsDraft("update_contact", { contact_id: "pc1", title: "Boss" })?.what).toBe("Change this contact");
		expect(contactsDraft("delete_contact", { contact_id: "pc1" })).toEqual({
			what: "Delete this contact from your contacts",
			verb: "Delete",
		});
		expect(contactsDraft("delete_contact", { contact_id: "pc1", name: "Ana García" })?.what).toBe(
			"Delete “Ana García” from your contacts",
		);
		expect(contactsDraft("get_contact", {})).toBeUndefined();
		expect(contactsExpand("delete_contact", { contact_id: "contacts/pc1" })).toEqual({ contact_id: "pc1" });
	});

	it("draws a changed contact's card from the object's writes", () => {
		const objects = shipped().objects ?? {};
		expect(objects.contact?.writes?.map((each) => each.tool)).toEqual(["update_contact", "delete_contact"]);
	});
});
