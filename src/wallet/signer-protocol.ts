/**
 * What the daemon and the signer child say to each other, one JSON line at a time over the child's stdin and stdout
 * (C20): a request, then the child's answer carrying the request's id. A creation says one more thing each way: the
 * child names the address it drew, and goes on only when the daemon, having committed `creating` with that address,
 * says go (C15). Amounts travel as decimal strings. Both sides check every line against these schemas; a line that
 * fails, or names another request, is dropped (C14).
 *
 * An answer carries signed bytes, an address or a fixed code, never a key (H-010): the key enters a request only for
 * the owner's Restore key, which the host process sends (src/wallet/signer-host.ts), never the daemon (C20, H-014).
 * It leaves the child only to the owner: a reveal writes it, with the HTTP response around it, onto the connection the
 * daemon hands the child over its IPC channel once the child proved the key (C16), so the daemon never holds it; and an
 * export answers it to the host process alone, which no module of the daemon starts. A paste the owner saved is
 * checked by its SHA-256, which the child compares with the key's, so the pasted key never reaches the daemon either.
 */
import { type Static, Type } from "typebox";

/**
 * Why a call did not do what it was asked, the only thing a failure says:
 * - locked: the keychain is locked, or its unlock prompt was dismissed;
 * - missing: the item is gone, and the canary shows the keychain answers (H-037);
 * - wrong_key: the item's key does not derive the wallet's address (H-025);
 * - no_keychain: no keychain banda can use (H-028);
 * - denied: the owner refused the keychain's prompt;
 * - timeout: no answer by the deadline, and the child was killed (H-018);
 * - exists: an item is already where a key was to be written, and is never overwritten (H-024);
 * - ambiguous: more than one item matches (H-019);
 * - other_home: this home does not hold the lease (C16);
 * - debugging: an inspector or heap-dump flag is on (H-012);
 * - refused: the signing module refused the payment's fields;
 * - other: anything else, the child dying included (H-033).
 */
export const CODES = [
	"locked",
	"missing",
	"wrong_key",
	"no_keychain",
	"denied",
	"timeout",
	"exists",
	"ambiguous",
	"other_home",
	"debugging",
	"refused",
	"other",
] as const;
export type SignerCode = (typeof CODES)[number];

const Id = Type.String({ pattern: "^[0-9a-f]{32}$" });
const Hex64 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Address = Type.String({ pattern: "^0x[0-9a-fA-F]{40}$" });
const Hex = Type.String({ pattern: "^0x[0-9a-f]*$" });
const Uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,77})$" });
const Epoch = Type.Integer({ minimum: 1 });

const Home = Type.Object(
	{
		id: Type.String({ pattern: "^[\\w-]{1,64}$" }),
		binding: Hex64,
		fork: Type.Optional(Type.Literal(true)),
		test: Type.Optional(Type.Literal(true)),
	},
	{ additionalProperties: false },
);

/** A transfer's fields as the request carries them: its integers in decimal. */
const TransferWire = Type.Object(
	{
		chainId: Type.Integer({ minimum: 1 }),
		nonce: Uint,
		maxFee: Uint,
		tip: Uint,
		gasLimit: Uint,
		to: Address,
		value: Uint,
		token: Type.Optional(Address),
	},
	{ additionalProperties: false },
);

/** An authorization's fields as the request carries them: its integers in decimal. */
const AuthorizationWire = Type.Object(
	{
		chainId: Type.Integer({ minimum: 1 }),
		token: Type.Object(
			{ address: Address, name: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }) },
			{ additionalProperties: false },
		),
		to: Address,
		value: Uint,
		validAfter: Uint,
		validBefore: Uint,
		nonce: Type.String({ pattern: "^0x[0-9a-fA-F]{64}$" }),
	},
	{ additionalProperties: false },
);

const base = <K extends string>(name: K) => ({ id: Id, op: Type.Literal(name), home: Home });
const closed = { additionalProperties: false } as const;

export const Request = Type.Union([
	Type.Object({ ...base("canary") }, closed),
	Type.Object({ ...base("lease"), expected: Type.Union([Epoch, Type.Null()]) }, closed),
	Type.Object({ ...base("leased") }, closed),
	Type.Object(
		{
			...base("move"),
			// the lease's epoch the keychain holds; null where no home holds one, nor did the store take one (H-287)
			expected: Type.Union([Epoch, Type.Null()]),
			addresses: Type.Array(Address, { maxItems: 1024 }),
			// the epoch the home's store last took: the move goes past it too (UC-21)
			after: Type.Optional(Epoch),
		},
		closed,
	),
	Type.Object({ ...base("create"), lease: Epoch }, closed),
	Type.Object(
		{ ...base("restore"), lease: Epoch, address: Address, key: Type.String({ pattern: "^0x[0-9a-fA-F]{64}$" }) },
		closed,
	),
	Type.Object({ ...base("derive"), lease: Epoch, address: Address }, closed),
	Type.Object({ ...base("transfer"), lease: Epoch, address: Address, fields: TransferWire }, closed),
	Type.Object({ ...base("authorization"), lease: Epoch, address: Address, fields: AuthorizationWire }, closed),
	Type.Object({ ...base("remove"), lease: Epoch, address: Address }, closed),
	Type.Object({ ...base("find"), lease: Epoch }, closed),
	Type.Object({ ...base("reveal"), lease: Epoch, address: Address }, closed),
	Type.Object({ ...base("confirm"), lease: Epoch, address: Address, digest: Hex64 }, closed),
	Type.Object({ ...base("export"), lease: Epoch, address: Address }, closed),
]);
export type Request = Static<typeof Request>;
export type Op = Request["op"];

