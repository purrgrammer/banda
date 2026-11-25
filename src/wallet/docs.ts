/**
 * What the store holds of the wallets (docs/wallets.md "Architecture"): each wallet's record, its recipients and their
 * Denies, its nonce ledger, the index of its open payments, and every payment with each version signed at its nonce.
 * The key is never here, nor anything derived from it but the address (C20); whether this home can sign now is found
 * at each unlock (C16), never stored. Balances are never stored; incoming transfers are, as rows the chain can give
 * again (C22).
 *
 * Every key that names an address names it in its EIP-55 form, built by the functions below and never by hand (C18).
 */
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import { checksummed } from "./address.ts";
import type { NetworkId } from "./networks.ts";

/** A wallet's place in its life (docs/wallets/model/transitions.json, `wallet`); a removed one has no record. */
export type WalletState = "creating" | "ready" | "archived" | "removing";

/** Whether the owner confirmed the key saved, or chose not to (the `ready_*` states of the model). */
export type Backup = "unsaved" | "saved" | "skipped";

/**
 * What a recipient nobody has set gets: Ask (OD-13), or Deny, the owner's opt-in per wallet (the model's
 * `default_deny`).
 */
export type Default = "ask" | "deny";

/**
 * One showing of a wallet's key: the creation's reveal (`creation`), or banda's desktop app's later (`later`), with the
 * id the desktop told it by, so a retry of that word is the same showing, never a second (C21).
 */
export type Reveal = { at: number; kind: "creation" | "later"; id?: string };

/** How many of a wallet's reveals its record keeps, the newest: the activity's list, never a log that grows for good. */
export const REVEALS_KEPT = 50;

/** Notes in `record` that its key was shown, at `at`, as `kind`, keeping the newest `REVEALS_KEPT`. */
export function noteReveal(record: WalletRecord, at: number, kind: Reveal["kind"], id?: string): void {
	record.reveals = [...(record.reveals ?? []), { at, kind, ...(id === undefined ? {} : { id }) }].slice(-REVEALS_KEPT);
}

export type WalletRecord = {
	/** The owner's name for it. */
	name: string;
	/** Fixed at creation (OD-9). */
	network: NetworkId;
	state: WalletState;
	backup: Backup;
	default: Default;
	/**
	 * The address left banda (Receive, an agent's read, a transaction); while the key is not saved it bars removal (C17).
	 */
	disclosed: boolean;
	/**
	 * The client request id its creation committed with `creating` (C14, C15): the same request again is this creation.
	 */
	request: string;
	/**
	 * The reveal the ready commit grants for the first backup, bound to `request`; its use removes it (C14, C16).
	 * `digest` is the SHA-256 (lowercase hex) of the secret the one answer of the creation that carried it gave: set by
	 * that answer, so no other answer, after a restart either, carries one.
	 */
	reveal?: { expires: number; digest?: string };
	/** Made from a paired device: its creation grants no reveal, since a device never sees a key (H-264, H-276). */
	device?: true;
	/**
	 * Each time its key was shown, oldest first, for the wallet's activity to list (UC-02 A2, H-266, OD-2): the
	 * creation's reveal when it was spent, and each later one banda's desktop app told of. The newest `REVEALS_KEPT`.
	 */
	reveals?: Reveal[];
	/**
	 * The code the owner acknowledged, on the host, at the address (H-157, the model's `acknowledge_code`): the
	 * keccak-256 of what `eth_getCode` read, lowercase hex, and the block it was read at (C22). It allows the owner's
	 * Send while the code read now has the same hash; other code needs a new acknowledgement. Receive keeps the warning.
	 */
	code?: { hash: string; block: number; acknowledged: number };
	/**
	 * The owner's act that last moved its state (archive, unarchive, ...), and the `version` that act's commit gave it:
	 * an act retried after its answer was not yet safe is the same act while this names it at the version it asked plus
	 * one, whatever moved `version` since (a disclosure, a reveal) (C21).
	 */
	moved?: { act: string; version: number };
	/**
	 * Moves with every change to this record, so an answer given on an older one is refused (`version_current`). A
	 * recipient's label and rule move the recipient's own `version`, not this one.
	 */
	version: number;
	/** When it was made. */
	at: number;
};

