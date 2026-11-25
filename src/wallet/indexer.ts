/**
 * The indexer: incoming payments to the home's wallets, derived from the chain into `Incoming` (C22; docs/wallets.md
 * "The transaction list"). One poller per network, whatever the number of wallets on it (H-198): each range it reads
 * asks one `Transfer` log filter, `{address: [pinned tokens], topics: [Transfer, null, [every wallet]]}`, in the RPC's
 * width, and finds native ETH by balance and nonce bisection between the range's ends (tx-history spike, `bisect.mjs`).
 * Each pass also reads every wallet's balances at the head, for whoever shows them (`IndexerStatus.balances`).
 *
 * `Transfer(from = wallet)` is never asked for: outgoing rows come from the store, so a forged or zero-value
 * `transferFrom` can never stand as a payment a wallet made (H-210). Only the pinned token's logs enter, never a zero
 * value, never a self-transfer, never a log the chain removed (H-160, H-205).
 *
 * Rows are upserted by `(hash, log index)` or `(block, wallet)`, so a range read twice changes nothing (H-212). Each
 * wallet is read from its creation (H-203): the last block whose time is an hour before its record's, found on the
 * chain by the blocks' times, so a home whose `Incoming` is emptied, or that first reads a wallet long after it was
 * paid, reads its whole history again. A wallet's read cursor and its network's cursor move only to the `finalized`
 * head, in the commit that stores the range's rows. Above them rows are Received and read again on each pass, and one
 * the chain no longer shows is deleted (H-213). A native stretch that could not be read stays in `Incoming.gaps` until
 * a pass reads it (H-204, H-215). Every pass tries the stored ones again where something may read them now, asking the
 * RPC nothing for the rest: not a `state` gap wholly below the first block whose state the RPC was found to serve, nor
 * a
 * `code` gap it already showed code in, nor an `unexplained` one the store still says nothing of. Only the node's word
 * that it keeps no state there makes a `state` gap; any other refusal ends the pass with the cursor kept.
 */
import type { Harness, Tx } from "@earendil-works/pi-durable";
import { context } from "../core/store.ts";
import { checksummed } from "./address.ts";
import { IDLE_MS, LOOK_MS, LOOKING_MS } from "./cadence.ts";
import {
	Incoming,
	type IncomingGap,
	type IncomingRow,
	type IncomingValue,
	incomingKey,
	nativeKey,
	type WalletPoint,
	Wallets,
	type WalletsValue,
} from "./docs.ts";
import { type Network, type NetworkId, networks as offered } from "./networks.ts";
import { type Log, type Rpc, RpcError, tokenBalance } from "./rpc.ts";

/** keccak-256 of `Transfer(address,address,uint256)`. */
export const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** An address as a log topic: 32 bytes, lowercase. */
export const topicOf = (address: string): string => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;

/** A stretch of a wallet's native history not in the rows, as `Incoming.gaps` holds it. */
type Gap = IncomingGap & { readonly wallet: string };

/** A wallet's balances as the last pass read them at the head: a dated reading (C11, C22), never stored. */
export type Balance = {
	/** In wei, as a decimal string. */
	readonly native: string;
	/**
	 * In the pinned token's base units, as a decimal string; absent on a network with no pinned token, and null where
	 * no contract at its address answered (another chain, a node behind): unknown, never zero (H-208).
	 */
	readonly usdc?: string | null;
	readonly nonce: number;
	/**
	 * Whether code runs at the address at `block`, through the RPC this pass read (H-157): read with the balances each
	 * pass, so the owner's notice follows the network's RPC as it changes, comes back or the code is cleared.
	 */
	readonly code: boolean;
	readonly block: number;
	readonly at: number;
};

/** How far a network's rows go, for the list to say what it holds (H-207). Derived and kept in memory. */
type IndexerStatus = {
	/** The block every row is final to: what `Incoming.cursors` holds. */
	readonly cursor?: number;
	/** The head the last pass read to. */
	readonly head?: number;
	/** When a pass last read to the head. */
	readonly at?: number;
	/** Why the last pass stopped short, in words that never name the RPC's secrets, and when to ask again. */
	readonly failed?: {
		readonly reason: string;
		readonly at: number;
		/** When the passes began to stop short, this one and each before it since one last read to the head (H-208). */
		readonly since: number;
		readonly retryAt?: number;
		/** The RPC answered the pass's log query with a refusal: money coming in is not listed through it (H-207). */
		readonly logs?: false;
		/** The RPC serves another chain than the network's (H-187): nothing it serves is the network's. */
		readonly otherChain?: true;
	};
	/** The native stretches `Incoming.gaps` holds for the network's wallets: the list is not complete over them. */
	readonly gaps: readonly Gap[];
	/**
	 * The first block whose state the RPC the last whole pass read through serves, where a pass found its window ends
	 * (a pruned node): a `state` gap to it or below is not asked again through that RPC (H-198, H-204).
	 */
	readonly stateFrom?: number;
	/** By `checksummed` address, the last balances read; a failed pass keeps the ones before it, with their block and time. */
	readonly balances: { readonly [wallet: string]: Balance };
};

/** What a wallet's own transactions in one block spent, as the store holds them. */
type Spent = { readonly amount: bigint; readonly nonces: number };

