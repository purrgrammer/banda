/**
 * A bounded Google Contacts (People API) surface: reads, and the changes the owner approves (add, change, delete).
 * Tokens are supplied per call by the daemon and never enter a box.
 */
import { EMAIL, hasControl } from "./calendar-rest.ts";
import { GoogleError, type GoogleMethod, googleRequest } from "./google-rest.ts";
import { type McpResult, type McpTool, Unauthorized } from "./mcp.ts";
import { retryOf } from "./retry-after.ts";

const PEOPLE = { service: "Google Contacts", base: "https://people.googleapis.com/v1" };
/** Who signed in: the People API refuses people/me's address to a contacts sign-in; OpenID's userinfo gives it. */
const OPENID = { service: "Google Contacts", base: "https://openidconnect.googleapis.com/v1" };
const LIMIT = 1_000_000;
/** Other contacts have no read of one: get_contact pages through them, at most this many pages of 1000. */
const OTHER_PAGES = 5;
const PART = /^[A-Za-z0-9_-]{1,200}$/;
/** The changes: each always asks the owner. Adding is the one that is not idempotent (see contactsWriteCall). */
export const CONTACTS_WRITES = ["create_contact", "update_contact", "delete_contact"] as const;
/** The changes that are the same change when run again: a crash's repeat runs unasked. */
export const CONTACTS_IDEMPOTENT = ["update_contact", "delete_contact"] as const;
const KINDS = { p: "people", o: "otherContacts" } as const;

const tool = (
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[] = [],
): McpTool => ({
	name,
	description,
	inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
	readOnlyHint: !(CONTACTS_WRITES as readonly string[]).includes(name),
});

const search = {
	query: { type: "string", minLength: 1, maxLength: 100, description: "A name, address, phone number or company" },
	max_results: { type: "integer", minimum: 1, maximum: 30, description: "Default 10" },
};

const fieldProperties = {
	name: { type: "string", maxLength: 200, description: "The contact's whole name, as one line" },
	given_name: { type: "string", maxLength: 100, description: "First name; with family_name, instead of name" },
	family_name: { type: "string", maxLength: 100, description: "Last name" },
	emails: { type: "array", items: { type: "string", maxLength: 254 }, maxItems: 10, description: "Email addresses" },
	phones: { type: "array", items: { type: "string", maxLength: 60 }, maxItems: 10, description: "Phone numbers" },
	organization: { type: "string", maxLength: 200, description: "Company" },
	title: { type: "string", maxLength: 200, description: "Job title" },
	notes: { type: "string", maxLength: 2000, description: "Notes about the person" },
};
const changing =
	"Always asks the owner to approve, as a draft that shows what will be set; nothing changes until they do. Answer with the person as a link, [their name](contacts/<id>).";

export const CONTACTS_TOOLS: McpTool[] = [
	tool("get_profile", "Read the signed-in Google account's address.", {}),
	tool(
		"search_contacts",
		"Find people in the owner's saved contacts by name, address, phone number or company, with their addresses and numbers. Returns a ref for each person. Name each in your answer as a link, [its name](contacts/<id>); to show cards, give them in the message's objects.",
		search,
		["query"],
	),
	tool(
		"search_other_contacts",
		"Find people the owner has emailed but not saved as contacts, by name, address or phone number. Returns a ref for each person. Name each in your answer as a link, [its name](contacts/<id>); to show cards, give them in the message's objects.",
		search,
		["query"],
	),
	tool(
		"get_contact",
		"Read one person in full: names, email addresses, phone numbers, postal addresses, company and job title. Name them in your answer as a link, [its name](contacts/<id>); to show cards, give them in the message's objects.",
		{
			contact_id: {
				type: "string",
				minLength: 2,
				maxLength: 201,
				description: "The id of a contacts/<id> reference, as the searches return it",
			},
		},
		["contact_id"],
	),
	tool(
		"create_contact",
		`Add a person to the owner's saved contacts. Give a name (one line, or given_name and family_name) and any of emails, phones, organization, title and notes. ${changing}`,
		fieldProperties,
	),
	tool(
		"update_contact",
		`Change a saved contact. Give only what changes: a field you give replaces that field (emails and phones are the whole list; an empty value clears it). Only a saved contact (an id starting with p) can be changed, not a person from search_other_contacts. ${changing}`,
		{
			contact_id: {
				type: "string",
				minLength: 2,
				maxLength: 201,
				description: "The id of a contacts/<id> reference that search_contacts returned",
			},
			...fieldProperties,
		},
		["contact_id"],
	),
	tool(
		"delete_contact",
		`Delete a saved contact from the owner's contacts. ${changing}`,
		{
			contact_id: {
				type: "string",
				minLength: 2,
				maxLength: 201,
				description: "The id of a contacts/<id> reference that search_contacts returned",
			},
		},
		["contact_id"],
	),
];

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(object) : []);
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

