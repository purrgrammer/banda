import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseConnection } from "../src/core/connections.ts";
import { CONTACTS_TOOLS, contactOfRef, contactRef, contactsCall } from "../src/core/contacts-rest.ts";
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
	organizations: [{ name: "Northstar", title: "Head of Design" }],
};

describe("Google Contacts REST connection", () => {
	it("declares four reads and nothing that writes", () => {
		expect(CONTACTS_TOOLS.map((tool) => tool.name)).toEqual([
			"get_profile",
			"search_contacts",
			"search_other_contacts",
			"get_contact",
		]);
		expect(CONTACTS_TOOLS.every((tool) => tool.readOnlyHint === true)).toBe(true);
		expect(REST_APIS.contacts.tools).toBe(CONTACTS_TOOLS);
	});

	it("ships a file the registry accepts, with every tool a read, and refuses other scopes", () => {
		const connection = shipped();
		expect(connection).toMatchObject({ api: "contacts", service: "Google Contacts" });
		expect(connection.scopes).toEqual(REST_APIS.contacts.scopes);
		expect(connection.reads).toEqual(CONTACTS_TOOLS.map((tool) => tool.name));
		expect(connection.objects?.contact?.card).toBe("contact");
		const errors = (from: string, to: string) => {
			const parsed = parseConnection("contacts", FILE().replace(from, to));
			return "errors" in parsed ? parsed.errors.join() : "";
		};
		const google = "https://www.googleapis.com/auth/";
		const scopes = /scopes: \[.*\]/.exec(FILE())?.[0] ?? "";
		expect(errors(scopes, `scopes: [${google}contacts.readonly]`)).toBe("");
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

	it("names the account by its primary address, and says so when Google shares none", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			response({
				resourceName: "people/1",
				emailAddresses: [{ value: "old@example.test" }, { value: "me@example.test", metadata: { primary: true } }],
			}),
		);
		expect(JSON.parse((await call(fetcher, "get_profile")).text)).toEqual({ email: "me@example.test" });
		expect(fetcher.mock.calls[0]?.[0]).toBe("https://people.googleapis.com/v1/people/me?personFields=emailAddresses");
		expect(REST_APIS.contacts.account).toEqual({ tool: "get_profile", field: "email" });
		const none = await call(
			vi.fn<typeof fetch>().mockResolvedValue(response({ resourceName: "people/1" })),
			"get_profile",
		);
		expect(none).toEqual({
			text: "Google did not share the account's address; sign in again and allow it.",
			isError: true,
		});
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
		expect(person).toEqual({
			name: "Ana García",
			emails: ["ana@home.example", "ana@work.example"],
			phones: ["+34 600 000 000"],
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
