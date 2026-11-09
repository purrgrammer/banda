/**
 * The connections banda ships (DESIGN.md "Connections"): one definition each, `shipped/connections/<name>.json` in the
 * release, read once when the daemon starts and never copied into a home. Data, not prose, so it is typed: `Definition`
 * is its schema, checked with the cross-field checks a schema cannot say (`connectionOf`) before a definition counts.
 * Its version is the hash of the bytes read, which everything bound to a connection's version binds to.
 *
 * Whether a shipped connection is on in a home is the store's (`Connected.added`); what it is, is this module's.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { shaOf } from "./agents.ts";
import { type Connection, connectionOf, MAX_DEFINITION_BYTES } from "./connections.ts";
import { FLOORS } from "./floor.ts";
import { CARDS } from "./objects.ts";
import { REST_APIS } from "./rest.ts";
import { hiddenError } from "./visible.ts";

const closed = { additionalProperties: false } as const;
const literals = <const T extends string[]>(values: readonly [...T]) => Type.Enum(values);
const map = <T extends Parameters<typeof Type.Record>[1]>(value: T, key = "^[A-Za-z0-9_.-]{1,64}$") =>
	Type.Record(Type.String({ pattern: key }), value);

const ToolName = Type.String({ pattern: "^[A-Za-z0-9_.-]{1,64}$" });
const Scope = Type.String({ pattern: "^[\\x21\\x23-\\x5b\\x5d-\\x7e]{1,200}$" });
/** A kind's, a read's, a field's or an end's name. */
const Name = "^[a-z][a-z0-9_]{0,63}$";
const Arg = "^[A-Za-z0-9_]{1,64}$";
const Words = Type.String({ pattern: "^[A-Za-z][A-Za-z ]{0,39}$" });

const Read = Type.Object(
	{
		tool: ToolName,
		args: Type.Optional(
			map(
				Type.Union([
					Type.String({ maxLength: 500 }),
					Type.Number(),
					Type.Boolean(),
					Type.Null(),
					Type.Array(Type.String({ pattern: "^[A-Za-z0-9_.-]{1,64}$" }), { maxItems: 32 }),
				]),
				Arg,
			),
		),
		optional: Type.Optional(Type.Boolean()),
		follow: Type.Optional(Type.Boolean()),
	},
	closed,
);

const ArgOf = map(Type.String({ pattern: Arg }), "^[a-z_]{1,32}$");
const When = map(Type.String());

const Write = Type.Object(
	{
		tool: ToolName,
		id: ArgOf,
		verb: Words,
		what: Type.Optional(Words),
		text: Type.Optional(Type.String({ pattern: Name })),
		verbs: Type.Optional(
			Type.Array(Type.Object({ when: When, verb: Words, what: Type.Optional(Words) }, closed), { maxItems: 12 }),
		),
	},
	closed,
);

const Create = Type.Object(
	{
		tool: ToolName,
		when: Type.Optional(When),
		in: ArgOf,
		verb: Words,
		what: Type.String({ maxLength: 200 }),
		text: Type.Optional(Type.String({ pattern: Name })),
	},
	closed,
);

const Does = literals(["wake", "tell", "nothing"]);
const Paths = map(Type.String(), "^.{1,200}$");

const Rule = Type.Object(
	{
		on: Type.String({ maxLength: 200 }),
		kind: Type.Optional(literals(["added", "removed", "changed"])),
		to: Type.Optional(Type.Unknown()),
		from: Type.Optional(Type.Unknown()),
		where: Type.Optional(Type.String({ maxLength: 200 })),
		does: Does,
		says: Type.String({ maxLength: 200 }),
		words: Type.Optional(map(Type.String(), "^.{0,200}$")),
	},
	closed,
);

const Follow = Type.Object(
	{
		keys: Type.Optional(Paths),
		totals: Type.Optional(Paths),
		newest: Type.Optional(Paths),
		authors: Type.Optional(Paths),
		ignore: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 64 })),
		derived: Type.Optional(
			map(
				Type.Union([
					Type.String({ maxLength: 300 }),
					Type.Object({ when: Type.String({ maxLength: 300 }), steady: Type.String({ maxLength: 200 }) }, closed),
				]),
				Name,
			),
		),
		rules: Type.Array(Rule, { maxItems: 64 }),
		otherwise: Type.Optional(Does),
		ends: map(Type.String({ maxLength: 300 }), "^.{1,64}$"),
		busy: Type.Optional(Type.String({ maxLength: 300 })),
		every: Type.Optional(Type.String({ maxLength: 20 })),
		busy_every: Type.Optional(Type.String({ maxLength: 20 })),
		settle: Type.Optional(Type.String({ maxLength: 20 })),
	},
	closed,
);

const Templates = Type.Array(Type.String({ maxLength: 300 }), { maxItems: 8 });

const Kind = Type.Object(
	{
		card: literals(CARDS),
		name: Type.String({ maxLength: 100 }),
		urls: Type.Optional(Templates),
		ids: Type.Optional(Templates),
		normalize: Type.Optional(map(literals(["lowercase", "integer", "text"]), "^[a-z_]{1,32}$")),
		reads: map(Read, Name),
		fields: map(Type.String({ maxLength: 520 }), Name),
		writes: Type.Optional(Type.Array(Write, { maxItems: 12 })),
		creates: Type.Optional(Type.Array(Create, { maxItems: 12 })),
		follow: Type.Optional(Follow),
	},
	closed,
);

const Floors = Type.Object(
	Object.fromEntries(FLOORS.map((floor) => [floor, Type.Optional(Type.Array(ToolName, { maxItems: 200 }))])),
	closed,
);