/** A person's id in banda: `p` for a saved contact, `o` for an other contact, then the part after Google's slash. */
export function contactRef(resourceName: unknown): string | undefined {
	if (typeof resourceName !== "string") return undefined;
	const [kind = "", part = "", ...rest] = resourceName.split("/");
	const prefix = kind === "people" ? "p" : kind === "otherContacts" ? "o" : undefined;
	return prefix === undefined || rest.length > 0 || !PART.test(part) ? undefined : `${prefix}${part}`;
}

export function contactOfRef(
	id: string,
): { readonly kind: "people" | "otherContacts"; readonly part: string; readonly resourceName: string } | undefined {
	const bare = id.startsWith("contacts/") ? id.slice("contacts/".length) : id;
	const kind = KINDS[bare[0] as keyof typeof KINDS];
	const part = bare.slice(1);
	if (kind === undefined || !PART.test(part)) return undefined;
	return { kind, part, resourceName: `${kind}/${part}` };
}

/** A field's primary value, else its first. */
const primaryFirst = (values: Json[]) => [
	...values.filter((each) => object(each.metadata).primary === true),
	...values.filter((each) => object(each.metadata).primary !== true),
];
const emailsOf = (person: Json) =>
	primaryFirst(list(person.emailAddresses))
		.map((each) => text(each.value, 254).trim())
		.filter(Boolean)
		.slice(0, 10);
const phonesOf = (person: Json) =>
	primaryFirst(list(person.phoneNumbers))
		.map((each) => text(each.value, 60).trim())
		.filter(Boolean)
		.slice(0, 10);
const addressesOf = (person: Json) =>
	primaryFirst(list(person.addresses))
		.map((each) =>
			text(each.formattedValue, 300)
				.replace(/\s*\n\s*/g, ", ")
				.trim(),
		)
		.filter(Boolean)
		.slice(0, 10);
const nameOf = (person: Json) =>
	text(primaryFirst(list(person.names))[0]?.displayName, 200).trim() || emailsOf(person)[0] || "(No name)";
const organizationOf = (person: Json) => primaryFirst(list(person.organizations))[0] ?? {};

function compact(person: Json) {
	const id = contactRef(person.resourceName);
	return {
		...(id === undefined ? {} : { ref: `contacts/${id}` }),
		name: nameOf(person),
		emails: emailsOf(person),
		phones: phonesOf(person),
		organization: text(organizationOf(person).name, 200),
	};
}

function full(person: Json, other: boolean, part: string) {
	const organization = organizationOf(person);
	const photo = primaryFirst(list(person.photos)).find((each) => each.default !== true);
	return {
		name: nameOf(person),
		emails: emailsOf(person),
		phones: phonesOf(person),
		addresses: addressesOf(person),
		organization: text(organization.name, 200),
		title: text(organization.title, 200),
		other,
		photo: text(photo?.url, 500),
		url: other ? "" : `https://contacts.google.com/person/${part}`,
	};
}

