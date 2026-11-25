/**
 * banda's JSON-RPC client for a wallet's network (docs/wallets/stack.md "JSON-RPC client over `fetch`"): the dozen
 * methods banda calls, over the `fetch` the daemon is given. Quantities are read as `bigint`, a node's error message is
 * read as the node wrote it (its pool class, a refused log range, an unset block) and then kept with the RPC's secrets
 * scrubbed, since a scrubbed word can be one the node's message needs, and every request to one RPC takes a token from
 * that RPC's bucket, shared by every wallet on it (H-198), which a rate limit closes for everyone (H-183).
 *
 * The RPC's URL and headers may carry its key (H-195), so nothing thrown here names them: an error names the network
 * and the method, the URL only as `shownRpc` gives it, and a node's message with every secret part of the URL and the
 * headers replaced by `•••`. A redirect is not followed, since it would take the request, and the header that carries
 * the URL's userinfo, to a host the owner never set (H-196). An answer is read up to a fixed size, so an RPC cannot
 * fill the daemon's memory.
 */
import { setTimeout as sleepFor } from "node:timers/promises";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { retryAtOf } from "../core/retry-after.ts";
import { type RpcClients, shownRpc, type WalletRpc } from "./config.ts";
import type { Network } from "./networks.ts";
import { classifyMessage, type PoolClass } from "./pool.ts";

export type RpcFailure =
	/** The node answered a JSON-RPC error: `detail` is its message, `code` its code. */
	| "rpc"
	/**
	 * The RPC refused for now (HTTP 429, 503 with `Retry-After`, `-32011`, "rate limit"): `retryAt` says when to ask
	 * again.
	 */
	| "limited"
	/** An HTTP status that is not a success, with no JSON-RPC error in its body, or a redirect, never followed. */
	| "http"
	/** No answer: the connection failed or was lost. */
	| "transport"
	/** No answer in time; the request may still have reached the node. */
	| "timeout"
	/** An answer that is not the JSON-RPC this method returns, or one larger than banda reads. */
	| "shape"
	/** The RPC serves another chain than the network's (H-187). */
	| "chain";

const DETAIL_CHARS = 500;

export class RpcError extends Error {
	readonly kind: RpcFailure;
	readonly method: string;
	/**
	 * The node's message as it wrote it, secrets scrubbed, cut to 500 characters, for `rpc` and `limited`; else fixed
	 * words.
	 */
	readonly detail: string;
	readonly code?: number;
	readonly status?: number;
	/** When to ask again, as a time in ms: set on `limited` alone. */
	readonly retryAt?: number;
	/** What the node's message, read before it was scrubbed, means for the pool: set on `rpc` alone. */
	readonly pool?: PoolClass;
	/** The node refused a log range as too wide, naming the width it serves or none. */
	readonly tooWide?: { readonly width?: bigint };
	/** The node has no `safe` or `finalized` block set yet. */
	readonly unset?: true;
	/** The node keeps no state at the block asked: a pruned or path-based node, below the window it serves. */
	readonly pruned?: true;
	/** The answer was larger than banda reads: set on `shape` alone. */
	readonly tooLarge?: true;
	constructor(
		where: string,
		method: string,
		kind: RpcFailure,
		detail: string,
		extra: Readings & { code?: number; status?: number; retryAt?: number; tooLarge?: true } = {},
	) {
		const cut = detail.length > DETAIL_CHARS ? `${detail.slice(0, DETAIL_CHARS)}…` : detail;
		super(`${where} ${method}: ${cut}`);
		this.name = "RpcError";
		this.kind = kind;
		this.method = method;
		this.detail = cut;
		if (extra.code !== undefined) this.code = extra.code;
		if (extra.status !== undefined) this.status = extra.status;
		if (extra.retryAt !== undefined) this.retryAt = extra.retryAt;
		if (kind === "rpc") this.pool = extra.pool ?? classifyMessage(detail);
		if (extra.tooWide !== undefined) this.tooWide = extra.tooWide;
		if (extra.unset !== undefined) this.unset = extra.unset;
		if (extra.pruned !== undefined) this.pruned = extra.pruned;
		if (extra.tooLarge !== undefined) this.tooLarge = extra.tooLarge;
	}
}

/** What a node's message says, read as the node wrote it. */
type Readings = { pool?: PoolClass; tooWide?: { readonly width?: bigint }; unset?: true; pruned?: true };

/**
 * A `getLogs` range the RPC refuses as too wide: sepolia.base.org "eth_getLogs is limited to a 200 range" (HTTP 413),
 * publicnode "exceed maximum block range: 50000", Infura "query returned more than 10000 results", and the like. A
 * message that names a block range but not its width ("invalid block range params") is not one: narrowing cannot fix
 * it.
 */
const TOO_WIDE = new RegExp(
	[
		"limited to a? ?\\d[\\d,_]* range",
		"maximum block range",
		"range (is )?too (large|wide|big)",
		"query returned more than",
		"too many (blocks|results|logs)",
		"response size",
	].join("|"),
	"i",
);