/** A definition banda ships: `shipped/connections/<name>.json`. */
export const Definition = Type.Object(
	{
		service: Type.String({ minLength: 1, maxLength: 100, description: "The service, as the owner calls it" }),
		about: Type.String({ minLength: 1, maxLength: 120, description: "What it lets the band do, in a line" }),
		url: Type.String({ maxLength: 2000 }),
		api: Type.Optional(literals(Object.keys(REST_APIS) as (keyof typeof REST_APIS)[])),
		auth: literals(["none", "key", "oauth"]),
		client: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		scopes: Type.Optional(Type.Array(Scope, { maxItems: 64, uniqueItems: true })),
		access: Type.Optional(
			Type.Object(
				{
					required: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
					choices: Type.Array(
						Type.Object(
							{
								label: Type.String({ minLength: 1, maxLength: 120 }),
								note: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
								scopes: Type.Array(Scope, { minItems: 1, maxItems: 16, uniqueItems: true }),
							},
							closed,
						),
						{ maxItems: 16 },
					),
					note: Type.String({ minLength: 1, maxLength: 400, description: "What changing access means" }),
				},
				closed,
			),
		),
		ask: Type.Optional(Type.Literal("always")),
		floors: Type.Optional(Floors),
		account: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_.-]{1,64}\\.[A-Za-z0-9_]{1,64}$" })),
		reads: Type.Array(
			Type.String({
				pattern: "^[A-Za-z0-9_.-]{1,64}(?:\\([A-Za-z0-9_]{1,64}=[\\x21-\\x27\\x2a-\\x7e]{1,200}\\))?$",
				description: "A tool that only reads, or tool(arg=value): it reads when that argument is exactly that",
			}),
			{ maxItems: 500, uniqueItems: true },
		),
		needs: Type.Optional(map(Type.Array(Scope, { minItems: 1, maxItems: 16 }))),
		groups: Type.Optional(
			Type.Record(
				Type.String({ minLength: 1, maxLength: 40 }),
				Type.Array(ToolName, { minItems: 1, maxItems: 200, uniqueItems: true }),
				{ maxProperties: 12, description: "Its tools in groups, in order: a tool in none goes by its name" },
			),
		),
		objects: Type.Optional(Type.Record(Type.String({ pattern: Name }), Kind, { maxProperties: 12 })),
	},
	{ ...closed, title: "A connection banda ships" },
);
export type Definition = Static<typeof Definition>;

/** A connection as banda ships it, with its version: the hash of the bytes read. */
export type Shipped = Connection & { readonly sha: string };

/**
 * The connection the definition `text` says, with its version; or why it is not one: not JSON, not of its schema
 * (the first error), or a check across its fields (each).
 */
export function readDefinition(name: string, text: string): { connection: Shipped } | { errors: readonly string[] } {
	if (text.length > MAX_DEFINITION_BYTES) return { errors: [`it is over ${MAX_DEFINITION_BYTES} bytes`] };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { errors: ["it is not JSON"] };
	}
	// what an escape spells is checked too: a string may name a character nobody sees as \u202e
	const hidden = hiddenError(text, { lines: true }) ?? hiddenError(JSON.stringify(value));
	if (hidden !== undefined) return { errors: [hidden] };
	if (!Value.Check(Definition, value)) {
		const [first] = Value.Errors(Definition, value);
		return {
			errors: [
				`it does not fit its schema${first === undefined ? "" : `: ${first.instancePath || "/"} ${first.message}`}`,
			],
		};
	}
	const parsed = connectionOf(name, {
		service: value.service,
		about: value.about,
		url: value.url,
		api: value.api,
		auth: value.auth,
		ask: value.ask,
		client: value.client,
		...(value.scopes === undefined ? {} : { scopes: value.scopes }),
		account: value.account,
		reads: value.reads,
		floors: value.floors ?? {},
		...(value.needs === undefined ? {} : { needs: value.needs }),
		...(value.groups === undefined ? {} : { groups: value.groups }),
		...(value.objects === undefined ? {} : { objects: value.objects }),
		...(value.access === undefined ? {} : { access: value.access }),
	});
	return "errors" in parsed ? parsed : { connection: { ...parsed.connection, sha: shaOf(text) } };
}

/**
 * The definitions in `dir`, by name, each read once; one that does not pass is left out and `say` is told why. A
 * folder that is not there ships nothing.
 */
export function readDefinitions(dir: string, say: (line: string) => void = () => {}): Map<string, Shipped> {
	const found = new Map<string, Shipped>();
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch {
		return found;
	}
	for (const file of files.sort()) {
		const name = file.slice(0, -".json".length);
		const read = readDefinition(name, readFileSync(join(dir, file), "utf8"));
		if ("errors" in read) say(`shipped/connections/${file} is left out: ${read.errors.join("; ")}`);
		else found.set(name, read.connection);
	}
	return found;
}

/**
 * The definitions in effect in this process: those the daemon read when it started. Process-wide because what reads
 * a connection reads it in a store transaction, which knows nothing of the daemon that opened the store.
 */
let inEffect: ReadonlyMap<string, Shipped> = new Map();

/** Make `definitions` the ones in effect: the daemon's, at start. */
export function setDefinitions(definitions: ReadonlyMap<string, Shipped>): void {
	inEffect = definitions;
}

/** The definition banda ships of connection `name`, as read at start. */
export const shippedDefinition = (name: string): Shipped | undefined => inEffect.get(name);

/** Every definition banda ships, by name, as read at start. */
export const shippedDefinitions = (): ReadonlyMap<string, Shipped> => inEffect;