function searchArgs(args: Record<string, unknown>): { query: string; size: number } {
	if (typeof args.query !== "string" || args.query.trim() === "" || args.query.length > 100)
		throw new Error("Give a search of 1 to 100 characters.");
	const size =
		args.max_results === undefined
			? 10
			: typeof args.max_results === "number" && Number.isFinite(args.max_results)
				? Math.max(1, Math.min(30, Math.floor(args.max_results)))
				: Number.NaN;
	if (Number.isNaN(size)) throw new Error("Give max_results as a number from 1 to 30.");
	return { query: args.query, size };
}

/** Execute one Contacts read. Error text never contains a URL, response body, or token. */
export async function contactsCall(
	token: string,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<McpResult> {
	const request = (path: string) => googleRequest(PEOPLE, fetcher, token, path, signal);
	/** Google answers a search from a cache it refreshes on an empty query: one warm-up, its answer unread. */
	const searched = async (path: string, readMask: string, args: Record<string, unknown>) => {
		const { query, size } = searchArgs(args);
		await request(`${path}?${new URLSearchParams({ query: "", readMask: "names", pageSize: "1" })}`);
		const answer = object(await request(`${path}?${new URLSearchParams({ query, readMask, pageSize: String(size) })}`));
		return {
			contacts: list(answer.results)
				.slice(0, size)
				.map((result) => compact(object(result.person))),
		};
	};
	try {
		let answer: unknown;
		switch (name) {
			case "get_profile": {
				const me = object(await googleRequest(OPENID, fetcher, token, "userinfo", signal));
				const email = typeof me.email === "string" && me.email !== "" ? me.email.slice(0, 254) : undefined;
				if (email === undefined)
					throw new Error("Google did not share the account's address; sign in again and allow it.");
				answer = { email };
				break;
			}
			case "search_contacts":
				answer = await searched("people:searchContacts", "names,emailAddresses,phoneNumbers,organizations", args);
				break;
			case "search_other_contacts":
				answer = await searched("otherContacts:search", "names,emailAddresses,phoneNumbers", args);
				break;
			case "get_contact": {
				const ref = typeof args.contact_id === "string" ? contactOfRef(args.contact_id) : undefined;
				if (ref === undefined) throw new Error("Give the id of a contacts/<id> reference that a search returned.");
				if (ref.kind === "people") {
					const fields = "names,emailAddresses,phoneNumbers,addresses,organizations,photos";
					answer = full(object(await request(`${ref.resourceName}?personFields=${fields}`)), false, ref.part);
					break;
				}
				let page: string | undefined;
				for (let pages = 0; pages < OTHER_PAGES && answer === undefined; pages++) {
					const params = new URLSearchParams({
						pageSize: "1000",
						readMask: "names,emailAddresses,phoneNumbers,photos",
					});
					if (page !== undefined) params.set("pageToken", page);
					const listed = object(await request(`otherContacts?${params}`));
					const found = list(listed.otherContacts).find((person) => person.resourceName === ref.resourceName);
					if (found !== undefined) answer = full(found, true, ref.part);
					const next = listed.nextPageToken;
					if (typeof next !== "string" || next === "" || next.length > 2048) break;
					page = next;
				}
				if (answer === undefined) throw new Error("That person is not among the people you have emailed.");
				break;
			}
			default:
				throw new Error("That Contacts read is not available.");
		}
		const json = JSON.stringify(answer);
		return json.length > LIMIT
			? { text: JSON.stringify({ error: "Contacts result too large; ask for fewer people." }), isError: true }
			: { text: json, isError: false };
	} catch (error) {
		if (error instanceof Unauthorized) throw error;
		return {
			text: error instanceof Error ? error.message : "Google Contacts could not be read.",
			isError: true,
			...retryOf(error),
		};
	}
}

// ---- changes

/** Every Person field a change may set; the same names read a person and mask what an update writes. */
const WRITABLE = "names,emailAddresses,phoneNumbers,organizations,biographies";
const MAX_LIST = 10;
const MAX_NAME = 200;
const MAX_PART = 100;
const MAX_PHONE = 60;
const MAX_NOTES = 2000;
const CHANGED =
	"The contact changed while this change waited: read it again, then draft the change anew. Nothing was changed.";

const given = (args: Record<string, unknown>, name: string) => args[name] !== undefined && args[name] !== null;

/** A line of text of at most `max` characters, without control characters; a note may hold line breaks. */
function lineArg(args: Record<string, unknown>, name: string, max: number, words: string, lines = false): string {
	const value = args[name];
	if (typeof value !== "string" || value.length > max || (lines ? hasControl(value) : /\p{Cc}/u.test(value)))
		throw new Error(`Give ${words} of at most ${max} characters${lines ? "" : ", on one line"}.`);
	return value.trim();
}

function listArg(
	args: Record<string, unknown>,
	name: string,
	words: string,
	max: number,
	check: (v: string) => boolean,
) {
	const value = args[name];
	if (!Array.isArray(value) || !value.every((each) => typeof each === "string"))
		throw new Error(`Give ${name} as a list of ${words}.`);
	if (value.length > MAX_LIST) throw new Error(`Give at most ${MAX_LIST} ${words}.`);
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const raw of value as string[]) {
		const each = raw.trim();
		if (each === "") continue;
		if (each.length > max || /\p{Cc}/u.test(each) || !check(each))
			throw new Error(`Give each of ${name} as ${words.replace(/s$/, "")}.`);
		if (seen.has(each.toLowerCase())) continue;
		seen.add(each.toLowerCase());
		kept.push(each);
	}
	return kept;
}

