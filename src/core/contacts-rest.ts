/** A bounded, read-only Google Contacts (People API) surface. Tokens are supplied per call by the daemon and never enter a box. */
import { googleRequest } from "./google-rest.ts";
import { type McpResult, type McpTool, Unauthorized } from "./mcp.ts";

const PEOPLE = { service: "Google Contacts", base: "https://people.googleapis.com/v1" };
/** Who signed in: the People API refuses people/me's address to a contacts sign-in; OpenID's userinfo gives it. */
const OPENID = { service: "Google Contacts", base: "https://openidconnect.googleapis.com/v1" };
const LIMIT = 1_000_000;
/** Other contacts have no read of one: get_contact pages through them, at most this many pages of 1000. */
const OTHER_PAGES = 5;
const PART = /^[A-Za-z0-9_-]{1,200}$/;
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
	readOnlyHint: true,
});

const search = {
	query: { type: "string", minLength: 1, maxLength: 100, description: "A name, address, phone number or company" },
	max_results: { type: "integer", minimum: 1, maximum: 30, description: "Default 10" },
};

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
		"Read one person in full: names, addresses, phone numbers, company and job title. Name them in your answer as a link, [its name](contacts/<id>); to show cards, give them in the message's objects.",
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
					const fields = "names,emailAddresses,phoneNumbers,organizations,photos";
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
		return { text: error instanceof Error ? error.message : "Google Contacts could not be read.", isError: true };
	}
}

/** Contacts are only read: nothing here adds, changes or removes a person. */
export async function contactsWriteCall(): Promise<McpResult> {
	return { text: "That Contacts change is not available.", isError: true };
}