/**
 * A `safe` or `finalized` block the chain has not set yet: geth's "safe block not found", "finalized block not found".
 */
const UNSET = /(safe|finalized) block not found/i;

/**
 * State the node does not keep: geth's hash-based "missing trie node <hash>", path-based "historical state <root> is
 * not available", reth and publicnode "state at block #N is pruned". A timeout, "header not found" or any other refusal
 * is not one: another try, or another node behind the same URL, may serve it.
 */
const PRUNED =
	/missing trie node|historical state \S+ is not available|state at block #?\d+ is pruned|state (is )?pruned/i;

/** The width a refusal names: "limited to a 200 range", "limited to a 10,000 range", "maximum block range: 50000". */
const NAMED_WIDTH = /(?:limited to a? ?|block range:? ?)(\d[\d,_]*)/i;

function readingsOf(message: string): Readings {
	const named = NAMED_WIDTH.exec(message)?.[1];
	return {
		pool: classifyMessage(message),
		...(TOO_WIDE.test(message)
			? { tooWide: named === undefined ? {} : { width: BigInt(named.replace(/[,_]/g, "")) } }
			: {}),
		...(UNSET.test(message) ? { unset: true as const } : {}),
		...(PRUNED.test(message) ? { pruned: true as const } : {}),
	};
}

/** A block tag banda reads at: `latest`, `pending` for its own pool view, or the chain's `safe` and `finalized`. */
export type BlockTag = "latest" | "pending" | "safe" | "finalized";

/**
 * A tag a whole block is read at. `pending` is not one: geth and op-geth answer a pending block with no hash, number or
 * miner, which is not a block banda can keep.
 */
type BlockAt = Exclude<BlockTag, "pending"> | bigint;