type Wanted = {
	name?: string;
	given?: string;
	family?: string;
	emails?: string[];
	phones?: string[];
	organization?: string;
	title?: string;
	notes?: string;
};

/** The fields of a change, each checked before Google is asked. */
function wantedOf(args: Record<string, unknown>): Wanted {
	const wanted: Wanted = {};
	if (given(args, "name")) wanted.name = lineArg(args, "name", MAX_NAME, "a name");
	if (given(args, "given_name")) wanted.given = lineArg(args, "given_name", MAX_PART, "a first name");
	if (given(args, "family_name")) wanted.family = lineArg(args, "family_name", MAX_PART, "a last name");
	if (wanted.name !== undefined && (wanted.given !== undefined || wanted.family !== undefined))
		throw new Error("Give the name as one line, or as given_name and family_name, not both.");
	if (given(args, "emails"))
		wanted.emails = listArg(args, "emails", "email addresses", 254, (each) => EMAIL.test(each));
	if (given(args, "phones"))
		wanted.phones = listArg(args, "phones", "phone numbers", MAX_PHONE, (each) => /\d/.test(each));
	if (given(args, "organization")) wanted.organization = lineArg(args, "organization", MAX_NAME, "a company");
	if (given(args, "title")) wanted.title = lineArg(args, "title", MAX_NAME, "a job title");
	if (given(args, "notes")) wanted.notes = lineArg(args, "notes", MAX_NOTES, "notes", true);
	return wanted;
}

function idOf(value: unknown): { readonly part: string; readonly resourceName: string } {
	const ref = typeof value === "string" ? contactOfRef(value) : undefined;
	if (ref === undefined) throw new Error("Give the id of a contacts/<id> reference that search_contacts returned.");
	if (ref.kind !== "people")
		throw new Error("Only a saved contact can be changed, not a person you have only emailed.");
	return ref;
}

/** The same addresses, whatever their order or case. */
const sameSet = (have: string[], want: string[]) =>
	have.length === want.length && want.every((each) => have.some((one) => one.toLowerCase() === each.toLowerCase()));

/**
 * The Person fields a change sets, from the person as just read: what each field would become, and only the fields
 * that do not already hold it. An empty result is a change already made.
 */
