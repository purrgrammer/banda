/**
 * The connections banda ships (`src/core/definitions.ts`): each shipped definition passes its schema and the checks
 * across its fields; what the old frontmatter parser refused in a shipped file is still refused; a definition reads
 * back as the connection it says; and its version is the hash of its bytes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GITHUB_OBJECTS } from "../scripts/github-objects.ts";
import { type Connection, readItems } from "../src/core/connections.ts";
import { type Definition, readDefinition, readDefinitions } from "../src/core/definitions.ts";
import { FLOORS } from "../src/core/floor.ts";
import { REST_APIS } from "../src/core/rest.ts";
import { SHIPPED } from "../src/server/capabilities.ts";
import { pbtRuns } from "./pbt.ts";

const NAMES = ["calendar", "contacts", "drive", "github", "gmail"];
const text = (name: string) => readFileSync(join(SHIPPED, `${name}.json`), "utf8");
const definition = (name: string) => JSON.parse(text(name)) as Definition;
const errorsOf = (name: string, value: unknown) => {
	const read = readDefinition(name, typeof value === "string" ? value : JSON.stringify(value));
	return "errors" in read ? read.errors : [];
};

describe("the definitions banda ships", () => {
	it("are the five, each passing its schema and its checks, with the line and the access the app shows", () => {
		expect(
			readdirSync(SHIPPED)
				.filter((file) => file.endsWith(".json"))
				.sort(),
		).toEqual(NAMES.map((name) => `${name}.json`));
		const lines: string[] = [];
		const read = readDefinitions(SHIPPED, (line) => lines.push(line));
		expect(lines).toEqual([]);
		expect([...read.keys()].sort()).toEqual(NAMES);
		for (const [name, connection] of read) {
			expect(connection.about, name).toMatch(/^\S/);
			expect(connection.access?.choices.length, name).toBeGreaterThan(0);
		}
		expect(read.get("gmail")?.access).toMatchObject({
			required: "Read email",
			choices: [
				{ label: "Send email", scopes: ["https://www.googleapis.com/auth/gmail.send"] },
				{ label: "Archive, trash, mark read and manage labels" },
			],
		});
		expect(read.get("gmail")?.floors).toEqual({ send_message: "private" });
		expect(read.get("github")?.access?.required).toBeUndefined();
		expect(read.get("github")?.objects).toEqual(
			(readDefinition("github", text("github")) as { connection: Connection }).connection.objects,
		);
		expect(definition("github").objects).toEqual(GITHUB_OBJECTS);
	});

	it("groups its tools in the definition: a tool in two groups is refused, and they are its version's", () => {
		const base = {
			service: "Cal",
			about: "Your days",
			url: "https://cal.example/mcp",
			auth: "none",
			reads: ["list_events"],
		};
		const grouped = readDefinition(
			"cal",
			JSON.stringify({ ...base, groups: { Events: ["list_events", "create_event"] } }),
		);
		expect("connection" in grouped && grouped.connection.groups).toEqual({ Events: ["list_events", "create_event"] });
		const twice = readDefinition(
			"cal",
			JSON.stringify({ ...base, groups: { Events: ["list_events"], Other: ["list_events"] } }),
		);
		expect("errors" in twice && twice.errors).toEqual(['"list_events" is in two groups: keep it in one']);
		expect("errors" in readDefinition("cal", JSON.stringify({ ...base, groups: { Events: [] } }))).toBe(true);
	});

	it("a built-in's required access names what every account of it asks for", () => {
		for (const name of NAMES) {
			const read = readDefinition(name, text(name));
			if ("errors" in read) throw new Error(read.errors.join("; "));
			const { api, access } = read.connection;
			expect(access?.required !== undefined, name).toBe(api !== undefined);
		}
	});

	it("a version is the hash of the bytes: the same bytes the same version, any other byte another", () => {
		const a = readDefinition("gmail", text("gmail"));
		const b = readDefinition("gmail", text("gmail"));
		const spaced = readDefinition("gmail", `${text("gmail")}\n`);
		if ("errors" in a || "errors" in b || "errors" in spaced) throw new Error("gmail does not read");
		expect(a.connection.version).toMatch(/^[0-9a-f]{64}$/);
		expect(a.connection.version).toBe(b.connection.version);
		expect(spaced.connection.version).not.toBe(a.connection.version);
		const { version: _a, ...one } = a.connection;
		const { version: _b, ...other } = spaced.connection;
		expect(other).toEqual(one);
	});

	it("one that does not pass is left out, and said", () => {
		const lines: string[] = [];
		const read = readDefinitions(join(SHIPPED, "..", "nowhere"), (line) => lines.push(line));
		expect(read.size).toBe(0);
		expect(lines).toEqual([]);
	});
});

describe("what a definition may not say", () => {
	const gmail = definition("gmail");

	it("refuses what is not JSON, or not of its schema, whole and with the first error", () => {
		expect(errorsOf("gmail", "---\nservice: Gmail\n---\n")).toEqual(["it is not JSON"]);
		expect(errorsOf("gmail", { ...gmail, body: "Why." })).toEqual([
			expect.stringMatching(/^it does not fit its schema: /),
		]);
		// an address and a command: a definition has no command at all
		expect(errorsOf("gmail", { ...gmail, command: "node x" })).toHaveLength(1);
		expect(errorsOf("gmail", { ...gmail, auth: "magic" })).toHaveLength(1);
		expect(errorsOf("gmail", { ...gmail, about: undefined })).toHaveLength(1);
		expect(errorsOf("gmail", { ...gmail, scopes: ["a scope"] })).toHaveLength(1);
		expect(errorsOf("gmail", { ...gmail, account: "get_profile" })).toHaveLength(1);
		expect(errorsOf("gmail", { ...gmail, ask: "sometimes" })).toHaveLength(1);
		expect(errorsOf("gmail", { ...gmail, needs: { send_message: [] } })).toHaveLength(1);
		expect(errorsOf("gmail", { ...gmail, floors: { fun: ["send_message"] } })).toHaveLength(1);
		expect(errorsOf("gmail", { ...gmail, reads: ["get_profile", "get_profile"] })).toHaveLength(1);
		expect(errorsOf("gmail", { ...gmail, access: { ...gmail.access, extra: true } })).toHaveLength(1);
	});

	it("refuses a character nobody sees, written or escaped", () => {
		expect(errorsOf("gmail", text("gmail").replace("Read and send email", "Read and send‮ email"))).toEqual([
			expect.stringContaining("U+202E"),
		]);
		expect(errorsOf("gmail", text("gmail").replace("Read and send email", "Read and send\\u202e email"))).toEqual([
			expect.stringContaining("U+202E"),
		]);
	});

	it("refuses an address that is not https, and a built-in API at another address, client or scope", () => {
		expect(errorsOf("gmail", { ...gmail, url: "http://example.com/mcp", api: undefined })).toEqual([
			'"url: http://example.com/mcp" is not an https address',
			"a required access is the scopes every account asks for, which only a built-in API has",
		]);
		expect(errorsOf("gmail", { ...gmail, url: "https://example.com/gmail" })[0]).toMatch(/^a built-in API is one of/);
		expect(errorsOf("gmail", { ...gmail, client: "banda-app" })[0]).toMatch(
			/^Gmail uses OAuth client "google", asks for https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly/,
		);
		expect(errorsOf("gmail", { ...gmail, scopes: [...(gmail.scopes ?? []), "admin"] })).not.toEqual([]);
		expect(errorsOf("gmail", { ...gmail, needs: { send_message: ["https://mail.google.com/"] } })).toContainEqual(
			expect.stringMatching(/^Gmail's tools may need only .*: drop https:\/\/mail\.google\.com\/$/),
		);
	});

	it("refuses a read on the floor, a read with its own rules, a rule by prefix, and a tool under two floors", () => {
		expect(errorsOf("gmail", { ...gmail, floors: { private: ["send_message", "get_profile"] } })).toEqual([
			'"get_profile" is a read and on the floor: a read sends nothing, so drop one',
		]);
		expect(errorsOf("gmail", { ...gmail, reads: [...gmail.reads, "get_profile(id=me)"] })).toEqual([
			'"get_profile" is a read already: drop its rules, or its name',
		]);
		expect(errorsOf("gmail", { ...gmail, reads: [...gmail.reads, "send_message(to=*)"] })).toEqual([
			'"send_message(to=*)": a rule names the exact value it reads for, not a prefix',
		]);
		expect(errorsOf("gmail", { ...gmail, reads: [...gmail.reads, "send_message(to)"] })).toHaveLength(1);
		expect(
			errorsOf("gmail", {
				...gmail,
				reads: [...gmail.reads, "mailbox_trash(id=x)"],
				floors: { private: ["send_message", "mailbox_trash"] },
			}),
		).toEqual(['"mailbox_trash" reads for some arguments and is on the floor: it asks every time, so drop its rules']);
		expect(errorsOf("gmail", { ...gmail, floors: { money: ["send_message"], private: ["send_message"] } })).toEqual([
			'"send_message" is under two floors',
		]);
	});

	it("refuses a card whose read is not a read, and kinds the old parser refused", () => {
		const email = gmail.objects?.email;
		if (email === undefined) throw new Error("gmail draws email");
		const objects = (kind: unknown) => ({ ...gmail, objects: { email: kind } });
		expect(
			errorsOf(
				"gmail",
				objects({ ...email, reads: { message: { tool: "send_message", args: { message_id: "{id}" } } } }),
			),
		).toContainEqual(expect.stringContaining("send_message is not among the file's reads, and a card never writes"));
		expect(errorsOf("gmail", objects({ ...email, card: "poster" }))).toHaveLength(1);
		expect(errorsOf("gmail", objects({ ...email, colour: "red" }))).toHaveLength(1);
		expect(errorsOf("gmail", objects({ ...email, ids: ["{a}*"] }))).not.toEqual([]);
		expect(errorsOf("gmail", objects({ ...email, ids: ["gmail/{id}/{id}"] }))).not.toEqual([]);
		expect(errorsOf("gmail", objects({ ...email, fields: { from: "nothing.from" } }))).toContainEqual(
			"objects.email.fields.from is a dotted path that starts with one of its reads' names",
		);
		expect(errorsOf("gmail", objects({ ...email, normalize: { id: "words" } }))).toHaveLength(1);
		expect(errorsOf("gmail", objects({ ...email, follow: { ...email.follow, every: "often" } }))).toContainEqual(
			'objects.email.follow: "every" is a period, such as 30m',
		);
		expect(errorsOf("gmail", objects({ ...email, follow: { ...email.follow, wakes: true } }))).toHaveLength(1);
		expect(
			errorsOf("gmail", objects({ ...email, follow: { ...email.follow, ends: { read: "message unread" } } })),
		).not.toEqual([]);
	});

	it("refuses an access choice beyond what an account may ask for, and a required access without a built-in", () => {
		const access = gmail.access;
		if (access === undefined) throw new Error("gmail has choices");
		expect(
			errorsOf("gmail", {
				...gmail,
				access: { ...access, choices: [{ label: "Everything", scopes: ["https://mail.google.com/"] }] },
			}),
		).toEqual(['the access choice "Everything" asks for https://mail.google.com/, which no account of it may ask for']);
		const github = definition("github");
		expect(errorsOf("github", { ...github, access: { ...github.access, required: "Repositories" } })).toEqual([
			"a required access is the scopes every account asks for, which only a built-in API has",
		]);
	});
});

describe("a definition", () => {
	/** A definition as the connection it reads as says it: what a round trip must give back. */
	const definitionOf = (connection: Connection): Definition => {
		const floors: { [floor: string]: string[] } = {};
		for (const [tool, floor] of Object.entries(connection.floors)) floors[floor] = [...(floors[floor] ?? []), tool];
		return {
			service: connection.service,
			about: connection.about as string,
			url: connection.url as string,
			auth: connection.auth,
			...(connection.client === undefined ? {} : { client: connection.client }),
			...(connection.scopes === undefined ? {} : { scopes: [...connection.scopes] }),
			...(connection.access === undefined ? {} : { access: connection.access as Definition["access"] }),
			...(connection.ask === undefined ? {} : { ask: connection.ask }),
			...(Object.keys(floors).length === 0 ? {} : { floors }),
			...(connection.account === undefined
				? {}
				: { account: `${connection.account.tool}.${connection.account.field}` }),
			reads: readItems(connection),
			...(connection.needs === undefined ? {} : { needs: connection.needs as { [tool: string]: string[] } }),
		};
	};
	const tool = fc.stringMatching(/^[a-z][a-z_]{0,15}$/);
	const scope = fc.stringMatching(/^[a-z][a-z:._]{0,15}$/);
	const words = fc.stringMatching(/^[A-Z][a-z ]{0,30}[a-z]$/);
	const generated = fc
		.record({
			service: words,
			about: words,
			host: fc.stringMatching(/^[a-z]{1,10}$/),
			tools: fc.uniqueArray(tool, { minLength: 1, maxLength: 12 }),
			scopes: fc.uniqueArray(scope, { minLength: 1, maxLength: 4 }),
			reads: fc.integer({ min: 0, max: 12 }),
			floor: fc.constantFrom(...FLOORS),
			floored: fc.integer({ min: 0, max: 12 }),
			rule: fc.option(fc.stringMatching(/^[a-z]{1,8}$/), { nil: undefined }),
			ask: fc.boolean(),
			account: fc.boolean(),
			needs: fc.boolean(),
			access: fc.option(fc.record({ label: words, note: words }), { nil: undefined }),
		})
		.map((g): Definition => {
			const reads = g.tools.slice(0, g.reads);
			const rest = g.tools.slice(g.reads);
			const floored = rest.slice(0, g.floored);
			const ruled = g.rule === undefined ? undefined : rest[floored.length];
			return {
				service: g.service,
				about: g.about,
				url: `https://${g.host}.example/mcp`,
				auth: "oauth",
				scopes: g.scopes,
				...(g.access === undefined
					? {}
					: { access: { choices: [{ label: g.access.label, scopes: g.scopes.slice(0, 1) }], note: g.access.note } }),
				...(g.ask ? { ask: "always" as const } : {}),
				...(floored.length === 0 ? {} : { floors: { [g.floor]: floored } }),
				...(g.account && reads[0] !== undefined ? { account: `${reads[0]}.login` } : {}),
				reads: [...reads, ...(ruled === undefined ? [] : [`${ruled}(id=${g.rule})`])],
				...(g.needs ? { needs: Object.fromEntries(g.tools.map((each) => [each, g.scopes.slice(0, 1)])) } : {}),
			};
		});

	it("reads back as the connection it says, and says it again whole", () => {
		fc.assert(
			fc.property(generated, (value) => {
				const read = readDefinition("example", JSON.stringify(value));
				if ("errors" in read) throw new Error(read.errors.join("; "));
				expect(definitionOf(read.connection)).toEqual(value);
			}),
			{ numRuns: pbtRuns(100) },
		);
	});

	it("never throws, whatever it holds", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				expect(() => readDefinition("example", JSON.stringify(value))).not.toThrow();
			}),
			{ numRuns: pbtRuns(100) },
		);
		fc.assert(
			fc.property(fc.jsonValue(), (objects) => {
				expect(() => readDefinition("gmail", JSON.stringify({ ...definition("gmail"), objects }))).not.toThrow();
			}),
			{ numRuns: pbtRuns(100) },
		);
	});

	it("a built-in API's names match its registry", () => {
		for (const [name, api] of Object.entries(REST_APIS)) {
			const read = readDefinition(name, text(name));
			if ("errors" in read) throw new Error(read.errors.join("; "));
			expect(read.connection).toMatchObject({ api: name, url: api.url, client: "google", service: api.service });
		}
	});
});