/**
 * The ops only the host process sends, through HostSigner: the export, whose answer carries the key (OD-2); the
 * restore, whose request carries it (C20, H-014); and the lease's move to a home whose binding is not the home secret's
 * (UC-21). The daemon's Signer has no method for any of them, which test/wallet-signer.test.ts holds.
 */
export const HOST_OPS = ["export", "restore", "move"] as const satisfies readonly Op[];

/**
 * The daemon's word to a creation that drew its address: go on and write it; and to a reveal that proved its key: here
 * is the connection to write it onto, the handle sent beside this message.
 */
export const Go = Type.Object({ id: Id, go: Type.Literal(true) }, { additionalProperties: false });

/** What each operation answers when it did what it was asked. */
export const RESULTS = {
	canary: Type.Object({}, { additionalProperties: false }),
	lease: Type.Object({ epoch: Epoch }, { additionalProperties: false }),
	move: Type.Object({ epoch: Epoch }, { additionalProperties: false }),
	leased: Type.Object(
		{
			lease: Type.Union([
				Type.Object({ epoch: Epoch, mine: Type.Boolean() }, { additionalProperties: false }),
				Type.Null(),
			]),
		},
		{ additionalProperties: false },
	),
	create: Type.Object({ address: Address }, { additionalProperties: false }),
	restore: Type.Object({ address: Address }, { additionalProperties: false }),
	derive: Type.Object({ address: Address }, { additionalProperties: false }),
	transfer: Type.Object(
		{ raw: Hex, hash: Type.String({ pattern: "^0x[0-9a-f]{64}$" }) },
		{ additionalProperties: false },
	),
	authorization: Type.Object(
		{ from: Address, signature: Type.String({ pattern: "^0x[0-9a-f]{130}$" }) },
		{ additionalProperties: false },
	),
	remove: Type.Object({ removed: Type.Boolean() }, { additionalProperties: false }),
	find: Type.Object({ addresses: Type.Array(Address) }, { additionalProperties: false }),
	reveal: Type.Object({}, { additionalProperties: false }),
	confirm: Type.Object({ matches: Type.Boolean() }, { additionalProperties: false }),
	export: Type.Object(
		{ address: Address, key: Type.String({ pattern: "^0x[0-9a-f]{64}$" }) },
		{ additionalProperties: false },
	),
} as const;
export type Results = { [K in Op]: Static<(typeof RESULTS)[K]> };

export const Answer = Type.Union([
	Type.Object({ id: Id, ok: Type.Literal(true), result: Type.Unknown() }, { additionalProperties: false }),
	Type.Object(
		{
			id: Id,
			ok: Type.Literal(false),
			code: Type.Union(CODES.map((code) => Type.Literal(code))),
			why: Type.Optional(Type.String({ maxLength: 200 })),
		},
		{ additionalProperties: false },
	),
	Type.Object({ id: Id, step: Type.Literal("drawn"), address: Address }, { additionalProperties: false }),
	Type.Object({ id: Id, step: Type.Literal("proven") }, { additionalProperties: false }),
]);
export type Answer =
	| { id: string; ok: true; result: unknown }
	| { id: string; ok: false; code: SignerCode; why?: string }
	| { id: string; step: "drawn"; address: string }
	| { id: string; step: "proven" };

/** What a call gives its caller: the result, or a fixed code. */
export type Outcome<T> = ({ ok: true } & T) | { ok: false; code: SignerCode; why?: string };

const DEBUG_FLAG =
	/^--(inspect|inspect-brk|inspect-wait|inspect-port|debug-port|heapsnapshot-signal|heapsnapshot-near-heap-limit|heap-prof)$/;

/** A flag's name as Node reads it: a dash and an underscore in it are the same (`--heap_prof` is `--heap-prof`). */
const flagName = (word: string) => `--${(word.split("=")[0] ?? "").replace(/^--/, "").replaceAll("_", "-")}`;

/**
 * Whether this process could be read from outside while it holds a key (H-012): an inspector on, or a flag that opens
 * one or dumps the heap, given on the command line or in NODE_OPTIONS. NODE_OPTIONS is read with its double quotes and
 * backslashes dropped and split at any blank, so every flag Node reads from a quoted or escaped word is found; a word
 * that reads as a flag only that way takes the wallets offline too, never online.
 */
export function debugging(
	execArgv: readonly string[],
	nodeOptions: string | undefined,
	inspectorUrl: string | undefined,
) {
	if (inspectorUrl !== undefined) return true;
	const words = [...execArgv, ...(nodeOptions ?? "").replaceAll(/["\\]/g, "").split(/\s+/)];
	return words.some((word) => word.startsWith("--") && DEBUG_FLAG.test(flagName(word)));
}