function changeOf(person: Json, wanted: Wanted): Json {
	const change: Json = {};
	const primary = primaryFirst(list(person.names))[0] ?? {};
	if (wanted.name !== undefined) {
		if (primary.displayName !== wanted.name && primary.unstructuredName !== wanted.name)
			change.names = [{ unstructuredName: wanted.name }];
	} else if (wanted.given !== undefined || wanted.family !== undefined) {
		const givenName = wanted.given ?? text(primary.givenName, MAX_PART);
		const familyName = wanted.family ?? text(primary.familyName, MAX_PART);
		if ((primary.givenName ?? "") !== givenName || (primary.familyName ?? "") !== familyName)
			change.names = [{ givenName, familyName }];
	}
	if (wanted.emails !== undefined) {
		const have = list(person.emailAddresses);
		if (
			!sameSet(
				have.map((each) => text(each.value, 254).trim()),
				wanted.emails,
			)
		)
			change.emailAddresses = wanted.emails.map((value) => {
				const kept = have.find((each) => text(each.value, 254).trim().toLowerCase() === value.toLowerCase());
				return kept?.type === undefined ? { value } : { value, type: kept.type };
			});
	}
	if (wanted.phones !== undefined) {
		const have = list(person.phoneNumbers);
		if (
			!sameSet(
				have.map((each) => text(each.value, MAX_PHONE).trim()),
				wanted.phones,
			)
		)
			change.phoneNumbers = wanted.phones.map((value) => {
				const kept = have.find((each) => text(each.value, MAX_PHONE).trim() === value);
				return kept?.type === undefined ? { value } : { value, type: kept.type };
			});
	}
	if (wanted.organization !== undefined || wanted.title !== undefined) {
		const current = list(person.organizations)[0] ?? {};
		const name = wanted.organization ?? text(current.name, MAX_NAME);
		const title = wanted.title ?? text(current.title, MAX_NAME);
		if ((current.name ?? "") !== name || (current.title ?? "") !== title)
			change.organizations =
				name === "" && title === "" ? [] : [{ ...(name === "" ? {} : { name }), ...(title === "" ? {} : { title }) }];
	}
	if (wanted.notes !== undefined) {
		const current = text(list(person.biographies)[0]?.value, MAX_NOTES);
		if (current !== wanted.notes)
			change.biographies = wanted.notes === "" ? [] : [{ value: wanted.notes, contentType: "TEXT_PLAIN" }];
	}
	return change;
}

/** A refusal that says the person's version moved on: People answers 400 failedPrecondition, or 412. */
const staleVersion = (error: unknown) =>
	error instanceof GoogleError &&
	(error.status === 412 || (error.status === 400 && /PRECONDITION|ETAG|CONFLICT/i.test(error.reason ?? "")));

/**
 * Execute one approved Contacts change. A change to a contact reads the person first and sends nothing when it already
 * holds the change, else sends it with the person's etag, which Google refuses if the person changed since. A deleted
 * contact already gone is said to have been gone. Never retried here: Google may have applied it.
 *
 * Adding is not idempotent, and runs once or not at all: People's createContact takes no id of the caller's, a
 * `clientData` key is stored but searchContacts does not search it (and its cache lags writes by minutes), and a scan
 * of every connection to find it is unbounded. A run a crash cut short is therefore not repeated by banda. Error text
 * never contains a URL, response body, or token.
 */
