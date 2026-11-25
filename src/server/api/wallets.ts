/**
 * The API's shapes for the owner's wallets (docs/wallets.md "Architecture"): each wallet is an account of the wallet
 * connection, shown under Settings, Wallets and never under Connections. Re-exported by `../api.ts`.
 *
 * No shape carries a key: the creation's reveal is written onto its client's connection by the signer child, and a
 * saved copy is checked by its SHA-256 (src/wallet/signer.ts). An RPC is only ever shown masked (H-195).
 */
import type { Backup, WalletState } from "../../wallet/docs.ts";
import type { Signing } from "../../wallet/lifecycle.ts";
import type { NetworkId } from "../../wallet/networks.ts";
import type { SignerCode } from "../../wallet/signer-protocol.ts";
import type { OfflineCode } from "../../wallet/tools.ts";

export type WalletView = {
	/** EIP-55. */
	readonly address: string;
	readonly name: string;
	readonly network: NetworkId;
	readonly state: WalletState;
	readonly backup: Backup;
	/** The address left banda; while the key is not saved it bars removal (C17). */
	readonly disclosed: boolean;
	/** What an act on the wallet carries, so one made on an older view is refused (C8). */
	readonly version: number;
	readonly at: number;
	/** Whether this home can sign for it, as the last check of its key found; absent until one ran (C16). */
	readonly signing?: Signing;
	/** Code runs at its address, as the last check at an unlock or at Receive found (H-157): agents cannot use it. */
	readonly code?: true;
	/**
	 * Made from a paired device, which never sees a key: the computer shows its Save your key step at its next open
	 * (UC-01 A3, H-276).
	 */
	readonly device?: true;
	/** The agents it is switched on for (OD-1), by id. */
	readonly agents: readonly string[];
	/**
	 * When its key was last shown; absent until it was. A new showing changes it, so a screen listing the wallet's
	 * activity reads its first page again, which lists every showing (`WalletIncoming.reveals`): the list stays with the
	 * wallet's own page, never in each push of the wallets, where a long one would grow every client's (H-214).
	 */
	readonly revealed?: number;
	/** The balances the last read of the chain found: dated, never stored, absent until one was read (C11, C22). */
	readonly balance?: {
		/** In wei, decimal. */
		readonly native: string;
		/** In the pinned token's base units, decimal; null where no contract answered: unknown, never zero (H-208). */
		readonly usdc?: string | null;
		readonly block: number;
		readonly at: number;
	};
};

/** A network banda offers, and the RPC it reads it through, masked. */
export type WalletNetworkView = {
	readonly id: NetworkId;
	readonly label: string;
	readonly testnet: boolean;
	/** `maskedRpc` of the owner's RPC, or of the default banda ships; absent when there is neither. */
	readonly rpc?: string;
	/** The owner set it in `config.json`. */
	readonly set: boolean;
	/** banda ships a default RPC for it, which the owner's RPC can go back to. */
	readonly shipped: boolean;
	/** banda pins a USDC contract on it: its wallets hold and receive USDC as well as ETH. */
	readonly usdc?: true;
	/** The block explorer a row of its activity links to, opened by the owner alone (H-201, H-282). */
	readonly explorer?: string;
	/** Why it cannot be used as set, in fixed words that quote nothing the owner wrote (H-195). */
	readonly problem?: string;
	/** The RPC refused the last log query banda sent it: money coming in is not listed through it (H-207). */
	readonly logs?: false;
	/**
	 * The RPC serves another chain than the network's, as the last read of it found (H-187): every wallet on the network
	 * is offline, and nothing is read through it, until the owner sets an RPC of the network's chain.
	 */
	readonly otherChain?: true;
	/**
	 * The last read of the network stopped short, and each since `since` (ms): every balance is unknown until one reads
	 * to the head again, and one not read yet is not being read (H-208).
	 */
	readonly unread?: { readonly since: number };
	/**
	 * The head the last whole read of the network reached: it moves when that read listed money that came in, after the
	 * balances it showed first, so a screen listing it reads again.
	 */
	readonly head?: number;
	/**
	 * How many reads of block times this daemon made for the rows of money that came in on the network: it moves when an
	 * answer's rows were timed behind it, so a screen listing them reads again and finds their times (C22, UC-14).
	 */
	readonly timed?: number;
};