export type IndexerDeps = {
	readonly store: Pick<Harness, "commit" | "snapshot">;
	/** The client for `network`'s RPC, as `config.json` sets it now. */
	readonly rpc: (network: Network) => Promise<Rpc>;
	/** The networks this process offers; default those `networks.ts` gives. */
	readonly networks?: () => readonly Network[];
	/**
	 * What `wallet`'s own transactions mined in `block` spent, value and fees, and how many of its nonces they took, as
	 * the store holds them; undefined when the store holds none there. A block whose nonce moved by another count is
	 * not explained: something signed outside banda moved it too (H-210, C7). Default: the store holds none, so every
	 * own spend leaves a gap.
	 */
	readonly spent?: (wallet: string, block: number) => Promise<Spent | undefined>;
	/** The most blocks one commit covers: a long catch-up commits its rows and its cursor this many blocks at a time. */
	readonly stepBlocks?: number;
	/**
	 * The most final rows a wallet keeps (`IncomingValue.dropped`): older ones are dropped, by whole blocks, in the
	 * commit that makes more final.
	 */
	readonly keepRows?: number;
	/** The first `eth_getLogs` width tried on an RPC not yet probed; the client narrows it on a refusal. */
	readonly spanBlocks?: number;
	/** How often a network is read while nobody waits for it, in ms. */
	readonly intervalMs?: number;
	/** How often a network an open screen looks at is read, in ms (stack.md section 7: about 2 s). */
	readonly lookingMs?: number;
	/** How long one `looking` lasts, in ms: an open screen renews it sooner (src/wallet/cadence.ts). */
	readonly lookMs?: number;
	readonly now?: () => number;
	/** Fault injection (test/fault/): passed before each commit of rows. */
	readonly hit?: (point: WalletPoint) => void;
	/**
	 * Told after a pass that changed what a screen shows of `network`: a balance, a row, a cursor, a gap, or why the
	 * pass stopped short. A pass that read the same again tells only when the screens were last told `FRESHNESS` ago.
	 */
	readonly onChange?: (network: NetworkId) => void;
};

export type Indexer = {
	/** Reads `network` to its head once; a pass already running is the one returned. */
	pass(network: NetworkId): Promise<IndexerStatus>;
	/** Reads every network with a wallet, now and then every `intervalMs`, until `stop`. */
	start(): void;
	/**
	 * Reads `network` (or every network) now, instead of at its next turn: a wallet screen opened, a wallet made. Wakes
	 * merge: a network being read gets one more pass after it, however many wakes came meanwhile.
	 */
	wake(network?: NetworkId): void;
	/**
	 * A screen showing `network` is open (a wallet's page, its Receive): the network is read every `lookingMs` for the
	 * next `lookMs`, then every `intervalMs` again once no screen renews it. Money sent while the owner looks shows in
	 * seconds (UC-14), and an idle daemon reads only at the slow cadence.
	 */
	looking(network: NetworkId): void;
	stop(): Promise<void>;
	status(network: NetworkId): IndexerStatus | undefined;
};

type State = { readonly balance: bigint; readonly nonce: bigint };
type Change = { block: bigint; delta: bigint; own: bigint };

const DEFAULTS = {
	stepBlocks: 10_000,
	spanBlocks: 10_000,
	intervalMs: IDLE_MS,
	lookingMs: LOOKING_MS,
	lookMs: LOOK_MS,
	keepRows: 1_000,
} as const;

/**
 * Drops `wallet`'s oldest final rows (at or below its read cursor) past the newest `keep`, by whole blocks, and says
 * the newest block dropped in `dropped`; then its gaps over what it dropped (`dropGaps`).
 */
function bound(incoming: IncomingValue, wallet: string, keep: number): void {
	const upTo = incoming.read?.[wallet];
	if (upTo !== undefined) {
		const final = Object.entries(incoming.rows)
			.filter(([, row]) => row.wallet === wallet && row.block <= upTo)
			.sort(([, a], [, b]) => b.block - a.block);
		const cut = final[keep]?.[1].block;
		if (cut !== undefined) {
			for (const [key, row] of final) if (row.block <= cut) delete incoming.rows[key];
			incoming.dropped ??= {};
			incoming.dropped[wallet] = Math.max(incoming.dropped[wallet] ?? -1, cut);
		}
	}
	dropGaps(incoming, wallet);
}

/**
 * Takes out of `wallet`'s gaps the blocks at or below what it dropped: no row there is kept again (`keeps`), so a gap
 * there says nothing of the list, and the gaps stay bounded as the rows do however often the key spends outside banda.
 */
function dropGaps(incoming: IncomingValue, wallet: string): void {
	const dropped = incoming.dropped?.[wallet];
	const list = incoming.gaps?.[wallet];
	if (dropped === undefined || list === undefined || incoming.gaps === undefined) return;
	const left = clip(list, Number.NEGATIVE_INFINITY, dropped);
	if (left.length === 0) delete incoming.gaps[wallet];
	else incoming.gaps[wallet] = left;
}

/** Whether a row read now may be kept: none at or below what its wallet dropped is kept again. */
const keeps = (incoming: IncomingValue, row: IncomingRow) => row.block > (incoming.dropped?.[row.wallet] ?? -1);

/**
 * How often, at most, a pass that read the same again tells the open screens anyway, so a balance's "read 1 min ago, at
 * block N" stays true while nothing else moves.
 */