export async function contactsWriteCall(
	token: string,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<McpResult> {
	const request = (path: string, method: GoogleMethod = "GET", body?: unknown) =>
		googleRequest(PEOPLE, fetcher, token, path, signal, undefined, method, body);
	const made = (person: Json, fallback?: string) => {
		const id = contactRef(person.resourceName) ?? fallback;
		return { ok: true, ...(id === undefined ? {} : { ref: `contacts/${id}` }) };
	};
	try {
		let answer: unknown;
		switch (name) {
			case "create_contact": {
				const wanted = wantedOf(args);
				if (wanted.name === undefined && wanted.given === undefined && wanted.family === undefined)
					throw new Error("Give the contact a name.");
				if ((wanted.name ?? `${wanted.given ?? ""}${wanted.family ?? ""}`) === "")
					throw new Error("Give the contact a name.");
				const person = changeOf({}, wanted);
				const created = object(
					await request(`people:createContact?${new URLSearchParams({ personFields: "names" })}`, "POST", person),
				);
				answer = made(created);
				break;
			}
			case "update_contact": {
				const ref = idOf(args.contact_id);
				const wanted = wantedOf(args);
				if (Object.keys(wanted).length === 0) throw new Error("Say what to change.");
				// every word is checked before Google is asked; the person is then read once, for its fields and its version
				let person: Json;
				try {
					person = object(await request(`${ref.resourceName}?${new URLSearchParams({ personFields: WRITABLE })}`));
				} catch (error) {
					if (error instanceof GoogleError && error.status === 404)
						throw new Error("That contact is not there: it may have been deleted.");
					throw error;
				}
				const change = changeOf(person, wanted);
				if (Object.keys(change).length === 0) {
					answer = made(person, `p${ref.part}`);
					break;
				}
				const etag = typeof person.etag === "string" ? person.etag : undefined;
				if (etag === undefined) throw new Error("Google did not say which version of the contact this is; try again.");
				const params = new URLSearchParams({
					updatePersonFields: Object.keys(change).sort().join(","),
					personFields: "names",
				});
				let changed: Json;
				try {
					changed = object(await request(`${ref.resourceName}:updateContact?${params}`, "PATCH", { etag, ...change }));
				} catch (error) {
					if (staleVersion(error)) throw new Error(CHANGED);
					if (error instanceof GoogleError && error.status === 404)
						throw new Error("That contact is not there: it may have been deleted.");
					throw error;
				}
				answer = made(changed, `p${ref.part}`);
				break;
			}
			case "delete_contact": {
				const ref = idOf(args.contact_id);
				let gone = false;
				try {
					await request(`${ref.resourceName}:deleteContact`, "DELETE");
				} catch (error) {
					// gone already: deleted by this change before a crash cut its run short, or by someone else; said so
					if (!(error instanceof GoogleError) || (error.status !== 404 && error.status !== 410)) throw error;
					gone = true;
				}
				answer = {
					ok: true,
					ref: `contacts/p${ref.part}`,
					...(gone ? { already: "The contact was not there: it was deleted before, or never existed." } : {}),
				};
				break;
			}
			default:
				throw new Error("That Contacts change is not available.");
		}
		return { text: JSON.stringify(answer), isError: false };
	} catch (error) {
		if (error instanceof Unauthorized) throw error;
		return {
			text: error instanceof Error ? error.message : "Google Contacts could not apply the change.",
			isError: true,
		};
	}
}

// ---- the owner's words for a change

const quoted = (value: string) => `“${value.trim().slice(0, 200)}”`;
const nameFrom = (args: Record<string, unknown>): string | undefined => {
	const one = typeof args.name === "string" ? args.name.trim() : "";
	const parts = [args.given_name, args.family_name]
		.filter((each): each is string => typeof each === "string")
		.map((each) => each.trim())
		.filter(Boolean)
		.join(" ");
	return one || parts || undefined;
};

/** What a change does in the owner's words, and its button. The contact's card, drawn above, says who. */
export function contactsDraft(name: string, args: Record<string, unknown>): { what: string; verb: string } | undefined {
	const who = nameFrom(args);
	switch (name) {
		case "create_contact":
			return { what: who === undefined ? "Add a contact" : `Add ${quoted(who)} to your contacts`, verb: "Add" };
		case "update_contact":
			return { what: who === undefined ? "Change this contact" : `Change ${quoted(who)}`, verb: "Change" };
		case "delete_contact":
			return {
				what: who === undefined ? "Delete this contact from your contacts" : `Delete ${quoted(who)} from your contacts`,
				verb: "Delete",
			};
		default:
			return undefined;
	}
}

/** Nothing on a contact's draft is the owner's to edit: they approve what was drafted, or deny and say why. */
export const contactsEditable = (): readonly string[] => [];

/** A change's draft as the owner sees it: the contact as its card is named, without the reference's `contacts/`. */
export function contactsExpand(_name: string, args: Record<string, unknown>): Record<string, unknown> {
	const expanded: Record<string, unknown> = { ...args };
	if (typeof args.contact_id === "string" && args.contact_id.startsWith("contacts/"))
		expanded.contact_id = args.contact_id.slice("contacts/".length);
	return expanded;
}