/** `GET /api/wallets`. */
export type WalletsView = {
	readonly wallets: readonly WalletView[];
	readonly networks: readonly WalletNetworkView[];
	/**
	 * Why agents cannot use any wallet now: host mode, or a coding agent connected (H-064, H-065); or `identity`, this
	 * home's id is not the one its wallets were made under (its `auth/device-id` missing or replaced), so nothing of them
	 * runs or changes until the old one is back.
	 */
	readonly offline?: OfflineCode | "identity";
	/**
	 * This computer has no keychain banda can use, as the last creation, check of a key or `POST /api/wallets/keychain`
	 * found (H-309, UC-04 A1); absent until one found it, and again once a creation's key was kept or a check answered.
	 */
	readonly keychain?: "none";
	/**
	 * The lease epoch the store last took (C16); absent until the first creation took one. The desktop app's Restore and
	 * move of signing take the lease past it on a keychain that holds no lease item for the home (H-286).
	 */
	readonly lease?: number;
};

/**
 * A wallet act's error code, answered as `code` beside its words: why the signer did not do what it was asked
 * (`SignerCode`), and for a creation (503) whether it is still `creating` (banda checks again once the keychain
 * answers) or `dropped` (nothing was kept: try again); `wrong_copy` for a saved copy that does not open the wallet;
 * for the creation's reveal, `spent` (used, expired, or never this client's: 403); `unsynced` (503) for a change made
 * that is not on disk yet: the same act again answers it, and a creation's again, with the same request, opens its
 * reveal; `identity` (503) for any act while this home's id is not its wallets' (`WalletsView.offline`).
 */
export type WalletErrorCode = SignerCode | "creating" | "dropped" | "wrong_copy" | "spent" | "unsynced" | "identity";

/**
 * `POST /api/wallets`: make a wallet (UC-01). `request` is the client's own id for this creation, 8 to 128 word
 * characters or dashes: the same one again is the same wallet (C14). Answers the wallet, ready and not backed up.
 */
export type WalletCreate = { readonly request: string; readonly name: string; readonly network: NetworkId };

/**
 * What `POST /api/wallets` answers (201): the wallet and, to the call that drew its key on this computer alone, the
 * creation's reveal: the secret it is spent with, which no other answer carries, and when it expires (C16). A repeat
 * of the creation, and a paired device's, carry none.
 */
export type WalletMade = {
	readonly wallet: WalletView;
	readonly reveal?: { readonly secret: string; readonly expires: number };
};

/**
 * `POST /api/wallets/<address>/reveal`: the creation's reveal, once, within ten minutes, with the secret the creation's
 * answer carried, from this computer alone (C16). Answers `{ address, key }`, `key` as `0x` and 64 lowercase hex.
 */
export type WalletReveal = { readonly request: string; readonly secret: string };
export type WalletRevealed = { readonly address: string; readonly key: string };

/**
 * `POST /api/wallets/<address>/saved`: the owner's saved copy, by the SHA-256 of `0x` and its 64 hex digits in
 * lowercase (UC-02 step 4). A copy that is not the key leaves the wallet Not backed up.
 */
export type WalletSaved = { readonly digest: string };

/**
 * `GET /api/wallets/orphans`: the addresses this home's keychain holds a key for that no wallet names (H-045, UC-01
 * E4), listed and never deleted or adopted; null where the keychain cannot list its items.
 */
export type WalletOrphans = { readonly orphans: readonly string[] | null };

/** `POST /api/wallets/<address>/{archive,unarchive,remove}`: the version the owner's view showed. */
export type WalletAct = { readonly version: number };

/** `POST /api/wallets/<address>/agents/<agent>`: switch the wallet on or off for an agent (OD-1, UC-05). */
export type WalletSwitch = { readonly on: boolean };

/** `POST /api/wallets/<address>/receive` (UC-03): where to be paid, or why not yet. */
export type WalletReceive =
	| { readonly state: "ready"; readonly address: string; readonly network: NetworkId }
	/** The key is not saved, nor its saving skipped: the save step comes first (H-005). */
	| { readonly state: "save_first" }
	/**
	 * Code runs at the address: a warning instead of the address (H-157), which stays once the owner acknowledged it
	 * (`POST /api/wallets/<address>/acknowledge-code`, on this computer: it lets the owner's Send go on).
	 */
	| { readonly state: "code"; readonly acknowledged: boolean }
	/** Whether code runs at the address could not be read: no address is shown until it is (H-157, fail closed). */
	| { readonly state: "unchecked" }
	/**
	 * The key of a wallet whose key was never saved could not be checked in this process: no address is shown until a
	 * check finds a key that opens it (H-021, H-261, fail closed).
	 */
	| { readonly state: "key_unchecked" }
	/**
	 * No key on this computer opens the wallet (its key missing, or another key in its place) and its key was never
	 * saved: nothing sent to the address could be spent, so it is not given out (H-021, H-261).
	 */
	| { readonly state: "unopenable" };