export const FRESHNESS = 60_000;

/** How long before its record a wallet is read from, in seconds: room for a clock that runs ahead of the chain's. */
const BEFORE_CREATION = 3600n;

/**
 * The wallets the indexer reads on `network`, by key: those whose key the keychain kept, archived ones too, since funds
 * still arrive. A `creating` one's address goes to no RPC until its key is kept (H-006), nor a `removing` one's.
 */
function indexed(wallets: Readonly<WalletsValue> | undefined, network: NetworkId): Map<string, number> {
	return new Map(
		Object.entries(wallets?.wallets ?? {})
			.filter(([, record]) => record.network === network && (record.state === "ready" || record.state === "archived"))
			.map(([address, record]) => [checksummed(address), record.at] as const)
			.sort(([a], [b]) => (a < b ? -1 : 1)),
	);
}

/**
 * The row a log stands for, or undefined when it is not an incoming payment: a log of another contract, a removed
 * one, one whose recipient is not indexed (an RPC may answer more than it was asked), a zero value, or a transfer
 * from the wallet to itself.
 */
function rowOfLog(log: Log, token: string, wallets: ReadonlySet<string>): IncomingRow | undefined {
	if (log.removed || log.address.toLowerCase() !== token.toLowerCase()) return undefined;
	if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER) return undefined;
	const [, fromTopic, toTopic] = log.topics;
	if (fromTopic === undefined || toTopic === undefined || !/^0x0{24}/i.test(fromTopic) || !/^0x0{24}/i.test(toTopic))
		return undefined;
	const to = checksummed(`0x${toTopic.slice(26)}`);
	const from = checksummed(`0x${fromTopic.slice(26)}`);
	if (!wallets.has(to) || from === to || log.data.length !== 66) return undefined;
	const value = BigInt(log.data);
	if (value === 0n) return undefined;
	return { wallet: to, asset: "usdc", amount: value.toString(), from, block: Number(log.blockNumber) };
}

/** Whether an incoming row is final (Confirmed) or may still go with a reorg (Received): C12. */
export function incomingConfirmed(
	row: Pick<IncomingRow, "block">,
	cursors: IncomingValue["cursors"],
	network: NetworkId,
) {
	const cursor = cursors[network];
	return cursor !== undefined && row.block <= cursor;
}

/** `gaps` without the blocks `from`..`to`. */
function clip(gaps: readonly IncomingGap[], from: number, to: number): IncomingGap[] {
	return gaps.flatMap((gap) => {
		if (gap.to < from || gap.from > to) return [gap];
		return [...(gap.from < from ? [{ ...gap, to: from - 1 }] : []), ...(gap.to > to ? [{ ...gap, from: to + 1 }] : [])];
	});
}

/** `gaps` with `added` in, in order, a gap touching another of its kind joined to it. */
function join(gaps: readonly IncomingGap[], added: readonly IncomingGap[]): IncomingGap[] {
	const all = [...added.reduce((list, gap) => clip(list, gap.from, gap.to), [...gaps]), ...added].sort(
		(a, b) => a.from - b.from,
	);
	const out: IncomingGap[] = [];
	for (const gap of all) {
		const last = out.at(-1);
		if (last !== undefined && last.why === gap.why && last.to + 1 >= gap.from) last.to = Math.max(last.to, gap.to);
		else out.push({ ...gap });
	}
	return out;
}

/** How a wallet's state is read for bisection: balance and nonce, and whether it has code, at a block. */
type Reader = {
	readonly state: (block: bigint) => Promise<State>;
	readonly coded: (block: bigint) => Promise<boolean>;
	/** Whether it had code at `block`, if already read; never asks the RPC. */
	readonly known: (block: bigint) => boolean | undefined;
};

/**
 * Every block in (lo, hi] where the wallet's balance or nonce changed, oldest first, and the stretches where it had
 * code, which bisection cannot read through. Sound for an account without code: its balance falls only by a
 * transaction it signs, which moves its nonce, so over a stretch where the nonce stood still equal balances at both
 * ends mean nothing happened inside. Code at an account comes and goes only with its nonce (an EIP-7702 delegation set
 * or cleared), so over such a stretch its code is what either end shows, and every stretch inside it has the same:
 * `plain` says a stretch is known to have none. A block whose nonce moved is unread when either end shows code: the
 * transaction that sets a delegation runs the delegate in that same block, which can move ETH out unseen.
 */
async function changes(
	read: Reader,
	lo: bigint,
	hi: bigint,
	atLo: State,
	atHi: State,
	out: Change[],
	coded: IncomingGap[],
	plain = false,
): Promise<void> {
	const still = atLo.nonce === atHi.nonce;
	if (still) {
		if (!plain && (read.known(lo) ?? read.known(hi) ?? (await read.coded(lo)))) {
			coded.push({ from: Number(lo + 1n), to: Number(hi), why: "code" });
			return;
		}
		if (atLo.balance === atHi.balance) return;
	}
	if (hi - lo === 1n) {
		if (!still && ((await read.coded(lo)) || (await read.coded(hi))))
			coded.push({ from: Number(hi), to: Number(hi), why: "code" });
		else out.push({ block: hi, delta: atHi.balance - atLo.balance, own: atHi.nonce - atLo.nonce });
		return;
	}
	const mid = lo + (hi - lo) / 2n;
	const atMid = await read.state(mid);
	await changes(read, lo, mid, atLo, atMid, out, coded, still);
	await changes(read, mid, hi, atMid, atHi, out, coded, still);
}