const Quantity = Type.String({ pattern: "^0[xX][0-9a-fA-F]+$" });
const Data = Type.String({ pattern: "^0[xX]([0-9a-fA-F]{2})*$" });
const Hash = Type.String({ pattern: "^0[xX][0-9a-fA-F]{64}$" });
const Address = Type.String({ pattern: "^0[xX][0-9a-fA-F]{40}$" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

const RawBlock = Type.Object({
	number: Quantity,
	hash: Hash,
	parentHash: Hash,
	timestamp: Quantity,
	baseFeePerGas: Type.Optional(Quantity),
});

const RawLog = Type.Object({
	address: Address,
	topics: Type.Array(Hash),
	data: Data,
	blockNumber: Quantity,
	blockHash: Hash,
	transactionHash: Hash,
	logIndex: Quantity,
	removed: Type.Optional(Type.Boolean()),
});

const RawReceipt = Type.Object({
	transactionHash: Hash,
	blockNumber: Quantity,
	blockHash: Hash,
	from: Address,
	to: Nullable(Address),
	status: Quantity,
	gasUsed: Quantity,
	effectiveGasPrice: Quantity,
	l1Fee: Type.Optional(Nullable(Quantity)),
	logs: Type.Array(RawLog),
});

const RawAccess = Type.Object({ address: Address, storageKeys: Type.Array(Hash) });

const RawDelegationEntry = Type.Object({
	chainId: Quantity,
	address: Address,
	nonce: Quantity,
	yParity: Quantity,
	r: Quantity,
	s: Quantity,
});

const RawTransaction = Type.Object({
	hash: Hash,
	type: Type.Optional(Quantity),
	chainId: Type.Optional(Quantity),
	from: Address,
	to: Nullable(Address),
	nonce: Quantity,
	value: Quantity,
	input: Data,
	gas: Quantity,
	gasPrice: Type.Optional(Quantity),
	maxFeePerGas: Type.Optional(Quantity),
	maxPriorityFeePerGas: Type.Optional(Quantity),
	accessList: Type.Optional(Type.Array(RawAccess)),
	authorizationList: Type.Optional(Type.Array(RawDelegationEntry)),
	v: Type.Optional(Quantity),
	yParity: Type.Optional(Quantity),
	r: Type.Optional(Quantity),
	s: Type.Optional(Quantity),
	blockNumber: Nullable(Quantity),
	blockHash: Nullable(Hash),
});

const Reply = Type.Object({
	id: Type.Optional(Type.Unknown()),
	result: Type.Optional(Type.Unknown()),
	error: Type.Optional(Type.Object({ code: Type.Number(), message: Type.String() })),
});

export type Block = {
	readonly number: bigint;
	readonly hash: string;
	readonly parentHash: string;
	readonly timestamp: bigint;
	readonly baseFeePerGas?: bigint;
};

export type Log = {
	readonly address: string;
	readonly topics: readonly string[];
	readonly data: string;
	readonly blockNumber: bigint;
	readonly blockHash: string;
	readonly transactionHash: string;
	readonly logIndex: bigint;
	readonly removed: boolean;
};

export type Receipt = {
	readonly transactionHash: string;
	readonly blockNumber: bigint;
	readonly blockHash: string;
	readonly from: string;
	readonly to: string | null;
	/** 1n when the transaction succeeded, 0n when it reverted. */
	readonly status: bigint;
	readonly gasUsed: bigint;
	readonly effectiveGasPrice: bigint;
	/** The L1 fee an OP Stack chain charged; absent on a chain that charges none. */
	readonly l1Fee?: bigint;
	readonly logs: readonly Log[];
};

export type Access = { readonly address: string; readonly storageKeys: readonly string[] };

/** An EIP-7702 authorization as signed: its signer is recovered from its own `yParity`, `r` and `s`. */
type DelegationEntry = {
	readonly chainId: bigint;
	readonly address: string;
	readonly nonce: bigint;
	readonly yParity: bigint;
	readonly r: bigint;
	readonly s: bigint;
};

/**
 * A transaction as the RPC answered it. `from` is the RPC's word, which a lying RPC writes (TA-4); the signed fields
 * are kept as they were signed, so the transaction can be serialised again, its hash checked against `hash` and its
 * signer recovered (C7). The signature is absent only where the RPC gave none, and such a transaction proves nothing.
 */
export type Transaction = {
	readonly hash: string;
	/** 0n legacy, 1n EIP-2930, 2n EIP-1559, 4n EIP-7702; 0n when the RPC names no type. */
	readonly type: bigint;
	/** Absent on a legacy transaction signed without EIP-155. */
	readonly chainId?: bigint;
	readonly from: string;
	readonly to: string | null;
	readonly nonce: bigint;
	readonly value: bigint;
	readonly input: string;
	readonly gas: bigint;
	/** What a legacy or EIP-2930 transaction signed; on a later type, the price the RPC says it paid. */
	readonly gasPrice?: bigint;
	readonly maxFeePerGas?: bigint;
	readonly maxPriorityFeePerGas?: bigint;
	readonly accessList?: readonly Access[];
	readonly authorizationList?: readonly DelegationEntry[];
	readonly v?: bigint;
	readonly yParity?: bigint;
	readonly r?: bigint;
	readonly s?: bigint;
	/** Null while the transaction waits in a pool. */
	readonly blockNumber: bigint | null;
	readonly blockHash: string | null;
};

type CallRequest = {
	readonly to: string;
	readonly data?: string;
	readonly from?: string;
	readonly value?: bigint;
	readonly gas?: bigint;
};

type LogFilter = {
	readonly address?: string | readonly string[];
	readonly topics?: readonly (string | readonly string[] | null)[];
};

export type Rpc = {
	readonly network: Network;
	/** The RPC as the owner and the logs may see it. */
	readonly shown: string;
	chainId(): Promise<bigint>;
	/**
	 * Throws an `RpcError` of kind `chain` unless the RPC serves the network's chain (H-187). Every read and send of the
	 * client runs it first, once per client while it holds: what an RPC of another chain serves is never taken as the
	 * network's.
	 */
	checkChain(): Promise<void>;
	blockNumber(): Promise<bigint>;
	/**
	 * Null when the RPC has no such block: a number past the head (null), or a `safe` or `finalized` the chain has not
	 * set yet (geth's "safe block not found" error).
	 */
	getBlock(at: BlockAt): Promise<Block | null>;
	balance(address: string, at?: BlockTag | bigint): Promise<bigint>;
	call(request: CallRequest, at?: BlockTag | bigint): Promise<string>;
	estimateGas(request: CallRequest): Promise<bigint>;
	getCode(address: string, at?: BlockTag | bigint): Promise<string>;
	nonce(address: string, at: BlockTag | bigint): Promise<bigint>;
	/**
	 * Hands signed bytes to the RPC once, never again on any failure: a second try is a rebroadcast, the lane's to make.
	 * Resolves to the hash the node answered; throws an `RpcError` whose `pool` says what the pool refused.
	 */
	sendRaw(raw: string): Promise<string>;
	receipt(hash: string): Promise<Receipt | null>;
	getTransaction(hash: string): Promise<Transaction | null>;
	/**
	 * The logs of `from`..`to`, inclusive, read `span` blocks at a time. A range the RPC refuses as too wide, or whose
	 * answer is larger than banda reads, is asked again at the width the refusal names, or at half; `span` is the width
	 * every chunk was then read at, for the caller to keep as the RPC's probed range.
	 */
	getLogs(
		filter: LogFilter,
		range: { readonly from: bigint; readonly to: bigint; readonly span: bigint },
	): Promise<{ readonly logs: readonly Log[]; readonly span: bigint }>;
	/**
	 * The most the chain's GasPriceOracle says a transaction of `size` unsigned bytes pays for L1 data
	 * (`getL1FeeUpperBound`), the reserve's L1 term (C11).
	 */
	estimateL1Fee(size: bigint): Promise<bigint>;
};

type RpcOptions = {
	/** The daemon's `fetch` (`DaemonOptions.fetch`); the global one when unset. */
	readonly fetch?: typeof fetch;
	/** Requests per second each RPC is sent, on average. */
	readonly rate?: number;
	/** Requests an idle RPC may be sent at once. */
	readonly burst?: number;
	/** How long one request may take, in ms. */
	readonly timeoutMs?: number;
	/** How many times a read is asked again after a rate limit, a timeout, a lost connection or a 5xx. */
	readonly retries?: number;
	/**
	 * The first wait before a read is asked again, in ms; each next one doubles, with jitter, up to `maxBackoffMs`. A
	 * rate limit that names no time closes the RPC's bucket for the same growing wait, counted across every caller.
	 */
	readonly backoffMs?: number;
	readonly maxBackoffMs?: number;
	/** The most bytes an answer is read to: `eth_getLogs` gets `maxLogsBytes`, every other method `maxReplyBytes`. */
	readonly maxReplyBytes?: number;
	readonly maxLogsBytes?: number;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly random?: () => number;
};

/** One RPC's requests: `rate` a second, `burst` at once, and none at all until `closedUntil` after a rate limit. */
class Bucket {
	/** Rate limits in a row that named no time: each doubles the next hold. */
	strikes = 0;
	readonly #rate: number;
	readonly #burst: number;
	readonly #now: () => number;
	readonly #sleep: (ms: number) => Promise<void>;
	#tokens: number;
	#at: number;
	#closedUntil = 0;
	get closedUntil(): number {
		return this.#closedUntil;
	}
	constructor(rate: number, burst: number, now: () => number, sleep: (ms: number) => Promise<void>) {
		this.#rate = rate;
		this.#burst = burst;
		this.#now = now;
		this.#sleep = sleep;
		this.#tokens = burst;
		this.#at = now();
	}
	/**
	 * Waits for a token. A hold longer than `maxHoldMs`, set before the call or while it waits, is not slept out: its end
	 * is returned at once, with no token taken, for the caller to come back then.
	 */
	async take(maxHoldMs: number): Promise<number | undefined> {
		for (;;) {
			const now = this.#now();
			if (now < this.#closedUntil) {
				if (this.#closedUntil - now > maxHoldMs) return this.#closedUntil;
				await this.#sleep(this.#closedUntil - now);
				continue;
			}
			this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#at) * this.#rate) / 1000);
			this.#at = now;
			if (this.#tokens >= 1) {
				this.#tokens -= 1;
				return undefined;
			}
			await this.#sleep(Math.max(1, Math.ceil(((1 - this.#tokens) * 1000) / this.#rate)));
		}
	}
	/** Holds every request to this RPC until `until`, and leaves it with no tokens saved up. */
	close(until: number): void {
		this.#closedUntil = Math.max(this.#closedUntil, until);
		this.#tokens = 0;
		this.#at = Math.max(this.#at, until);
	}
}

const DEFAULTS = {
	rate: 5,
	burst: 10,
	timeoutMs: 20_000,
	retries: 3,
	backoffMs: 500,
	maxBackoffMs: 30_000,
	maxReplyBytes: 4 * 1024 * 1024,
	maxLogsBytes: 64 * 1024 * 1024,
} as const;

/**
 * A name a user can be a key under: six characters or more with a digit, or twenty or more. A shorter word is a name
 * (`alice`), left so the node's message keeps it.
 */
const tokenLike = (part: string): boolean => (part.length >= 6 && /\d/.test(part)) || part.length >= 20;

/**
 * The words a URL is built of and a header names its scheme by, which are never a key: a path segment, a query value
 * or a header word made of these alone (`base`, `eth-mainnet`, `v2`, `Bearer`) is left, so the node's message keeps
 * its words. Every other part is a key, whatever it looks like; one under three characters holds no secret.
 */
const URL_WORDS = new Set([
	"api",
	"arb",
	"arbitrum",
	"base",
	"basic",
	"bearer",
	"chain",
	"eth",
	"ethereum",
	"evm",
	"holesky",
	"http",
	"https",
	"json",
	"jsonrpc",
	"l2",
	"mainnet",
	"node",
	"op",
	"optimism",
	"polygon",
	"public",
	"rpc",
	"sepolia",
	"testnet",
	"ws",
]);
const VERSION = /^v\d+(\.\d+)*$/i;
const builtOf = (part: string): boolean =>
	part.split(/[-_.]/).every((word) => VERSION.test(word) || URL_WORDS.has(word.toLowerCase()));
const keyLike = (part: string): boolean => part.length >= 3 && !builtOf(part);

/**
 * What `word` holds when it is base64 of UTF-8 text, as a Basic payload is: it encodes back to itself, padding aside,
 * and holds no NUL. A password in any script counts, since `walletRpc` encodes the URL's userinfo as UTF-8.
 */
function basicPayload(word: string): string | undefined {
	const bare = word.replace(/=+$/, "");
	if (bare === "") return undefined;
	const bytes = Buffer.from(bare, "base64");
	if (bytes.toString("base64").replace(/=+$/, "") !== bare) return undefined;
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
	return decoded === "" || decoded.includes("\0") ? undefined : decoded;
}

/**
 * Every part of an RPC's URL and headers that may be its key, longest first so a part inside another is not replaced
 * first. The password, each header's value and a Basic payload (the encoded word, with and without its padding, and
 * its password) are kept whatever their length; every path segment, query value, fragment and header word that is not
 * one of the words a URL is built of (`keyLike`), with its whole path, pair or query; and a user only when it can be a
 * key (`tokenLike`). A query's names are never a key.
 */
function secretsOf(rpc: WalletRpc): readonly string[] {
	const parts = new Set<string>([rpc.url]);
	const add = (part: string) => {
		if (part === "") return;
		parts.add(part);
		try {
			parts.add(decodeURIComponent(part));
		} catch {}
	};
	const addKey = (part: string) => {
		if (keyLike(part)) add(part);
	};
	try {
		const url = new URL(rpc.url);
		if (tokenLike(url.username)) add(url.username);
		add(url.password);
		const segments = url.pathname.split("/");
		for (const segment of segments) addKey(segment);
		if (segments.some(keyLike)) add(url.pathname);
		const pairs = url.search.slice(1).split("&");
		const values = pairs.map((pair) => pair.slice(pair.indexOf("=") + 1));
		for (const value of values) addKey(value);
		pairs.forEach((pair, i) => {
			if (keyLike(values[i] ?? "")) add(pair);
		});
		if (values.some(keyLike)) add(url.search.slice(1));
		addKey(url.hash.slice(1));
	} catch {}
	for (const value of Object.values(rpc.headers)) {
		add(value);
		for (const word of value.split(/\s+/)) {
			addKey(word);
			const decoded = basicPayload(word);
			if (decoded !== undefined) {
				add(word);
				add(word.replace(/=+$/, ""));
				add(decoded);
				const colon = decoded.indexOf(":");
				if (colon === -1) addKey(decoded);
				else {
					if (tokenLike(decoded.slice(0, colon))) add(decoded.slice(0, colon));
					add(decoded.slice(colon + 1));
				}
			}
		}
	}
	return [...parts].sort((a, b) => b.length - a.length);
}

/** `text` with every one of `secrets` replaced by `•••`. */
const scrub = (text: string, secrets: readonly string[]): string =>
	secrets.reduce((done, secret) => done.split(secret).join("•••"), text);

/** The body of `response`, read to `limit` bytes; undefined when it is longer. */
async function bodyOf(response: Response, limit: number): Promise<string | undefined> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => {});
			return undefined;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

const hex = (value: bigint): string => {
	if (value < 0n) throw new RangeError("a quantity is never negative");
	return `0x${value.toString(16)}`;
};

const tagOf = (at: BlockTag | bigint): string => (typeof at === "bigint" ? hex(at) : at);

/** `getL1FeeUpperBound(uint256)`. */
const L1_FEE_UPPER_BOUND = "0xf1c7a58b";

/**
 * A message that names a rate limit, from a node or from the provider in front of it. Never read on a revert, whose
 * words a contract chose: a recipient that reverts with "rate limit exceeded" must not hold the RPC for every wallet.
 */
const LIMITED = /rate limit|request limit|too many requests|exceeded .*capacity|throttl/i;

/** A revert: geth's code 3, or a message that starts as every client's revert does. */
const REVERTED = /^\s*execution reverted/i;

function convert<S extends TSchema, T>(
	where: string,
	method: string,
	schema: S,
	value: unknown,
	to: (raw: Static<S>) => T,
): T {
	if (!Value.Check(schema, value))
		throw new RpcError(where, method, "shape", "the answer is not what this method returns");
	return to(value as Static<S>);
}

const big = (value: string): bigint => BigInt(value);
const bigOr = (value: string | null | undefined): bigint | undefined =>
	value === undefined || value === null ? undefined : BigInt(value);

const toBlock = (raw: Static<typeof RawBlock>): Block => {
	const base = bigOr(raw.baseFeePerGas);
	return {
		number: big(raw.number),
		hash: raw.hash,
		parentHash: raw.parentHash,
		timestamp: big(raw.timestamp),
		...(base === undefined ? {} : { baseFeePerGas: base }),
	};
};

const toLog = (raw: Static<typeof RawLog>): Log => ({
	address: raw.address,
	topics: raw.topics,
	data: raw.data,
	blockNumber: big(raw.blockNumber),
	blockHash: raw.blockHash,
	transactionHash: raw.transactionHash,
	logIndex: big(raw.logIndex),
	removed: raw.removed === true,
});

const toReceipt = (raw: Static<typeof RawReceipt>): Receipt => {
	const l1Fee = bigOr(raw.l1Fee);
	return {
		transactionHash: raw.transactionHash,
		blockNumber: big(raw.blockNumber),
		blockHash: raw.blockHash,
		from: raw.from,
		to: raw.to,
		status: big(raw.status),
		gasUsed: big(raw.gasUsed),
		effectiveGasPrice: big(raw.effectiveGasPrice),
		...(l1Fee === undefined ? {} : { l1Fee }),
		logs: raw.logs.map(toLog),
	};
};

/**
 * `{ [name]: value }`, or nothing when `value` is undefined, for an optional field to be absent rather than undefined.
 */
const field = <K extends string, V>(name: K, value: V | undefined): { [P in K]?: V } =>
	(value === undefined ? {} : { [name]: value }) as { [P in K]?: V };

const toTransaction = (raw: Static<typeof RawTransaction>): Transaction => ({
	hash: raw.hash,
	type: bigOr(raw.type) ?? 0n,
	...field("chainId", bigOr(raw.chainId)),
	from: raw.from,
	to: raw.to,
	nonce: big(raw.nonce),
	value: big(raw.value),
	input: raw.input,
	gas: big(raw.gas),
	...field("gasPrice", bigOr(raw.gasPrice)),
	...field("maxFeePerGas", bigOr(raw.maxFeePerGas)),
	...field("maxPriorityFeePerGas", bigOr(raw.maxPriorityFeePerGas)),
	...field("accessList", raw.accessList),
	...field(
		"authorizationList",
		raw.authorizationList?.map((entry) => ({
			chainId: big(entry.chainId),
			address: entry.address,
			nonce: big(entry.nonce),
			yParity: big(entry.yParity),
			r: big(entry.r),
			s: big(entry.s),
		})),
	),
	...field("v", bigOr(raw.v)),
	...field("yParity", bigOr(raw.yParity)),
	...field("r", bigOr(raw.r)),
	...field("s", bigOr(raw.s)),
	blockNumber: bigOr(raw.blockNumber) ?? null,
	blockHash: raw.blockHash,
});

const callObject = (request: CallRequest) => ({
	to: request.to,
	...(request.from === undefined ? {} : { from: request.from }),
	...(request.data === undefined ? {} : { data: request.data }),
	...(request.value === undefined ? {} : { value: hex(request.value) }),
	...(request.gas === undefined ? {} : { gas: hex(request.gas) }),
});

/**
 * `address`'s balance of the ERC-20 `token` at `at`: `balanceOf(address)`, its 32-byte answer as base units. Any other
 * answer is an `RpcError` of kind `shape`: never read as a number, so an RPC that answers garbage is unknown, not zero.
 */
export async function tokenBalance(rpc: Rpc, token: string, address: string, at?: BlockTag | bigint): Promise<bigint> {
	const answer = await rpc.call(
		{ to: token, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}` },
		at,
	);
	if (!/^0x[0-9a-fA-F]{64}$/.test(answer))
		throw new RpcError(`${rpc.network.label} RPC ${rpc.shown}`, "eth_call", "shape", "the answer is not a balance");
	return BigInt(answer);
}

/** Whether a read that failed this way is worth asking again. */
const transient = (error: RpcError): boolean =>
	error.kind === "limited" || error.kind === "timeout" || error.kind === "transport" || (error.status ?? 0) >= 500;

/** What `read` asks again: every transient failure, or all of them but a timeout (`getLogs` narrows on one instead). */
type Retry = "transient" | "not timeout";

/**
 * The clients for every network's RPC. A daemon makes one: each RPC gets one bucket, shared by every client on it, so
 * five wallets on Base poll it no faster than one would.
 */
export function rpcClients(options: RpcOptions = {}): RpcClients {
	const settings = { ...DEFAULTS, ...options };
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => sleepFor(ms));
	const random = options.random ?? Math.random;
	const buckets = new Map<string, Bucket>();
	const clients = new Map<string, Rpc>();

	const bucketOf = (rpc: WalletRpc): Bucket => {
		const key = JSON.stringify([rpc.url, rpc.headers]);
		let bucket = buckets.get(key);
		if (bucket === undefined) {
			bucket = new Bucket(settings.rate, settings.burst, now, sleep);
			buckets.set(key, bucket);
		}
		return bucket;
	};

	const make = (network: Network, rpc: WalletRpc): Rpc => {
		const bucket = bucketOf(rpc);
		const shown = shownRpc(rpc);
		const where = `${network.label} RPC ${shown}`;
		const secrets = secretsOf(rpc);
		const doFetch = options.fetch ?? fetch;
		let id = 0;

		const once = async (method: string, params: readonly unknown[]): Promise<unknown> => {
			const held = await bucket.take(settings.maxBackoffMs);
			if (held !== undefined)
				throw new RpcError(where, method, "limited", "the RPC asked banda to wait", { retryAt: held });
			id += 1;
			let response: Response;
			let text: string | undefined;
			try {
				response = await doFetch(rpc.url, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json", ...rpc.headers },
					body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
					redirect: "manual",
					signal: AbortSignal.timeout(settings.timeoutMs),
				});
				text = await bodyOf(response, method === "eth_getLogs" ? settings.maxLogsBytes : settings.maxReplyBytes);
			} catch (error) {
				const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
				throw timedOut
					? new RpcError(where, method, "timeout", `no answer in ${settings.timeoutMs} ms`)
					: new RpcError(where, method, "transport", "the RPC could not be reached");
			}
			const status = response.status;
			if ((status >= 300 && status < 400) || response.type === "opaqueredirect")
				throw new RpcError(where, method, "http", "the RPC answered a redirect, which banda does not follow", {
					status,
				});
			if (text === undefined)
				throw new RpcError(where, method, "shape", "the answer is larger than banda reads", { tooLarge: true });
			let reply: Static<typeof Reply> | undefined;
			try {
				const parsed: unknown = JSON.parse(text);
				if (Value.Check(Reply, parsed)) reply = parsed;
			} catch {
				reply = undefined;
			}
			const limited = (detail: string, code?: number) => {
				const named = retryAtOf(status === 503 ? 503 : 429, response.headers.get("retry-after"), now());
				const retryAt =
					named ?? now() + Math.min(settings.maxBackoffMs, settings.backoffMs * 2 ** Math.min(bucket.strikes, 30));
				bucket.strikes = named === undefined ? bucket.strikes + 1 : 0;
				bucket.close(retryAt);
				return new RpcError(where, method, "limited", detail, {
					status,
					retryAt,
					...(code === undefined ? {} : { code }),
				});
			};
			if (reply?.error !== undefined) {
				const { code, message: raw } = reply.error;
				const message = scrub(raw, secrets);
				const reverted = code === 3 || REVERTED.test(raw);
				if (status === 429 || code === -32011 || (!reverted && LIMITED.test(raw))) throw limited(message, code);
				bucket.strikes = 0;
				throw new RpcError(where, method, "rpc", message, {
					code,
					...readingsOf(raw),
					...(status === 200 ? {} : { status }),
				});
			}
			if (status === 429) throw limited("HTTP 429");
			if (status === 503 && retryAtOf(503, response.headers.get("retry-after"), now()) !== undefined)
				throw limited("HTTP 503");
			if (!response.ok) throw new RpcError(where, method, "http", `HTTP ${status}`, { status });
			if (reply === undefined || !("result" in reply))
				throw new RpcError(where, method, "shape", "the answer is not JSON-RPC");
			bucket.strikes = 0;
			return reply.result;
		};

		/**
		 * A read: asked again with backoff and jitter after a rate limit, a timeout, a lost connection or a 5xx. A limit
		 * that holds the RPC past `maxBackoffMs` is thrown at once with its `retryAt`, for the caller to come back then.
		 */
		const read = async (method: string, params: readonly unknown[], retry: Retry = "transient"): Promise<unknown> => {
			for (let attempt = 0; ; attempt++) {
				try {
					return await once(method, params);
				} catch (error) {
					if (!(error instanceof RpcError) || !transient(error) || attempt >= settings.retries) throw error;
					if (retry === "not timeout" && error.kind === "timeout") throw error;
					if (error.retryAt !== undefined && error.retryAt - now() > settings.maxBackoffMs) throw error;
					const backoff = Math.min(settings.maxBackoffMs, settings.backoffMs * 2 ** attempt);
					const jittered = backoff / 2 + random() * (backoff / 2);
					const wait = error.retryAt === undefined ? jittered : Math.max(jittered, error.retryAt - now());
					await sleep(wait);
				}
			}
		};

		/**
		 * The check that this RPC serves the network's chain (H-187): run once per client, before the first read it serves,
		 * and kept once it passed. A client is one network and one RPC, by its whole URL and headers (`client`), so another
		 * RPC, even one that only a path or a query tells apart, is a client of its own and checked in turn. A check that
		 * failed is not kept: the next read asks again.
		 */
		let chainChecked: Promise<void> | undefined;
		const servesChain = (): Promise<void> => {
			chainChecked ??= (async () => {
				const served = convert(where, "eth_chainId", Quantity, await read("eth_chainId", []), big);
				if (served !== BigInt(network.chainId))
					throw new RpcError(where, "eth_chainId", "chain", `serves chain ${served}, not ${network.chainId}`);
			})().catch((error: unknown) => {
				chainChecked = undefined;
				throw error;
			});
			return chainChecked;
		};
		/** A read of the chain, once the RPC is known to serve the network's (H-187). */
		const checked = async (method: string, params: readonly unknown[], retry?: Retry): Promise<unknown> => {
			await servesChain();
			return read(method, params, retry);
		};

		const quantity = async (method: string, params: readonly unknown[]) =>
			convert(where, method, Quantity, await checked(method, params), big);

		const client: Rpc = {
			network,
			shown,
			chainId: async () => convert(where, "eth_chainId", Quantity, await read("eth_chainId", []), big),
			checkChain: servesChain,
			blockNumber: () => quantity("eth_blockNumber", []),
			async getBlock(at) {
				if ((at as string) === "pending") throw new RangeError("a pending block is not read whole");
				let raw: unknown;
				try {
					raw = await checked("eth_getBlockByNumber", [tagOf(at), false]);
				} catch (error) {
					if (typeof at === "string" && error instanceof RpcError && error.kind === "rpc" && error.unset === true)
						return null;
					throw error;
				}
				return raw === null ? null : convert(where, "eth_getBlockByNumber", RawBlock, raw, toBlock);
			},
			balance: (address, at = "latest") => quantity("eth_getBalance", [address, tagOf(at)]),
			async call(request, at = "latest") {
				return convert(where, "eth_call", Data, await checked("eth_call", [callObject(request), tagOf(at)]), (d) => d);
			},
			estimateGas: (request) => quantity("eth_estimateGas", [callObject(request)]),
			async getCode(address, at = "latest") {
				return convert(where, "eth_getCode", Data, await checked("eth_getCode", [address, tagOf(at)]), (d) => d);
			},
			nonce: (address, at) => quantity("eth_getTransactionCount", [address, tagOf(at)]),
			async sendRaw(raw) {
				if (!Value.Check(Data, raw) || raw.length <= 2)
					throw new RangeError("signed bytes are 0x-prefixed hex, two digits a byte");
				await servesChain();
				return convert(where, "eth_sendRawTransaction", Hash, await once("eth_sendRawTransaction", [raw]), (h) => h);
			},
			async receipt(hash) {
				const raw = await checked("eth_getTransactionReceipt", [hash]);
				return raw === null ? null : convert(where, "eth_getTransactionReceipt", RawReceipt, raw, toReceipt);
			},
			async getTransaction(hash) {
				const raw = await checked("eth_getTransactionByHash", [hash]);
				return raw === null ? null : convert(where, "eth_getTransactionByHash", RawTransaction, raw, toTransaction);
			},
			async getLogs(filter, range) {
				if (range.span < 1n) throw new RangeError("a span is at least one block");
				const logs: Log[] = [];
				let span = range.span;
				let from = range.from;
				while (from <= range.to) {
					const to = from + span - 1n < range.to ? from + span - 1n : range.to;
					let raw: unknown;
					try {
						raw = await checked(
							"eth_getLogs",
							[
								{
									fromBlock: hex(from),
									toBlock: hex(to),
									...(filter.address === undefined ? {} : { address: filter.address }),
									...(filter.topics === undefined ? {} : { topics: filter.topics }),
								},
							],
							"not timeout",
						);
					} catch (error) {
						const width = to - from + 1n;
						if (!(error instanceof RpcError) || width <= 1n) throw error;
						const refused =
							(error.kind === "rpc" && error.tooWide !== undefined) ||
							error.tooLarge === true ||
							error.status === 413 ||
							error.status === 408 ||
							error.kind === "timeout";
						if (!refused) throw error;
						const told = error.tooWide?.width ?? 0n;
						span = told >= 1n && told < width ? told : width / 2n;
						continue;
					}
					logs.push(...convert(where, "eth_getLogs", Type.Array(RawLog), raw, (all) => all.map(toLog)));
					from = to + 1n;
				}
				return { logs, span };
			},
			async estimateL1Fee(size) {
				const data = `${L1_FEE_UPPER_BOUND}${size.toString(16).padStart(64, "0")}`;
				if (size < 0n || data.length !== 2 + 8 + 64) throw new RangeError("a size is a uint256");
				const answer = await client.call({ to: network.gasPriceOracle, data });
				if (answer.length !== 2 + 64)
					throw new RpcError(where, "eth_call", "shape", "getL1FeeUpperBound did not answer one uint256");
				return BigInt(answer);
			},
		};
		return client;
	};

	return {
		client(network, rpc) {
			const key = JSON.stringify([network.id, rpc.url, rpc.headers]);
			let client = clients.get(key);
			if (client === undefined) {
				client = make(network, rpc);
				clients.set(key, client);
			}
			return client;
		},
	};
}

/**
 * Whether code runs at `address` (H-157): a delegation made outside banda with the exported key. `unchecked` when the
 * RPC could not say: a caller then shows and gives nothing, as it would for code (fail closed).
 */
export async function codeAt(
	address: string,
	network: Network,
	rpc: (network: Network) => Promise<Rpc>,
): Promise<"none" | "code" | "unchecked"> {
	try {
		const code = await (await rpc(network)).getCode(address, "latest");
		return code === "0x" || code === "" ? "none" : "code";
	} catch {
		return "unchecked";
	}
}