/**
 * `GET /api/wallets/<address>/incoming`: the money that came in, newest first, 50 rows a page (H-214), as the indexer read it
 * from the chain (UC-14 A3, C22): a token's `Transfer` logs and native balance changes. It also asks for a read of the
 * wallet's chain now, unless `?wake=false`: what a page sends when it reads again after a push, which followed a read
 * already.
 */
export type WalletIncoming = {
	readonly rows: readonly IncomingView[];
	/**
	 * On the first page (no `before`): each time the wallet's key was shown, oldest first, for its activity to list: the
	 * creation's reveal, and each later one in banda's desktop app (UC-02 A2, H-266, OD-2); absent until one was.
	 */
	readonly reveals?: readonly RevealView[];
	/** More rows are older than these: `?before=<more>` reads the next page. */
	readonly more?: string;
	/**
	 * Why money coming in may be missing from the rows, in fixed words: a log query refused; the network's RPC serving
	 * another chain (H-187); the network unread, its last read stopped short (`since` says from when, the word
	 * `WalletNetworkView.unread` uses); native stretches not read (`gaps` says which kinds); a first read under way.
	 */
	readonly incomplete?: "logs" | "chain" | "unread" | "gaps" | "reading";
	/** With `unread`: when the network's last read stopped short, the passes since each stopping short (H-208). */
	readonly since?: number;
	/**
	 * With `gaps`, the kinds of native stretch the rows leave out, each said as it is: `again`, stretches the indexer
	 * asks the RPC of again; `code`, code ran at the address there, so its ETH could not be told apart; `pruned`, the
	 * newest block of the stretches the network's RPC serves no state for, which the indexer does not ask again through
	 * it: the ETH listed is complete after it (H-204), `prunedAt` its time once read.
	 */
	readonly gaps?: {
		readonly again?: true;
		readonly code?: true;
		readonly pruned?: number;
		readonly prunedAt?: number;
	};
	/**
	 * The blocks where the wallet's nonce moved by more than banda's own transactions: something signed with its key
	 * outside banda spent from it (H-210), newest first, each with its time once read. A page lists those of its own
	 * stretch of blocks, from the newest row it lists down to the oldest (to the beginning on the last page).
	 */
	readonly outside?: readonly OutsideView[];
	/**
	 * With `incomplete`, the block the wallet's history is read and final to, and that block's time once read: the rows
	 * are whole up to it (H-207); absent until a first stretch of it was read.
	 */
	readonly through?: { readonly block: number; readonly at?: number };
	/**
	 * With `unread`: the head this process last read the network to, past `through` when it is there. The rows
	 * above `through` are listed up to it though not final yet: money after it is what is not listed (H-207, H-208).
	 */
	readonly head?: number;
	/**
	 * On the last page: the newest block whose rows banda no longer keeps, only the newest of a long history being kept
	 * (the chain still has the rest, C22).
	 */
	readonly dropped?: number;
};

/**
 * Money that left the wallet by a transaction signed outside banda (H-210): the block (or stretch `from`..`block`) its
 * nonce moved in. What left is not known: the chain tells a balance, not what one transaction of it spent.
 */
export type OutsideView = {
	/** `outside:<from>:<block>`. */
	readonly id: string;
	readonly from: number;
	readonly block: number;
	/** The block's time, in ms; absent until it was read. */
	readonly at?: number;
	/** Final, or still able to go with a reorg. */
	readonly confirmed: boolean;
};

/** One showing of a wallet's key, as its activity lists it. */
export type RevealView = { readonly at: number; readonly kind: "creation" | "later" };

export type IncomingView = {
	/** `<hash>:<log index>`, or `native:<block>:<wallet>`. */
	readonly id: string;
	readonly asset: "native" | "usdc";
	/** In base units, decimal. */
	readonly amount: string;
	/** The sender, EIP-55; absent for native money, which a balance showed. */
	readonly from?: string;
	readonly block: number;
	/** The block's time, in ms; absent until it was read. */
	readonly at?: number;
	/** Final (`finalized`), or Received and still able to go with a reorg (C12). */
	readonly confirmed: boolean;
};

/**
 * `PUT /api/wallets/rpc/<network>`: the owner's RPC for a network, or null for the default banda ships (H-195, H-196).
 * Answers the network as it is after, its RPC masked.
 */
export type WalletRpcSet = { readonly url: string | null };

/** The wallets, pushed on the shell stream whenever they change. */
export type WalletsShellEvent = { readonly type: "wallets"; readonly wallets: WalletsView };