const words = (error: unknown): string =>
	error instanceof RpcError ? error.message : error instanceof Error ? error.message : "the RPC could not be read";

/** The failures that are an RPC's answer, not a way to it that failed. */
const REFUSALS: ReadonlySet<RpcError["kind"]> = new Set(["rpc", "limited", "http"]);

const failure = (error: unknown, at: number, since = at) => ({
	reason: words(error),
	at,
	since,
	...(error instanceof RpcError && error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
	...(error instanceof RpcError && error.method === "eth_getLogs" && REFUSALS.has(error.kind)
		? { logs: false as const }
		: {}),
	...(error instanceof RpcError && error.kind === "chain" ? { otherChain: true as const } : {}),
});

/** The RPC sets no `finalized` block: nothing can be final, so no cursor can move. */
class Unfinalized extends Error {
	constructor() {
		super("the RPC names no finalized block, so nothing it shows can be kept as final");
	}
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function createIndexer(deps: IndexerDeps): Indexer {
	const settings = { ...DEFAULTS, ...deps };
	const now = deps.now ?? Date.now;
	const networks = deps.networks ?? (() => offered());
	const spent = deps.spent ?? (async () => undefined);
	const statuses = new Map<NetworkId, IndexerStatus>();
	const running = new Map<NetworkId, Promise<IndexerStatus>>();
	/** The networks woken while a pass of theirs ran: each gets one more pass when it ends. */
	const due = new Set<NetworkId>();
	/**
	 * Each client's own number, which the caches below are keyed by: a client is one network's one RPC by its whole URL
	 * and headers, which its masked form (`shown`) does not tell apart, two endpoints of one host being shown alike.
	 */
	const clientIds = new WeakMap<Rpc, number>();
	let nextClient = 0;
	const clientKey = (rpc: Rpc) => {
		let id = clientIds.get(rpc);
		if (id === undefined) {
			id = nextClient++;
			clientIds.set(rpc, id);
		}
		return `${rpc.network.id} ${id}`;
	};
	/** The `eth_getLogs` width each RPC was last read at, by its client: probed once, kept (H-215). */
	const spans = new Map<string, bigint>();
	/** Each wallet's first block, by network and wallet, as the blocks' times give it: found once per process. */
	const starts = new Map<string, bigint>();
	/**
	 * The first block whose state each RPC may serve, by its client: a pruned node's window. The block
	 * below it was seen refused as pruned, and so is every block below that.
	 */
	const stateStarts = new Map<string, bigint>();
	/**
	 * The final gaps each RPC was found to leave as they are, by network, RPC, wallet and stretch, and for an
	 * `unexplained` one what the store said of it then: asked again only once the store says something else (H-198).
	 */
	const lasting = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Until when an open screen looks at each network, by the clock `now`: the screen renews it. */
	const looks = new Map<NetworkId, number>();
	/** The fast cadence's own timer, running only while a screen looks at a network; the slow one goes on beside it. */
	let fast: ReturnType<typeof setTimeout> | undefined;
	/** Each `start` begins a new one; a turn of an earlier one, still running at a stop, schedules nothing. */
	let generation = 0;
	let started = false;
	let ended = false;

	/** What the store now says `wallet` spent in the blocks of an `unexplained` gap; undefined where it says nothing. */
	const said = async (wallet: string, gap: IncomingGap) => {
		const spends: string[] = [];
		for (let block = gap.from; block <= gap.to; block++) {
			const own = await spent(wallet, block);
			if (own !== undefined) spends.push(`${block}:${own.amount}:${own.nonces}`);
		}
		return spends.length === 0 ? undefined : spends.join(",");
	};

	const networkOf = (id: NetworkId): Network => {
		const network = networks().find((one) => one.id === id);
		if (network === undefined) throw new Error(`this process does not offer the network ${id}`);
		return network;
	};

	/** The last block at or before `seconds`, by bisection on the blocks' times; 0 when the chain began after it. */
	const blockAt = async (rpc: Rpc, seconds: bigint, head: bigint): Promise<bigint> => {
		const timeOf = async (block: bigint) => {
			const got = await rpc.getBlock(block);
			if (got === null) throw new Error(`the RPC has no block ${block}`);
			return got.timestamp;
		};
		if ((await timeOf(0n)) > seconds) return 0n;
		if ((await timeOf(head)) <= seconds) return head;
		let lo = 0n;
		let hi = head;
		while (hi - lo > 1n) {
			const mid = lo + (hi - lo) / 2n;
			if ((await timeOf(mid)) <= seconds) lo = mid;
			else hi = mid;
		}
		return lo;
	};

	const snapshotted = async (network: Network, wallets: ReadonlySet<string>) => {
		const value = await deps.store.snapshot(Incoming, context);
		const cursor = value?.cursors[network.id];
		const gaps = Object.entries(value?.gaps ?? {})
			.filter(([wallet]) => wallets.has(wallet))
			.flatMap(([wallet, list]) => list.map((gap) => ({ wallet, ...gap })));
		return { ...(cursor === undefined ? {} : { cursor }), gaps };
	};

	/**
	 * When each network's open screens were last told, so a pass that only read the same again tells them now and then.
	 */
	const toldAt = new Map<NetworkId, number>();
	/** What a pass told the screens before it ended (`shown`): a wallet's first balance, read at the head. */
	const early = new Map<NetworkId, string>();
	/** By network, the client the last failed pass asked (undefined: it had none, the RPC not set or unreadable). */
	const failedThrough = new Map<NetworkId, string | undefined>();

	const read = async (network: Network): Promise<IndexerStatus> => {
		const before = statuses.get(network.id);
		const all = await deps.store.snapshot(Wallets, context);
		const records = indexed(all, network.id);
		const wallets = [...records.keys()];
		const set = new Set(wallets);
		const stored = await deps.store.snapshot(Incoming, context);
		const known = new Set<string>(Object.keys(all?.wallets ?? {}).map((address) => checksummed(address)));
		const strays =
			Object.values(stored?.rows ?? {}).some((row) => !known.has(row.wallet)) ||
			[
				...Object.keys(stored?.read ?? {}),
				...Object.keys(stored?.gaps ?? {}),
				...Object.keys(stored?.dropped ?? {}),
			].some((wallet) => !known.has(wallet));
		/**
		 * Drops what wallets that are gone left, as the commit it runs in reads the wallets: a pass's snapshot is older
		 * than its commits, and another network's pass may have read a wallet made since (C22).
		 */
		const forget = async (tx: Tx, doc: IncomingValue) => {
			const now = new Set<string>(Object.keys((await tx.doc(Wallets)).wallets).map((address) => checksummed(address)));
			for (const [key, row] of Object.entries(doc.rows)) if (!now.has(row.wallet)) delete doc.rows[key];
			for (const map of [doc.read, doc.gaps, doc.dropped])
				for (const wallet of Object.keys(map ?? {})) if (!now.has(wallet)) delete map?.[wallet];
		};
		if (wallets.length === 0) {
			// no request for a network no wallet is on; what a wallet that is gone left still goes
			if (strays) await deps.store.commit(async (tx) => forget(tx, await tx.doc(Incoming)), context);
			const idle = { ...(await snapshotted(network, set)), balances: {} };
			statuses.set(network.id, idle);
			return idle;
		}
		const topics = new Map(wallets.map((wallet) => [wallet, topicOf(wallet)]));
		const token = network.usdc?.address;
		const balances: { [wallet: string]: Balance } = { ...before?.balances };
		for (const wallet of Object.keys(balances)) if (!set.has(wallet)) delete balances[wallet];
		let head: bigint | undefined;
		// the client this pass asks, once there is one: a failure through another than the last one's starts anew
		let client: string | undefined;
		try {
			const rpc = await deps.rpc(network);
			client = clientKey(rpc);
			// the client checks that its RPC serves this network's chain before its first read, and any other RPC is
			// another client, checked in turn (H-187): what a wrong chain serves is never kept as this network's rows
			await rpc.checkChain();
			head = await rpc.blockNumber();
			const final = (await rpc.getBlock("finalized"))?.number;
			if (final === undefined) throw new Unfinalized();
			const settledTo = min(final, head);
			const spanKey = clientKey(rpc);
			const stateKey = spanKey;
			const cache = new Map<string, State>();
			const codes = new Map<string, boolean>();
			const stateAt = (wallet: string) => async (block: bigint) => {
				const key = `${wallet} ${block}`;
				const hit = cache.get(key);
				if (hit !== undefined) return hit;
				const [balance, nonce] = await Promise.all([rpc.balance(wallet, block), rpc.nonce(wallet, block)]);
				const state = { balance, nonce };
				cache.set(key, state);
				return state;
			};
			const readerOf = (wallet: string): Reader => ({
				state: stateAt(wallet),
				async coded(block) {
					const key = `${wallet} ${block}`;
					const hit = codes.get(key);
					if (hit !== undefined) return hit;
					const coded = (await rpc.getCode(wallet, block)) !== "0x";
					codes.set(key, coded);
					return coded;
				},
				known: (block) => codes.get(`${wallet} ${block}`),
			});
			/**
			 * The node's word that it keeps no state there: below its window, a gap. Any other refusal (a timeout, a
			 * header a node behind the URL has not seen) ends the pass, the cursor kept, so it is asked again.
			 */
			const refused = (error: unknown) => error instanceof RpcError && error.kind === "rpc" && error.pruned === true;
			/** `wallet`'s state at `block`, or undefined where the RPC serves none. */
			const served = async (wallet: string, block: bigint) => {
				try {
					return await stateAt(wallet)(block);
				} catch (error) {
					if (refused(error)) return undefined;
					throw error;
				}
			};
			// the head first: the balances to show, and whether code runs at the address there (H-157)
			for (const wallet of wallets) {
				const [state, code, usdc] = await Promise.all([
					stateAt(wallet)(head),
					readerOf(wallet).coded(head),
					token === undefined
						? undefined
						: tokenBalance(rpc, token, wallet, head).then(String, (error: unknown) => {
								// an answer that is not a balance is unknown, never zero (H-208); any other failure ends the pass
								if (error instanceof RpcError && error.kind === "shape") return null;
								throw error;
							}),
				]);
				balances[wallet] = {
					native: state.balance.toString(),
					...(usdc === undefined ? {} : { usdc }),
					nonce: Number(state.nonce),
					code,
					block: Number(head),
					at: now(),
				};
			}
			// a wallet read for the first time shows its balance now, not once its history is read too
			if (deps.onChange !== undefined && wallets.some((wallet) => before?.balances[wallet] === undefined)) {
				const first = { gaps: [], ...before, balances: { ...balances } };
				statuses.set(network.id, first);
				early.set(network.id, await shown(network.id, first));
				toldAt.set(network.id, now());
				deps.onChange(network.id);
			}
			/**
			 * The native rows of `wallet` in (lo, hi], and the stretches of it that could not be read. Where the RPC serves
			 * no state at `lo`, the stretch is read from the first block whose state it serves (a pruned node serves a
			 * window up to the head), and only the blocks below that are a gap.
			 */
			const native = async (wallet: string, lo: bigint, hi: bigint) => {
				const found = new Map<string, IncomingRow>();
				const gaps: IncomingGap[] = [];
				if (hi <= lo) return { found, gaps };
				const whole = { from: Number(lo + 1n), to: Number(hi) };
				/** A block served below the window's start: the window is not where it was found, so no block is known refused. */
				const servedAt = (block: bigint) => {
					if ((stateStarts.get(stateKey) ?? -1n) > block) stateStarts.delete(stateKey);
				};
				const atHi = await served(wallet, hi);
				if (atHi === undefined) {
					// nothing to `hi` is served: a later pass asks nothing of this stretch (H-198)
					if (hi + 1n > (stateStarts.get(stateKey) ?? -1n)) stateStarts.set(stateKey, hi + 1n);
					return { found, gaps: [{ ...whole, why: "state" as const }] };
				}
				servedAt(hi);
				let from = lo;
				let atFrom = await served(wallet, lo);
				if (atFrom !== undefined) servedAt(lo);
				if (atFrom === undefined) {
					// the first block in (lo, hi] whose state is served. `bad` is always a block seen refused as pruned, so a
					// start learned is the block above one
					let bad = lo;
					let good = hi;
					let atGood = atHi;
					const known = stateStarts.get(stateKey);
					if (known !== undefined && known - 1n > lo && known <= hi) {
						// the block below a start found before, asked again: a node behind the URL may serve deeper now
						const below = await served(wallet, known - 1n);
						if (below === undefined) bad = known - 1n;
						else {
							stateStarts.delete(stateKey);
							good = known - 1n;
							atGood = below;
						}
					}
					while (good - bad > 1n) {
						const mid = bad + (good - bad) / 2n;
						const atMid = await served(wallet, mid);
						if (atMid === undefined) bad = mid;
						else {
							good = mid;
							atGood = atMid;
						}
					}
					if (good > (stateStarts.get(stateKey) ?? -1n)) stateStarts.set(stateKey, good);
					gaps.push({ from: whole.from, to: Number(good), why: "state" });
					from = good;
					atFrom = atGood;
				}
				const moved: Change[] = [];
				const coded: IncomingGap[] = [];
				try {
					if (from < hi) await changes(readerOf(wallet), from, hi, atFrom, atHi, moved, coded);
				} catch (error) {
					if (!refused(error)) throw error;
					return { found, gaps: [{ ...whole, why: "state" as const }] };
				}
				gaps.push(...coded);
				for (const change of moved) {
					const block = Number(change.block);
					let arrived = change.delta;
					if (change.own > 0n) {
						const own = await spent(wallet, block);
						if (own === undefined || BigInt(own.nonces) !== change.own) {
							gaps.push({ from: block, to: block, why: "unexplained" });
							continue;
						}
						arrived += own.amount;
					}
					// more left than the store says its own transactions spent: its figure is wrong, so nothing is known
					if (arrived < 0n) {
						gaps.push({ from: block, to: block, why: "unexplained" });
						continue;
					}
					if (arrived > 0n)
						found.set(nativeKey(wallet, block), { wallet, asset: "native", amount: arrived.toString(), block });
				}
				return { found, gaps: join([], gaps) };
			};
			// where each wallet is read from: its read cursor, or its creation
			const lows = new Map<string, bigint>();
			for (const wallet of wallets) {
				const cursor = stored?.read?.[wallet];
				if (cursor !== undefined) {
					lows.set(wallet, BigInt(cursor));
					continue;
				}
				const startKey = `${network.id} ${wallet}`;
				let start = starts.get(startKey);
				if (start === undefined) {
					const seconds = BigInt(Math.floor((records.get(wallet) ?? 0) / 1000)) - BEFORE_CREATION;
					start = await blockAt(rpc, seconds, head);
					starts.set(startKey, start);
				}
				lows.set(wallet, start);
			}
			const lowest = [...lows.values()].reduce(min);
			for (let from = lowest; from < head; ) {
				const to = min(from + BigInt(settings.stepBlocks), head);
				const active = wallets.filter((wallet) => (lows.get(wallet) ?? 0n) < to);
				const found = new Map<string, IncomingRow>();
				const gapsOf = new Map<string, IncomingGap[]>();
				if (token !== undefined) {
					const span = spans.get(spanKey) ?? BigInt(settings.spanBlocks);
					const got = await rpc.getLogs(
						{ address: token, topics: [TRANSFER, null, active.map((wallet) => topics.get(wallet) ?? "")] },
						{ from: from + 1n, to, span },
					);
					spans.set(spanKey, got.span);
					for (const log of got.logs) {
						const row = rowOfLog(log, token, set);
						if (row !== undefined && BigInt(row.block) > (lows.get(row.wallet) ?? 0n))
							found.set(incomingKey(log.transactionHash, Number(log.logIndex)), row);
					}
				}
				for (const wallet of active) {
					const got = await native(wallet, max(from, lows.get(wallet) ?? 0n), to);
					for (const [key, row] of got.found) found.set(key, row);
					gapsOf.set(wallet, got.gaps);
				}
				const settled = settledTo > from ? min(settledTo, to) : undefined;
				deps.hit?.("wallet:incoming");
				await deps.store.commit(async (tx) => {
					const incoming = await tx.doc(Incoming);
					await forget(tx, incoming);
					incoming.read ??= {};
					const read = incoming.read;
					const finalTo = (wallet: string) => incoming.read?.[wallet] ?? -1;
					const gapped = (wallet: string) => (gapsOf.get(wallet) ?? []).some((gap) => gap.why !== "unexplained");
					for (const [key, row] of Object.entries(incoming.rows)) {
						if (!active.includes(row.wallet)) continue;
						const lo = Number(max(from, lows.get(row.wallet) ?? 0n));
						// a row this read of its range reached and no longer shows went with a reorg; one above the head this
						// pass read stays, since a node behind the chain has not seen its block yet and says nothing of it (H-213)
						const inRange = row.block > lo && row.block <= Number(to);
						// a native stretch left unread says nothing of the rows already there
						const kept =
							row.asset === "native" &&
							(gapped(row.wallet) ||
								(gapsOf.get(row.wallet) ?? []).some((gap) => gap.from <= row.block && row.block <= gap.to));
						if (row.block > finalTo(row.wallet) && inRange && !kept && !found.has(key)) delete incoming.rows[key];
					}
					for (const [key, row] of found)
						if (keeps(incoming, row) && (row.block > finalTo(row.wallet) || incoming.rows[key] === undefined))
							incoming.rows[key] = row;
					incoming.gaps ??= {};
					const gaps = incoming.gaps;
					for (const wallet of active) {
						const lo = Number(max(from, lows.get(wallet) ?? 0n));
						const list = join(clip(gaps[wallet] ?? [], lo + 1, Number(to)), [...(gapsOf.get(wallet) ?? [])]);
						if (list.length === 0) delete gaps[wallet];
						else gaps[wallet] = list;
						if (settled !== undefined && Number(settled) > finalTo(wallet) && settled > (lows.get(wallet) ?? 0n))
							read[wallet] = Number(settled);
						bound(incoming, wallet, settings.keepRows);
					}
					const cursor = incoming.cursors[network.id] ?? -1;
					if (settled !== undefined && Number(settled) > cursor) incoming.cursors[network.id] = Number(settled);
				}, context);
				from = to;
			}
			// a stretch left unread by an earlier pass is tried again where something could read it now; each skip below
			// asks the RPC nothing, so what is left unread costs no request a pass (H-198)
			const left = (await deps.store.snapshot(Incoming, context))?.gaps ?? {};
			for (const wallet of wallets) {
				for (const gap of left[wallet] ?? []) {
					// one this pass's ranges just left is not asked again
					if (BigInt(gap.to) > (lows.get(wallet) ?? 0n)) continue;
					// nor one wholly below the state this RPC serves: it would only be refused again
					if (gap.why === "state" && BigInt(gap.to) <= (stateStarts.get(stateKey) ?? 0n)) continue;
					// nor an own spend the store still says nothing of
					const spends = gap.why === "unexplained" ? await said(wallet, gap) : "";
					if (spends === undefined) continue;
					// nor a final stretch this RPC showed code in, a final block keeping the code it had, nor an own spend
					// the store says no more of than when it last left the gap as it is
					const lastKey = `${stateKey} ${wallet} ${gap.from} ${gap.to} ${spends}`;
					if (gap.why !== "state" && lasting.has(lastKey)) continue;
					const got = await native(wallet, BigInt(gap.from - 1), BigInt(gap.to));
					const same = got.gaps[0];
					if (got.gaps.length === 1 && same?.from === gap.from && same.to === gap.to && same.why === gap.why) {
						if (gap.why !== "state") lasting.add(lastKey);
						continue;
					}
					deps.hit?.("wallet:incoming");
					await deps.store.commit(async (tx) => {
						const incoming = await tx.doc(Incoming);
						incoming.gaps ??= {};
						const gaps = incoming.gaps;
						const list = join(clip(gaps[wallet] ?? [], gap.from, gap.to), got.gaps);
						if (list.length === 0) delete gaps[wallet];
						else gaps[wallet] = list;
						// what the wallet dropped may have moved since the snapshot this gap came from
						dropGaps(incoming, wallet);
						for (const [key, row] of got.found) if (keeps(incoming, row)) incoming.rows[key] ??= row;
					}, context);
				}
			}
		} catch (error) {
			const short = {
				...(await snapshotted(network, set)),
				...(before?.head === undefined ? {} : { head: before.head }),
				...(before?.at === undefined ? {} : { at: before.at }),
				failed: (() => {
					const at = now();
					// passes stop short since the first of them through this RPC: one set since has its own since (H-208)
					const same = failedThrough.get(network.id) === client;
					failedThrough.set(network.id, client);
					return failure(error, at, (same ? before?.failed?.since : undefined) ?? at);
				})(),
				balances,
			};
			statuses.set(network.id, short);
			return short;
		}
		const stateFrom = client === undefined ? undefined : stateStarts.get(client);
		const status = {
			...(await snapshotted(network, set)),
			head: Number(head),
			at: now(),
			...(stateFrom === undefined ? {} : { stateFrom: Number(stateFrom) }),
			balances,
		};
		statuses.set(network.id, status);
		return status;
	};

	/**
	 * What a screen shows of `network`, without the times: its balances, why a pass stopped short, and what the store
	 * holds of its wallets (rows by key, how far each is read, its cursor and gaps).
	 */
	const shown = async (network: NetworkId, status: IndexerStatus | undefined) => {
		const wallets = new Set(indexed(await deps.store.snapshot(Wallets, context), network).keys());
		const stored = await deps.store.snapshot(Incoming, context);
		return JSON.stringify([
			Object.entries(status?.balances ?? {}).map(([wallet, one]) => [
				wallet,
				one.native,
				one.usdc,
				one.nonce,
				one.code,
			]),
			status?.head === undefined,
			status?.failed?.reason,
			status?.failed?.logs,
			status?.failed?.otherChain,
			stored?.cursors[network],
			[...wallets].map((wallet) => [wallet, stored?.read?.[wallet], stored?.gaps?.[wallet]]),
			Object.entries(stored?.rows ?? {})
				.filter(([, row]) => wallets.has(row.wallet))
				.map(([key]) => key)
				.sort(),
		]);
	};

	const told = async (id: NetworkId) => {
		const network = networkOf(id);
		if (deps.onChange === undefined) return read(network);
		const before = await shown(id, statuses.get(id));
		const was = statuses.get(id)?.at;
		const status = await read(network);
		const first = early.get(id);
		early.delete(id);
		const moved = (await shown(id, status)) !== (first ?? before);
		const stale = status.at !== undefined && status.at !== was && now() - (toldAt.get(id) ?? 0) >= FRESHNESS;
		if (moved || stale) {
			toldAt.set(id, now());
			deps.onChange(id);
		}
		return status;
	};

	const pass = (id: NetworkId): Promise<IndexerStatus> => {
		const current = running.get(id);
		if (current !== undefined) return current;
		const begun = told(id).finally(() => running.delete(id));
		running.set(id, begun);
		return begun;
	};

	/** A pass of `id` now, or, while one runs, one more after it: never more than one waiting. */
	const kick = async (id: NetworkId): Promise<void> => {
		if (ended) return;
		const current = running.get(id);
		if (current === undefined) {
			// a stop between this wake and its turn ends it: stop waits only for the passes it saw running
			await Promise.resolve()
				.then(() => (ended ? undefined : pass(id)))
				.catch(() => {});
			return;
		}
		if (due.has(id)) return;
		due.add(id);
		await current.catch(() => {});
		due.delete(id);
		await kick(id);
	};

	const schedule = (of: number) => {
		if (!started || ended || of !== generation) return;
		if (timer !== undefined) clearTimeout(timer);
		const retries = [...statuses.values()]
			.map((status) => status.failed?.retryAt)
			.filter((at): at is number => at !== undefined && at > now());
		const wait = Math.min(settings.intervalMs, ...retries.map((at) => at - now()));
		timer = setTimeout(() => void turn(of), Math.max(0, wait));
	};

	const turn = async (of: number) => {
		if (of === generation) timer = undefined;
		await Promise.all(networks().map((network) => kick(network.id)));
		schedule(of);
	};

	/** The networks an open screen still looks at, past looks dropped. */
	const lookedAt = (): NetworkId[] => {
		const at = now();
		for (const [id, until] of looks) if (until <= at) looks.delete(id);
		return [...looks.keys()];
	};

	/** The next fast tick, while a screen looks at a network and none is set yet: it reads those networks alone. */
	const tick = (of: number) => {
		if (!started || ended || of !== generation || fast !== undefined || lookedAt().length === 0) return;
		fast = setTimeout(() => {
			fast = undefined;
			if (of !== generation) return;
			const offered = new Set(networks().map((network) => network.id));
			void Promise.all(
				lookedAt()
					.filter((id) => offered.has(id))
					.map((id) => kick(id)),
			).then(() => tick(of));
		}, settings.lookingMs);
	};

	return {
		pass,
		start() {
			if (started && !ended) return;
			started = true;
			ended = false;
			generation++;
			void turn(generation);
			tick(generation);
		},
		wake(network) {
			for (const id of network === undefined ? networks().map((one) => one.id) : [network]) void kick(id);
		},
		looking(network) {
			looks.set(network, Math.max(looks.get(network) ?? 0, now() + settings.lookMs));
			tick(generation);
		},
		async stop() {
			ended = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			if (fast !== undefined) clearTimeout(fast);
			fast = undefined;
			due.clear();
			await Promise.all([...running.values()].map((one) => one.catch(() => {})));
		},
		status: (network) => statuses.get(network),
	};
}