/** What a recipient's identity names: an address on the wallet's network, or an x402 endpoint as observed. */
type RecipientKind = "address" | "x402";

type Recipient = {
	/** The owner's label; never what a rule binds. */
	name?: string;
	kind: RecipientKind;
	/** A Deny, for every agent of the wallet (OD-1). An Always is a permission, never stored here. */
	deny?: true;
	/**
	 * Drawn from its wallet's `recipientVersion` at every change to its label or its rule, so it never repeats, not even
	 * for an identity forgotten and set again: an owner's act carries the version it saw, and one made on any other is
	 * refused (C8, `version_current`).
	 */
	version: number;
	at: number;
};

/**
 * The wallet's nonce count, never lowered (C5), and what stops its lane. The nonces in flight are those its open
 * payments past `Queued` hold, each read from its member of `Payments` through `WalletsValue.open`.
 */
export type Ledger = {
	next: number;
	/** The chain's count above `next` that stored hashes do not explain, until it is finalized (C5, C21). */
	frozen?: { count: number; at: number };
	/** Two foreign events within 24 h (C7), until the owner resumes it. */
	paused?: { at: number };
	/** When each foreign event of the last 24 h was proven (C7). */
	foreign: number[];
};

/** A payment's state (C12; the model's `payment`). Shown as "In line" while `Queued`. */
export type PaymentState =
	| "Waiting"
	| "Queued"
	| "Signed"
	| "Sent"
	| "Included"
	| "Confirmed"
	| "Refused"
	| "NotPaid"
	| "Failed"
	| "Cancelled"
	| "Restored";

/** The states a payment ends in; every other one is open. */
const TERMINAL: ReadonlySet<PaymentState> = new Set<PaymentState>([
	"Confirmed",
	"Refused",
	"NotPaid",
	"Failed",
	"Cancelled",
	"Restored",
]);

export type WalletsValue = {
	/** By `checksummed` address. */
	wallets: { [wallet: string]: WalletRecord };
	/** By wallet, then by the recipient's identity key: `address:<network>:<address>`, or `x402:…` (C18). */
	recipients: { [wallet: string]: { [identity: string]: Recipient } };
	ledger: { [wallet: string]: Ledger };
	/**
	 * By wallet, the ids of the payments not yet in a terminal state: what a commit enumerates to refuse, sum or drive a
	 * wallet's open payments (C9, C11, C13, C17), reading each one's state from its member of `Payments`. The `Queued`
	 * ones stand in it in queue-commit order, the lane's order (C2): each joins the end in the commit that makes it
	 * `Queued`, and the lane's head is the first of them. Where the others stand means nothing. Kept by `track` in the
	 * commit of every change to a payment.
	 */
	open: { [wallet: string]: string[] };
	/**
	 * By wallet, the last recipient version drawn: it only goes up, and outlives every recipient and the wallet itself,
	 * so no recipient's version is ever drawn twice (C8).
	 */
	recipientVersion: { [wallet: string]: number };
	/**
	 * The epoch of the keychain's lease item this home last took (C16): every signer call that needs the lease names
	 * it, so a lease taken since by another home is refused. The keychain moves first and the store catches up to it
	 * (C15, H-289); it never goes down. Absent until the first creation claims the lease.
	 */
	lease?: number;
	/**
	 * By `checksummed` address, when each wallet removed in the last `REMOVED_KEPT` was: the owner's retry of a removal
	 * whose answer was not yet safe finds the wallet gone, and is its own act, made safe and done, not "no such wallet",
	 * whichever process answered first (C21). Pruned by the next removal; absent until the first one.
	 */
	removed?: { [wallet: string]: number };
};

/** How long a removed wallet's address is kept in `removed`: longer than the owner's Try again ever waits. */
export const REMOVED_KEPT = 24 * 3_600_000;

export const Wallets = defineDoc<WalletsValue>({
	kind: "banda.wallets",
	version: 1,
	scope: "session",
	initial: () => ({ wallets: {}, recipients: {}, ledger: {}, open: {}, recipientVersion: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

/**
 * What a signed version is: the transfer itself (`pay`, the first and every re-sign at a new nonce, C7), a fee bump of
 * it at the same nonce (`bump`), the owner's cancel replacement (`cancel`), or a zero-value transfer to itself that
 * fills a nonce it burnt (`fill`, C5). Finality tells a mined cancel from a mined payment by it (C12, C13).
 */
type VersionKind = "pay" | "bump" | "cancel" | "fill";

/** One signed transaction for the payment, at its nonce. */
type PaymentVersion = {
	kind: VersionKind;
	/** The signed bytes, hex: what is broadcast, the same bytes every time. */
	raw: string;
	hash: string;
	/** The nonce these bytes were signed at. */
	nonce: number;
	/** The gas limit these bytes were signed with, as a decimal string. */
	gas: string;
	/** `maxFeePerGas` and `maxPriorityFeePerGas`, in wei, as decimal strings. */
	maxFee: string;
	tip: string;
	at: number;
};

/**
 * Why a payment ended `Refused`, `NotPaid` or `Failed`, for the card and for a rerun that reports the lane's stored
 * outcome (C13): the wallet could not pay (`unusable`), a Deny (`denied`, at the card, the start commit or a rule's
 * sweep), the owner's Don't pay (`declined`) or Never (`never`), more than the balance holds (`balance`), the owner's
 * cancel or switch-off before it was signed (`cancelled`, `switched_off`), its deadline (`deadline`), or a mined
 * transaction that reverted (`reverted`).
 */
type PaymentReason =
	| "unusable"
	| "denied"
	| "declined"
	| "never"
	| "balance"
	| "cancelled"
	| "switched_off"
	| "deadline"
	| "reverted";

/** Whose call it is: an agent's, or the owner's own Send. */
type Payer = { by: "agent"; agent: string } | { by: "owner" };

export type PaymentValue = Payer & {
	/** Its wallet's `checksummed` address. */
	wallet: string;
	/** The recipient's identity key, as `recipients` is keyed. */
	to: string;
	/** In the asset's base units, as a decimal string. */
	amount: string;
	asset: "native" | "usdc";
	/**
	 * Its fee reserve, fixed at admission, in wei as a decimal string: gas limit × max fee + the L1 fee upper bound + the
	 * operator fee. What admission and the start commit subtract while it is open (C11), and what caps every bump (C6).
	 */
	reserve: string;
	state: PaymentState;
	versions: PaymentVersion[];
	/** The nonce it holds now, taken from the ledger in the start commit (C4). */
	nonce?: number;
	/** The version whose hash a receipt holds, and that receipt's block, while it is there; finality reads its `kind`. */
	included?: { hash: string; block: number };
	/** Set in the commit that ends it `Refused`, `NotPaid` or `Failed`. */
	reason?: PaymentReason;
	/** The foreign transaction at its nonce that sent it from `Sent` back to `Waiting` (C7), for the card. */
	foreign?: { hash: string; at: number };
	/** When the owner's Pay (or an Always) admitted it, for its freshness (C10). */
	approvedAt?: number;
	/** Moves with every change, for a compare-and-set by whoever read it. */
	version: number;
	/** When it was asked for. */
	at: number;
};

/**
 * Every payment, by its id. Only the commit that creates a member passes it whole as the seed; every other open passes
 * `null`, and an id with no member then throws instead of storing one.
 */
export const Payments = defineDocFamily<PaymentValue, PaymentValue | null>({
	kind: "banda.wallet-payments",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => {
		if (seed === null) throw new Error("no such payment");
		return seed;
	},
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 8,
});

/**
 * Brings the wallet's index of open payments in line with a payment's state, in the commit that changes it from `from`
 * (`"new"` for the commit that creates it): a payment that becomes `Queued` goes to the end, as the model's `Append`
 * does, another open one joins the end once and otherwise keeps its place, and a terminal one leaves. An Always that
 * queues several payments in one commit tracks them in their ids' sorted order.
 */
export function track(
	wallets: WalletsValue,
	id: string,
	payment: Pick<PaymentValue, "wallet" | "state">,
	from: PaymentState | "new",
): void {
	const queued = payment.state === "Queued" && from !== "Queued";
	const open = (wallets.open[payment.wallet] ?? []).filter(
		(member) => member !== id || (!TERMINAL.has(payment.state) && !queued),
	);
	if (!TERMINAL.has(payment.state) && !open.includes(id)) open.push(id);
	if (open.length === 0) delete wallets.open[payment.wallet];
	else wallets.open[payment.wallet] = open;
}

/** An incoming transfer, as the chain's log or balance reported it. */
export type IncomingRow = {
	/** Its wallet's `checksummed` address. */
	wallet: string;
	asset: "native" | "usdc";
	/** In base units, as a decimal string. */
	amount: string;
	/** The sender; absent where a balance, not a log, showed it (native transfers). */
	from?: string;
	block: number;
};

/**
 * A stretch of a wallet's native history the indexer could not read, both ends included: the RPC served no state there
 * (`state`, H-215), the wallet's nonce moved and the store does not say what it spent (`unexplained`, H-210), or the
 * wallet has code, so its balance can fall with no nonce move and bisection cannot tell (`code`, H-157). It stays until
 * a pass reads it.
 */
export type IncomingGap = { from: number; to: number; why: "state" | "unexplained" | "code" };

/**
 * Incoming transfers by `incomingKey` or `nativeKey`, how far each network and each wallet is read, and what of each
 * wallet's native history is still unread. Derived: emptied, it is read again from the chain, from each wallet's
 * creation (C22).
 */
export type IncomingValue = {
	rows: { [key: string]: IncomingRow };
	/** By network: the block every row is final to. */
	cursors: { [network: string]: number };
	/** By `checksummed` address: the block the wallet's history is read to and final; absent until its first range commits. */
	read?: { [wallet: string]: number };
	/** By `checksummed` address, oldest first, never overlapping. */
	gaps?: { [wallet: string]: IncomingGap[] };
	/**
	 * By `checksummed` address, the newest block whose final rows are no longer kept: a wallet keeps its newest final rows alone,
	 * so the doc stays bounded however much is sent to it (dust included), and the chain still has the rest (C22).
	 */
	dropped?: { [wallet: string]: number };
};

export const Incoming = defineDoc<IncomingValue>({
	kind: "banda.wallet-incoming",
	version: 1,
	scope: "session",
	initial: () => ({ rows: {}, cursors: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

/**
 * A row a token's `Transfer` log showed, by its transaction and log index (C14): `<hash>:<index>`, the hash lowercase.
 */
export const incomingKey = (txHash: string, logIndex: number): string => `${txHash.toLowerCase()}:${logIndex}`;

/**
 * A row a native balance change showed, found by balance and nonce bisection with no log and maybe no transaction:
 * `native:<block>:<wallet>`. Its amount is the native value that arrived in that block: the balance change plus the
 * value and fees of the wallet's own transactions mined there, as the store holds them. Own sends are told from the
 * store, never from this row.
 */
export const nativeKey = (wallet: string, block: number): string => `native:${block}:${checksummed(wallet)}`;

/**
 * The wallet's effect boundaries this build has, for fault injection: each one an effect hits. A slice that adds an
 * effect (a payment's way through the lane, docs/wallets.md "Paying exactly once") adds its point with it.
 */
export type WalletPoint =
	/** The indexer's rows for a range, read, before the commit that keeps them and moves its cursors. */
	| "wallet:incoming"
	/** The keychain: an item read, written, deleted. */
	| "keychain:read"
	| "keychain:write"
	| "keychain:delete";
