/**
 * A wallet's life (docs/wallets/model/transitions.json, machines `wallet` and `signing`; UC-01, UC-02, UC-04): made,
 * saved or not, archived and back, removed; and whether this home can sign for it now. Two stores hold a wallet, the
 * store and the keychain, and every change crosses them in one order (C15): a creation commits `creating` with the
 * address the signer drew before anything is written, the signer finds the item empty, writes it and reads it back,
 * and only then is the wallet ready and an account of the wallet connection; a removal commits `removing`, checks
 * again that nothing holds the wallet (C17), deletes the item only while it holds the wallet's own key, and then
 * commits it removed. A kill anywhere leaves a record `recover` settles from the item: a creation the keychain kept is
 * ready, any other is dropped; an item no record names, or one that holds another key, is never deleted or adopted
 * (H-045).
 *
 * Every decision is `walletStep` or `signingStep`, the model's rows as code; the operations read the atoms the rows
 * name (the item, the keychain, the funds, the version the owner saw) and apply what the step gives. The key never
 * reaches this module: the signer child holds it (C20), and what it answers is an address or a fixed code.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Tx } from "@earendil-works/pi-durable";
import { log } from "../core/activity.ts";
import { keyedSerial } from "../core/keyed-serial.ts";
import { plainLine } from "../core/plain-line.ts";
import { type Address, checksummed } from "./address.ts";
import {
	type PaymentState,
	Payments,
	REMOVED_KEPT,
	track,
	type WalletRecord,
	Wallets,
	type WalletsValue,
} from "./docs.ts";
import { walletAccount } from "./home-id.ts";
import { NAME_MAX, walletLabel } from "./label.ts";
import { type NetworkId, networkOf } from "./networks.ts";
import type { Signer } from "./signer-client.ts";
import type { Outcome, SignerCode } from "./signer-protocol.ts";

/** A wallet's state in the model; `none`, `removed` and `dropped` have no record. */
export type WalletModel =
	| "none"
	| "creating"
	| "ready_unsaved"
	| "ready_saved"
	| "ready_skipped"
	| "archived"
	| "removing"
	| "removed"
	| "dropped";

/** What the keychain holds under the wallet's account: nothing, the key that derives its address, or another. */
export type Item = "empty" | "ours" | "other";

/** The atoms the `wallet` machine's guards read. */
export type WalletAtoms = {
	/** The keychain answered. */
	readonly kc_up: boolean;
	readonly item: Item;
	readonly pasted_derives: boolean;
	/** The balance at `safe` is above zero, or could not be read. */
	readonly funds: boolean;
	/** A payment of the wallet is not terminal. */
	readonly inflight: boolean;
	readonly address_disclosed: boolean;
	readonly saved: boolean;
	/** The owner's act carries the record's version now (C8). */
	readonly version_current: boolean;
};

/** The events of the `wallet` machine this module answers; reveal, Receive and the code warning are the routes'. */
export type WalletEvent =
	| "create"
	| "keychain_write"
	| "read_back"
	| "restart"
	| "confirm_saved"
	| "skip_save"
	| "archive"
	| "unarchive"
	| "begin_remove"
	| "delete_item"
	| "item_gone";

/** A model state in the owner's words. */
const STANDING: { readonly [state in WalletModel]: string } = {
	none: "gone",
	creating: "still being made",
	ready_unsaved: "not backed up yet",
	ready_saved: "backed up",
	ready_skipped: "not backed up",
	archived: "archived",
	removing: "being removed",
	removed: "gone",
	dropped: "gone",
};

/**
 * Why a wallet's key is not saved, or its saving skipped, from `from`, in the owner's words: what to do instead, never a
 * rule its own state seems to meet (an archived wallet not backed up is still not one the save step is for).
 */
function notSaving(from: WalletModel): string {
	if (from === "archived") return "bring it back first, and save its key from there";
	if (from === "ready_saved") return "its key is saved already";
	if (from === "creating") return "save its key once it is made";
	return "there is no key of it to save now";
}

const READY: ReadonlySet<WalletModel> = new Set<WalletModel>(["ready_unsaved", "ready_saved", "ready_skipped"]);

/** Whether removal may go on (C17): nothing held, and the key saved unless the address never left banda. */
const removable = (a: Pick<WalletAtoms, "funds" | "inflight" | "saved" | "address_disclosed">): boolean =>
	!a.funds && !a.inflight && (a.saved || !a.address_disclosed);

/**
 * Where `event` takes a wallet in `from`, given the atoms; the same state when it answers without a change (a
 * refusal), undefined when the model has no such event from that state.
 */
export function walletStep(from: WalletModel, event: WalletEvent, a: WalletAtoms): WalletModel | undefined {
	switch (event) {
		case "create":
			return from === "none" ? "creating" : undefined;
		case "keychain_write":
			if (from !== "creating") return undefined;
			if (!a.kc_up) return "creating";
			return a.item === "empty" ? "creating" : "dropped";
		case "read_back":
		case "restart":
			if (from !== "creating") return undefined;
			if (!a.kc_up) return "creating";
			return a.item === "ours" ? "ready_unsaved" : "dropped";
		case "confirm_saved":
			// a skipped save is not final: a later reveal's paste-back backs the wallet up too (H-266)
			if (from !== "ready_unsaved" && from !== "ready_skipped") return undefined;
			return a.pasted_derives ? "ready_saved" : from;
		case "skip_save":
			return from === "ready_unsaved" ? "ready_skipped" : undefined;
		case "archive":
			if (!READY.has(from)) return undefined;
			return a.version_current ? "archived" : from;
		case "unarchive":
			if (from !== "archived") return undefined;
			if (!a.version_current) return from;
			return a.saved ? "ready_saved" : "ready_skipped";
		case "begin_remove":
			if (!READY.has(from) && from !== "archived") return undefined;
			return a.version_current && removable(a) ? "removing" : from;
		case "delete_item":
			if (from !== "removing") return undefined;
			if (!a.kc_up || a.item === "empty") return from;
			if (a.item === "other") return "removed";
			return removable(a) ? from : "archived";
		case "item_gone":
			return from === "removing" ? "removed" : undefined;
	}
}

/** Whether this home can sign for a wallet now, found at each unlock and never stored (C16). */
export type SigningState = "online" | "locked" | "key_missing" | "wrong_key" | "other_home" | "offline_host_mode";

export type SigningEvent = "unlock_check" | "keychain_locks" | "item_lost" | "restore_key" | "lease_moved";

export type SigningAtoms = {
	/** The key read derives the wallet's address. */
	readonly derives: boolean;
	/** This home holds the lease at the epoch its store took. */
	readonly lease_mine: boolean;
	/** Agents' commands run on this computer as the owner (H-064). */
	readonly host_mode: boolean;
};

/**
 * What this home's signing for a wallet is now: the model's state, and the signer's code of the last reading that
 * refused, the most specific reason the wallet shows (H-317): a keychain that is `locked` because it was `denied`,
 * timed out or is `ambiguous` says which.
 */
export type Signing = { readonly state: SigningState; readonly code?: SignerCode };

/** As `walletStep`, for the `signing` machine. */
export function signingStep(from: SigningState, event: SigningEvent, a: SigningAtoms): SigningState | undefined {
	switch (event) {
		case "keychain_locks":
			return from === "key_missing" ? from : "locked";
		case "item_lost":
			return "key_missing";
		case "unlock_check":
			if (from === "key_missing") return undefined;
			if (!a.derives) return "wrong_key";
			if (!a.lease_mine) return "other_home";
			return a.host_mode ? "offline_host_mode" : "online";
		case "restore_key":
			if (from !== "key_missing") return undefined;
			return a.derives ? "online" : "key_missing";
		case "lease_moved":
			if (from !== "online" && from !== "other_home") return undefined;
			return a.lease_mine ? "online" : "other_home";
	}
}

/** The model's state of a record. */
export function modelOf(record: WalletRecord | undefined): WalletModel {
	if (record === undefined) return "none";
	if (record.state === "ready") return `ready_${record.backup}`;
	return record.state;
}

/** Puts a record in a model state that has one. */
function enter(record: WalletRecord, to: WalletModel): void {
	if (to === "ready_unsaved" || to === "ready_saved" || to === "ready_skipped") {
		record.state = "ready";
		record.backup = to === "ready_unsaved" ? "unsaved" : to === "ready_saved" ? "saved" : "skipped";
	} else if (to === "creating" || to === "archived" || to === "removing") record.state = to;
	else throw new Error(`a wallet ${to} has no record`);
}

/** Why a commit made is not answered yet: it could not be made to survive a power cut (C21). */
export const UNSYNCED = "the change is made, but banda could not yet make it safe on disk: try again";

/** How long the reveal the ready commit grants stays usable (C16). */
export const REVEAL_WINDOW = 10 * 60_000;

/** A refusal in the owner's words, with the HTTP status a route answers it with; never the key or a native message. */
export class WalletRefused extends Error {
	readonly status: 400 | 404 | 409 | 503;
	readonly code: SignerCode | "unsynced" | undefined;
	constructor(message: string, status: 400 | 404 | 409 | 503, code?: SignerCode | "unsynced") {
		super(message);
		this.name = "WalletRefused";
		this.status = status;
		this.code = code;
	}
}

/** Why the signer did not do what it was asked, in the owner's words. */
export const WORDS: { readonly [code in SignerCode]: string } = {
	locked: "the keychain is locked: unlock it and try again",
	missing: "the wallet's key is missing from this computer",
	wrong_key: "the key in the keychain does not open this wallet",
	no_keychain: "this computer has no keychain banda can use",
	denied: "the keychain's prompt was refused",
	timeout: "the keychain did not answer in time",
	exists: "the keychain already holds an item where the key was to go",
	ambiguous: "the keychain holds more than one item for this wallet",
	other_home: "this wallet is used by another banda home",
	debugging: "wallets are offline while a debugger could read banda",
	refused: "the signer refused",
	other: "the keychain could not be used",
};

/** The signer's refusals that are the home's, not one wallet's: its one keychain, and its one lease item (C16). */
const HOME_WIDE: ReadonlySet<SignerCode> = new Set<SignerCode>([
	"locked",
	"no_keychain",
	"denied",
	"timeout",
	"other_home",
	"debugging",
]);

const unavailable = (code: SignerCode, then = ""): WalletRefused =>
	new WalletRefused(`${WORDS[code]}${then}`, 503, code);

/**
 * The signer's calls the lifecycle makes. A home's calls answer in the order they were made, each once the one before
 * made its last effect (src/wallet/signer-client.ts): a creation that recovery or a second lifecycle settles while its
 * write is under way is read after that write, never dropped beside it.
 */
export type LifecycleSigner = Pick<Signer, "lease" | "leased" | "create" | "derive" | "remove" | "find">;

/** What the wallet connection does with a wallet's account: src/server/capabilities.ts. */
type WalletAccounts = {
	addWallet(
		wallet: { readonly account: string; readonly address: string; readonly network: NetworkId },
		ctx?: Context,
	): Promise<unknown>;
	/** Ends the wallet's account in the commit where `removed` drops its record, and only when `removed` says it did. */
	removeWallet(address: string, removed: (tx: Tx) => Promise<boolean>, ctx?: Context): Promise<boolean>;
	/** Whether the wallet's account is there with its credentials whole and current on disk. */
	walletKept(address: string, ctx?: Context): Promise<boolean>;
};

export type LifecycleOptions = {
	readonly harness: { commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> };
	readonly signer: LifecycleSigner;
	/** The home's id (src/wallet/home-id.ts), which names its keychain items. */
	readonly home: string;
	readonly accounts: WalletAccounts;
	/** Whether the balance at `safe` is above zero, in any asset; undefined when it could not be read (C17). */
	readonly funded: (address: Address, network: NetworkId) => Promise<boolean | undefined>;
	/**
	 * Whether an x402 authorization the wallet signed is still live, read in the commit that decides a removal: it holds
	 * the wallet as an open payment does (C17, UC-18). Without it, no authorization holds a wallet.
	 */
	readonly authorized?: (tx: Tx, address: string) => Promise<boolean>;
	/**
	 * Told, in the commit that archives a wallet, of each payment it refused that had not been signed: the lane ends the
	 * owner's Wait a Waiting payment has open (its card), in the same commit (C17, UC-17).
	 */
	readonly refused?: (tx: Tx, payment: string, from: PaymentState) => Promise<void>;
	/**
	 * Told, in a commit of its own, when `unlockCheck` finds the key of a wallet that was `key_missing` back and moves it
	 * through `restore_key`: the lane answers its 'key missing' Wait there (C9, H-290). The state stays `key_missing`
	 * until that commit is made. The signing state is not stored (C16), so after a restart the lane checks its own Wait.
	 */
	readonly restored?: (tx: Tx, address: string) => Promise<void>;
	/** Host mode: agents' commands run on this computer as the owner, so nothing signs (H-064). */
	readonly host?: () => boolean;
	/**
	 * Told whenever a check moves a wallet's signing state (kept in memory, never stored, so no commit tells the
	 * screens): the area pushes the wallets to every open screen then, not only to the one that asked (C22, H-317).
	 */
	readonly onSigning?: () => void;
	/**
	 * Makes what was committed survive a power cut (C21): after the `creating` commit, before the keychain is written,
	 * so an item is never kept that no record names; after the ready commit, before its key is shown; after the
	 * `removing` commit, before the item is deleted; after the removal, and after each of the owner's acts, before the
	 * owner is told. Default: none.
	 */
	readonly sync?: () => Promise<void>;
	readonly now?: () => number;
	readonly context: Context;
};

export type Lifecycle = ReturnType<typeof openLifecycle>;

/**
 * A creation's answer: the wallet and, to the one answer of the creation that carries it, the secret its reveal is
 * spent with (C16). That is the first answer from this process that finds the wallet ready with its reveal unclaimed
 * by it: the call that drew the key or, when that one could not carry it (the keychain answered late, the ready commit
 * did not sync, a restart came between), the same request again. A paired device's answer carries none, nor does any
 * after it in the same process; the first after a restart claims anew, and the secret before it stops spending.
 */
export type Made = { readonly address: string; readonly record: WalletRecord; readonly secret?: string };

/** The SHA-256 of a creation's reveal secret, lowercase hex: all the store keeps of it (C16). */
export const revealDigest = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** The open payments a wallet leaving service ends in its commit: those not yet signed (C17). */
const UNSIGNED: ReadonlySet<PaymentState> = new Set<PaymentState>(["Waiting", "Queued"]);

const ATOMS: WalletAtoms = {
	kc_up: true,
	item: "empty",
	pasted_derives: false,
	funds: false,
	inflight: false,
	address_disclosed: false,
	saved: false,
	version_current: true,
};

/** A plain copy of what a commit read: a draft is the store's own and leaves no commit. */
const copy = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

export function openLifecycle(options: LifecycleOptions) {
	const { harness, signer, accounts, context } = options;
	const now = options.now ?? Date.now;
	const host = options.host ?? (() => false);
	const sync = options.sync ?? (async () => {});
	/** `sync`, refused in the owner's words when it fails: what was committed is answered once it is on disk (C21). */
	const durable = async () => {
		try {
			await sync();
		} catch {
			throw new WalletRefused(UNSYNCED, 503, "unsynced");
		}
	};
	const authorized = options.authorized ?? (async () => false);
	const signing = new Map<string, Signing>();
	/** Keeps `to` as `key`'s signing, telling `onSigning` when that changes what a screen shows. */
	const setSigning = (key: string, to: Signing): void => {
		const was = signing.get(key);
		signing.set(key, to);
		if (was?.state !== to.state || was?.code !== to.code) options.onSigning?.();
	};
	/** The creations under way in this lifecycle, by request: the same request again waits on the same one (C14). */
	const making = new Map<string, { readonly run: Promise<Made>; readonly name: string; readonly network: NetworkId }>();
	/**
	 * The reveal digests this lifecycle committed: a claim it made is answered once, and every repeat after it in this
	 * process none. One the store holds that is not among them was committed by a process that is gone, which may have
	 * died before its answer went (C16, H-268): the next repeat claims again, with a new secret.
	 */
	const claimedHere = new Set<string>();

	/**
	 * Runs `step` once every earlier step of the same wallet ended: what a step read, what it decided and what it did to
	 * the keychain and the store never interleave with another's (a removal's re-check and its delete, a start's
	 * recovery beside the owner's retry).
	 */
	const serial = keyedSerial();

	const commit = <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context) => harness.commit(change, ctx);
	const recordOf = (address: string, ctx: Context) =>
		commit(async (tx) => copy((await tx.doc(Wallets)).wallets[address]), ctx);

	/** The lease as the keychain holds it, the store caught up to it; the first creation claims one (C15, H-289). */
	async function catchUp(
		stored: number | undefined,
		claim: boolean,
		ctx: Context,
	): Promise<Outcome<{ epoch: number }>> {
		let epoch: number | undefined;
		// twice: a claim that lost to this home's own concurrent one finds that one's lease the second time
		for (let tries = 0; epoch === undefined; tries++) {
			const leased = await signer.leased();
			if (!leased.ok) return leased;
			if (leased.lease === null) {
				// a store that took a lease this keychain holds no item for: the keychain lost banda's items (a reset, a wipe)
				// or the home came from another computer. Either way no key is here, and none of another home either: every
				// key reads as missing, and the owner's Restore takes the lease back with a key it proved (H-021, H-286). Only
				// the owner's act takes it: a creation is refused as this home's lease is not here
				if (stored !== undefined) return { ok: false, code: claim ? "other_home" : "missing" };
				if (!claim) return { ok: false, code: "other_home" };
				const claimed = await signer.lease(null);
				if (claimed.ok) epoch = claimed.epoch;
				else if (claimed.code !== "other_home" || tries > 0) return claimed;
			} else if (!leased.lease.mine || leased.lease.epoch < (stored ?? 0)) return { ok: false, code: "other_home" };
			else epoch = leased.lease.epoch;
		}
		const taken = epoch;
		await commit(async (tx) => {
			const wallets = await tx.doc(Wallets);
			if ((wallets.lease ?? 0) < taken) wallets.lease = taken;
		}, ctx);
		return { ok: true, epoch: taken };
	}

	/** Runs a signer call at the store's lease epoch, and once more at the keychain's if that moved on and is ours. */
	async function withLease<T>(
		call: (lease: number) => Promise<Outcome<T>>,
		claim: boolean,
		ctx: Context,
	): Promise<Outcome<T>> {
		const stored = await commit(async (tx) => (await tx.doc(Wallets)).lease, ctx);
		let first: Outcome<T> | undefined;
		if (stored !== undefined) {
			first = await call(stored);
			if (first.ok || first.code !== "other_home") return first;
		}
		const caught = await catchUp(stored, claim, ctx);
		// a keychain with no lease item says why the call at the store's epoch was refused: the key is not here
		if (!caught.ok) return caught.code === "missing" ? caught : (first ?? caught);
		if (caught.epoch === stored && first !== undefined) return first;
		return call(caught.epoch);
	}

	/** The keychain's answer about a wallet's item, as the model's atoms. */
	function itemOf(outcome: Outcome<unknown>): Pick<WalletAtoms, "kc_up" | "item"> {
		if (outcome.ok) return { kc_up: true, item: "ours" };
		if (outcome.code === "missing") return { kc_up: true, item: "empty" };
		if (outcome.code === "wrong_key") return { kc_up: true, item: "other" };
		return { kc_up: false, item: "empty" };
	}

	/**
	 * A `creating` record settled from what the keychain holds: ready when the key it names is there and derives its
	 * address, dropped when the keychain answers otherwise, left creating when it does not answer. The ready commit
	 * grants the creation's reveal; the account follows it.
	 */
	async function settle(address: string, event: "read_back" | "restart", ctx: Context): Promise<WalletModel> {
		const before = await recordOf(address, ctx);
		if (before?.state !== "creating") return modelOf(before);
		const proof = await withLease((lease) => signer.derive(lease, address as Address), false, ctx);
		const to = walletStep("creating", event, { ...ATOMS, ...itemOf(proof) }) as WalletModel;
		const done = await commit(async (tx) => {
			const wallets = await tx.doc(Wallets);
			const record = wallets.wallets[address];
			if (record?.state !== "creating" || record.request !== before.request) return modelOf(record);
			if (to === "creating") return to;
			if (to === "dropped") {
				delete wallets.wallets[address];
				await log(tx, { at: now(), what: "A wallet was not made: the keychain did not keep its key" });
				return to;
			}
			enter(record, to);
			record.version++;
			// a paired device's creation grants none: a device never sees a key (H-264)
			if (record.device !== true) record.reveal = { expires: now() + REVEAL_WINDOW };
			return to;
		}, ctx);
		// 'nothing was made' is answered once the drop is on disk (C21)
		if (done === "dropped") await durable();
		if (READY.has(done)) {
			// the account follows the ready commit whether or not it is on disk yet: a ready wallet is never left without it
			const synced = await sync().then(
				() => true,
				() => false,
			);
			await join(address, ctx);
			// the reveal stays unclaimed: the same request again, once synced, is the answer that carries it
			if (!synced) throw new WalletRefused(UNSYNCED, 503, "unsynced");
		}
		return done;
	}

	/**
	 * The wallet joins the wallet connection as its account, once (a wallet is made, never signed in to): a kill after
	 * the ready commit leaves it to `recover`. An account whose credentials a power cut lost, or left from another
	 * generation, is joined again, its switches kept: they hold no secret, only what the record says.
	 */
	async function join(address: string, ctx: Context): Promise<void> {
		const record = await recordOf(address, ctx);
		if (record === undefined || record.state === "creating" || record.state === "removing") return;
		if (await accounts.walletKept(address, ctx)) return;
		await accounts.addWallet(
			{ account: walletAccount(options.home, address as Address), address, network: record.network },
			ctx,
		);
	}

	/**
	 * A request id names one creation with one name and one network (C14, OD-9): a repeat that asks for others is
	 * refused, naming the wallet the request made, never answered with that wallet as if it were what was asked.
	 */
	const sameCreation = (
		address: string,
		record: { readonly name: string; readonly network: NetworkId },
		name: string,
		network: NetworkId,
	): void => {
		if (record.name === name && record.network === network) return;
		const on = networkOf(record.network)?.label ?? record.network;
		throw new WalletRefused(
			`this creation already made ${walletLabel(address, record)} on ${on}: its name and network stay as they were made, so make another wallet for a different one`,
			409,
		);
	};

	const requested = async (tx: Tx, request: string): Promise<string | undefined> =>
		Object.entries((await tx.doc(Wallets)).wallets).find(([, record]) => record.request === request)?.[0];

	/**
	 * What a creation answers: the ready wallet, or why it is not ready yet. A dropped one showed no address, so the
	 * same request again draws a new key: the owner is told to try again.
	 */
	async function answer(address: string, ctx: Context): Promise<Made> {
		const record = await recordOf(address, ctx);
		if (record === undefined)
			throw new WalletRefused("the keychain did not keep the wallet's key: nothing was made, try again", 503);
		if (record.state === "creating")
			throw new WalletRefused(
				"the keychain did not answer: banda checks again once it does, and if it did not keep the key nothing is made",
				503,
			);
		return { address, record };
	}

	/**
	 * The creation's answer, carrying its reveal's secret when it is the first from this process to find the reveal
	 * unclaimed (C16): the secret's SHA-256 is committed into the reveal and on disk before the answer goes, so no other
	 * answer in this process carries one. A claim that could not be synced is taken back and refused as not yet safe, so
	 * the same request again carries it. A claim a process that is gone committed may never have reached its client (it
	 * was killed between the commit and the answer): the first repeat after a restart claims again, its new digest in
	 * place of the old, so the secret that answer carried, if it went, no longer spends and still one secret does.
	 * `synced`: the ready commit was just made safe by the call that drew the key, so an answer with no secret needs no
	 * barrier of its own.
	 */
	async function claim(address: string, request: string, device: boolean, ctx: Context, synced = false): Promise<Made> {
		const made = await answer(address, ctx);
		// an answer that carries no secret still says the wallet is ready: a repeat makes that safe first (C21), unless
		// the call that drew the key just synced its ready commit
		const safe = async () => {
			if (!synced) await durable();
			return made;
		};
		if (device) return safe();
		const secret = randomBytes(32).toString("base64url");
		const digest = revealDigest(secret);
		const claimed = await commit(async (tx) => {
			const record = (await tx.doc(Wallets)).wallets[address];
			if (
				record?.state !== "ready" ||
				record.request !== request ||
				record.reveal === undefined ||
				(record.reveal.digest !== undefined && claimedHere.has(record.reveal.digest)) ||
				record.reveal.expires <= now()
			)
				return undefined;
			record.reveal.digest = digest;
			claimedHere.add(digest);
			return copy(record);
		}, ctx);
		if (claimed === undefined) return safe();
		try {
			await sync();
		} catch {
			await commit(async (tx) => {
				const reveal = (await tx.doc(Wallets)).wallets[address]?.reveal;
				if (reveal?.digest === digest) delete reveal.digest;
			}, ctx);
			claimedHere.delete(digest);
			throw new WalletRefused(UNSYNCED, 503, "unsynced");
		}
		return { address, record: claimed, secret };
	}

	/**
	 * Makes a wallet (UC-01, C15): `request` is the client's id for this creation, so the same request again is the same
	 * wallet (C14). The wallet comes back ready and not backed up, on for no agent; until the keychain kept its key no
	 * address is given (H-006). `device` says a paired device asks: its creation grants no reveal, and its answer claims
	 * none (H-264).
	 */
	async function create(
		asked: {
			readonly request: string;
			readonly name: string;
			readonly network: NetworkId;
			readonly device?: boolean;
		},
		ctx: Context = context,
	): Promise<Made> {
		const name = plainLine(asked.name, NAME_MAX);
		if (name === "") throw new WalletRefused("a wallet needs a name", 400);
		if (networkOf(asked.network) === undefined) throw new WalletRefused("banda does not offer that network", 400);
		if (!/^[\w-]{8,128}$/.test(asked.request)) throw new WalletRefused("a creation needs its request id", 400);
		// the same request while its creation runs waits on it, and is a repeat: that call's answer carries the secret
		const pending = making.get(asked.request);
		if (pending !== undefined) {
			const { address, record } = await pending.run;
			sameCreation(address, record, name, asked.network);
			return { address, record };
		}
		const run = draw(asked, name, ctx);
		const entry = { run, name, network: asked.network };
		making.set(asked.request, entry);
		try {
			return await run;
		} finally {
			if (making.get(asked.request) === entry) making.delete(asked.request);
		}
	}

	/** A creation: drawn, committed `creating`, written and read back, or settled from what another left (C15). */
	async function draw(
		asked: { readonly request: string; readonly network: NetworkId; readonly device?: boolean },
		name: string,
		ctx: Context,
	): Promise<Made> {
		const device = asked.device === true;
		const already = await commit((tx) => requested(tx, asked.request), ctx);
		if (already !== undefined) {
			const record = await recordOf(already, ctx);
			if (record !== undefined) sameCreation(already, record, name, asked.network);
			return serial(already, async () => {
				await settle(already, "restart", ctx);
				await join(already, ctx);
				return claim(already, asked.request, device, ctx);
			});
		}
		let drawn: string | undefined;
		let heard = false;
		/** The `creating` commit landed but could not be synced: the signer stopped before it wrote the keychain. */
		let unsynced = false;
		const made = await withLease(
			(lease) =>
				signer.create(lease, async (address) => {
					heard = true;
					const key = checksummed(address);
					await commit(async (tx) => {
						if ((await requested(tx, asked.request)) !== undefined) throw new Error("made already");
						const wallets = await tx.doc(Wallets);
						if (wallets.wallets[key] !== undefined) throw new Error("drawn twice");
						if (walletStep("none", "create", ATOMS) !== "creating") throw new Error("the model makes no wallet");
						wallets.wallets[key] = {
							name,
							network: asked.network,
							state: "creating",
							backup: "unsaved",
							default: "ask",
							disclosed: false,
							request: asked.request,
							...(device ? { device: true as const } : {}),
							version: 1,
							at: now(),
						};
					}, ctx);
					try {
						await sync();
					} catch (error) {
						unsynced = true;
						throw error;
					}
					drawn = key;
				}),
			true,
			ctx,
		);
		if (drawn === undefined) {
			const other = await commit((tx) => requested(tx, asked.request), ctx);
			// the record is on the store but not on disk, and the keychain was never written: the settle drops it, and the
			// owner is told the creation is not yet safe, never that the keychain lost a key it was not given (C21)
			if (other !== undefined && unsynced) {
				await serial(other, () => settle(other, "restart", ctx)).catch(() => undefined);
				throw new WalletRefused(
					"banda could not yet make the new wallet safe on disk: nothing was made, try again",
					503,
					"unsynced",
				);
			}
			if (other !== undefined)
				return serial(other, async () => {
					await settle(other, "restart", ctx);
					return claim(other, asked.request, device, ctx);
				});
			// the signer stopped before it drew an address: no key was made, the keychain was not reached (E5, H-002)
			if (!heard && !made.ok && made.code === "other")
				throw new WalletRefused("banda could not make a key on this computer: nothing was made", 503, "other");
			// the address was drawn but its `creating` commit failed: the keychain was never written
			if (heard) throw new WalletRefused("banda could not record the new wallet: nothing was made, try again", 503);
			throw unavailable(made.ok ? "other" : made.code);
		}
		const key = drawn;
		return serial(key, async () => {
			const to = await settle(key, "read_back", ctx);
			if (to === "creating")
				throw unavailable(
					made.ok ? "other" : made.code,
					": banda checks again once it answers, and if the key was not kept nothing is made",
				);
			return claim(key, asked.request, device, ctx, true);
		});
	}

	/**
	 * An owner's act on a wallet: the step from its model state, applied in one commit with `then`. An act whose target
	 * the wallet is already at (`reached`: the same act's earlier try, whose commit stayed though its sync failed) is
	 * done, not refused: its retry runs the barrier and answers done, so an act answered as not yet safe can be tried
	 * again until it is (C21).
	 */
	async function act(
		address: string,
		event: WalletEvent,
		atoms: (
			tx: Tx,
			record: WalletRecord,
			wallets: WalletsValue,
		) => Partial<WalletAtoms> | Promise<Partial<WalletAtoms>>,
		then: (tx: Tx, record: WalletRecord, to: WalletModel) => Promise<void>,
		refusal: (from: WalletModel, atoms: WalletAtoms) => string,
		reached: (record: WalletRecord) => boolean,
		ctx: Context,
	): Promise<WalletRecord> {
		const done = await commit(async (tx) => {
			const wallets = await tx.doc(Wallets);
			const record = wallets.wallets[address];
			if (record === undefined) throw new WalletRefused("there is no such wallet", 404);
			const from = modelOf(record);
			const given = { ...ATOMS, ...(await atoms(tx, record, wallets)) };
			const to = walletStep(from, event, given);
			if (to === undefined || to === from) {
				if (reached(record)) return copy(record);
				throw new WalletRefused(refusal(from, given), 409);
			}
			enter(record, to);
			record.version++;
			record.moved = { act: event, version: record.version };
			await then(tx, record, to);
			return copy(record);
		}, ctx);
		// what the owner is told of survives a power cut first (C21): an archive that a cut undid would send again
		await durable();
		return done;
	}

	/** Whether `act`, asked at `version`, is what last moved the record's state: its earlier try, whose commit stayed. */
	const movedBy = (record: WalletRecord, act: WalletEvent, version: number) =>
		record.moved?.act === act && record.moved.version === version + 1;

	const stale = (from: WalletModel, a: WalletAtoms) =>
		a.version_current ? `the wallet is ${STANDING[from]}: that is not for it now` : "the wallet changed: look again";

	/**
	 * The open payments not yet signed end `Refused` in the commit that takes the wallet out of service, and `refused`
	 * hears of each in that commit, so the Wait a Waiting one has open ends with it (C17).
	 */
	async function refuseUnsigned(tx: Tx, address: string): Promise<void> {
		const wallets = await tx.doc(Wallets);
		for (const id of [...(wallets.open[address] ?? [])]) {
			const payment = await tx.doc(Payments, id, null);
			if (!UNSIGNED.has(payment.state)) continue;
			const from = payment.state;
			payment.state = "Refused";
			payment.reason = "unusable";
			payment.version++;
			track(wallets, id, payment, from);
			await options.refused?.(tx, id, from);
		}
	}

	/** Archives a ready wallet (C17): it sends nothing, and what it had not signed yet is refused. */
	function archive(address: string, version: number, ctx: Context = context): Promise<WalletRecord> {
		const key = checksummed(address);
		return serial(key, () =>
			act(
				key,
				"archive",
				(_tx, record) => ({ version_current: record.version === version }),
				async (tx, record) => {
					delete record.reveal;
					await refuseUnsigned(tx, key);
					await log(tx, { at: now(), what: `You archived the wallet ${walletLabel(key, record)}` });
				},
				stale,
				(record) => record.state === "archived" && movedBy(record, "archive", version),
				ctx,
			),
		);
	}

	/** Brings an archived wallet back: backed up if it was, otherwise Not backed up (H-273). */
	function unarchive(address: string, version: number, ctx: Context = context): Promise<WalletRecord> {
		const key = checksummed(address);
		return serial(key, () =>
			act(
				key,
				"unarchive",
				(_tx, record) => ({ version_current: record.version === version, saved: record.backup === "saved" }),
				async (tx, record) => {
					await log(tx, { at: now(), what: `You brought back the wallet ${walletLabel(key, record)}` });
				},
				stale,
				(record) => record.state === "ready" && movedBy(record, "unarchive", version),
				ctx,
			),
		);
	}

	/** The owner chose not to save the key now: Not backed up, and Receive opens (UC-02 A1). */
	function skip(address: string, ctx: Context = context): Promise<WalletRecord> {
		const key = checksummed(address);
		return serial(key, () =>
			act(
				key,
				"skip_save",
				() => ({}),
				async () => {},
				(from) => `the wallet is ${STANDING[from]}: ${notSaving(from)}`,
				(record) => record.state === "ready" && record.backup === "skipped",
				ctx,
			),
		);
	}

	/**
	 * The owner pasted the saved key back and the host's signer derived `derived` from it (UC-02 step 4): backed up
	 * when it is this wallet's address. The key never comes here.
	 */
	function confirmSaved(address: string, derived: string, ctx: Context = context): Promise<WalletRecord> {
		const key = checksummed(address);
		let pasted: string | undefined;
		try {
			pasted = checksummed(derived);
		} catch {}
		return serial(key, () =>
			act(
				key,
				"confirm_saved",
				() => ({ pasted_derives: pasted === key }),
				async (tx, record) => {
					await log(tx, { at: now(), what: `You saved the key of the wallet ${walletLabel(key, record)}` });
				},
				(from) =>
					from === "ready_unsaved" || from === "ready_skipped"
						? "that key does not open this wallet"
						: `the wallet is ${STANDING[from]}: ${notSaving(from)}`,
				(record) => record.state === "ready" && record.backup === "saved" && pasted === key,
				ctx,
			),
		);
	}

	/** Why a removal cannot go on, in the owner's words. */
	function unremovable(a: WalletAtoms): string {
		if (!a.version_current) return "the wallet changed: look again";
		// banda sends nothing yet: the owner moves the funds with the key, from a wallet app
		if (a.funds)
			return "the wallet still holds funds: move them out first, by importing its key into a wallet app such as MetaMask and sending them from there";
		if (a.inflight) return "a payment of the wallet is not final yet";
		if (a.address_disclosed && !a.saved) return "the wallet's address was given out and its key was never saved";
		return "the wallet cannot be removed now";
	}

	/** What holds a wallet, read in the commit that decides its removal; `funded` was read just before it. */
	const holding = async (tx: Tx, record: WalletRecord, wallets: WalletsValue, address: string, funded: boolean) => ({
		funds: funded,
		inflight: (wallets.open[address] ?? []).length > 0 || (await authorized(tx, address)),
		saved: record.backup === "saved",
		address_disclosed: record.disclosed,
	});

	/**
	 * Removes a wallet (C15, C17): refused while anything holds it; otherwise `removing`, then everything is checked
	 * again, the item deleted and the wallet removed with its account. A removal the keychain stops stays `removing`,
	 * and the owner's next try, or `recover`, goes on with it.
	 */
	function remove(address: string, version: number, ctx: Context = context): Promise<void> {
		const key = checksummed(address);
		return serial(key, async () => {
			const record = await recordOf(key, ctx);
			if (record === undefined) {
				// removed by an earlier try whose answer was not yet safe, in this process or the one before a restart: the
				// retry makes it so, and is done (C21)
				const gone = await commit(async (tx) => (await tx.doc(Wallets)).removed?.[key] !== undefined, ctx);
				if (gone) return durable();
				throw new WalletRefused("there is no such wallet", 404);
			}
			if (record.state !== "removing") {
				const from = modelOf(record);
				if (walletStep(from, "begin_remove", ATOMS) === undefined)
					throw new WalletRefused(`the wallet is ${STANDING[from]}: it cannot be removed now`, 409);
				const funded = await options.funded(key as Address, record.network);
				if (funded === undefined) throw new WalletRefused("the wallet's balance could not be read: try again", 503);
				await act(
					key,
					"begin_remove",
					async (tx, current, wallets) => ({
						version_current: current.version === version,
						...(await holding(tx, current, wallets, key, funded)),
					}),
					async (_tx, current) => {
						delete current.reveal;
					},
					(_from, atoms) => unremovable(atoms),
					() => false,
					ctx,
				);
				// a removal begun by this act's earlier try, whose answer was not yet safe, is this one: it goes on
			} else if (record.version !== version && record.version !== version + 1)
				throw new WalletRefused("the wallet changed: look again", 409);
			await finish(key, ctx);
		});
	}

	/**
	 * A `removing` wallet taken on (C15, C17, H-044, H-045). The keychain says first what the item holds. With the
	 * wallet's own key, everything is checked again (a balance that cannot be read holds the wallet as funds do): held
	 * now, the wallet is archived, its item kept; otherwise the signer deletes the item, and only while it still derives
	 * the address. With nothing, or another key, the wallet's own key is gone already (deleted before a stop, or lost),
	 * so nothing is left to protect and the removal ends; another key is never deleted (its address was never checked
	 * for funds) and stays, listed as a key without a wallet. Only ever one step of a wallet at a time.
	 */
	async function finish(address: string, ctx: Context): Promise<void> {
		const record = await recordOf(address, ctx);
		if (record?.state !== "removing") return;
		const proof = await withLease((lease) => signer.derive(lease, address as Address), false, ctx);
		let seen = itemOf(proof);
		if (!seen.kc_up) throw unavailable(proof.ok ? "other" : proof.code, ": the wallet is removed once it answers");
		if (seen.item === "ours") {
			const balance = await options.funded(address as Address, record.network);
			const to = await commit(async (tx) => {
				const wallets = await tx.doc(Wallets);
				const current = wallets.wallets[address];
				if (current?.state !== "removing") return undefined;
				const held = await holding(tx, current, wallets, address, balance ?? true);
				const step = walletStep("removing", "delete_item", { ...ATOMS, ...seen, ...held });
				if (step === "archived") {
					enter(current, step);
					current.version++;
					await log(tx, {
						at: now(),
						what: `The wallet ${walletLabel(address, current)} was not removed: it is held again`,
					});
				}
				return step;
			}, ctx);
			if (to === undefined) return;
			if (to === "archived") {
				// the owner is told it was kept once that is on disk: a cut that undid it would leave recovery to remove it
				await durable();
				throw new WalletRefused(
					balance === undefined
						? "the wallet's balance could not be read: it was not removed"
						: "funds or a payment reached the wallet: it was not removed",
					409,
				);
			}
			await durable();
			const deleted = await withLease((lease) => signer.remove(lease, address as Address), false, ctx);
			seen = deleted.ok ? { kc_up: true, item: "empty" } : itemOf(deleted);
			if (!seen.kc_up)
				throw unavailable(deleted.ok ? "other" : deleted.code, ": the wallet is removed once it answers");
		}
		const step = walletStep("removing", "delete_item", { ...ATOMS, ...seen });
		const to = step === "removing" ? walletStep(step, "item_gone", ATOMS) : step;
		if (to !== "removed") return;
		const kept = seen.item === "other" ? ": the key in the keychain under it does not open it, and was kept" : "";
		const gone = await accounts.removeWallet(
			address,
			async (tx) => {
				const wallets = await tx.doc(Wallets);
				const current = wallets.wallets[address];
				if (current?.state !== "removing") return false;
				delete wallets.wallets[address];
				delete wallets.ledger[address];
				delete wallets.recipients[address];
				delete wallets.open[address];
				// kept a while, so a retry after a restart is recognised from the store, never from this process's memory
				const removed = wallets.removed ?? {};
				for (const [at, when] of Object.entries(removed)) if (when < now() - REMOVED_KEPT) delete removed[at];
				removed[address] = now();
				wallets.removed = removed;
				await log(tx, { at: now(), what: `You removed the wallet ${walletLabel(address, current)}${kept}` });
				return true;
			},
			ctx,
		);
		if (!gone) return;
		signing.delete(address);
		await durable();
	}

	/** Where a fresh reading of the keychain takes a wallet's signing, through the model's rows alone. */
	function reading(from: SigningState, proof: Outcome<unknown>, host_mode: boolean): Signing {
		const can: SigningAtoms = { derives: true, lease_mine: true, host_mode };
		const code = proof.ok ? undefined : proof.code;
		const of = (state: SigningState): Signing => (code === undefined ? { state } : { state, code });
		if (from === "key_missing" && (proof.ok || code === "wrong_key")) {
			// only restore_key leaves key_missing (C9, H-290): an item that is back is a restore, then checked as any is
			const restored = signingStep(from, "restore_key", { ...can, derives: proof.ok }) ?? from;
			return restored === "online" ? { state: signingStep(restored, "unlock_check", can) ?? restored } : of(restored);
		}
		let event: SigningEvent = "unlock_check";
		let atoms = can;
		if (code === "wrong_key") atoms = { ...atoms, derives: false };
		else if (code === "other_home") atoms = { ...atoms, lease_mine: false };
		else if (code !== undefined) event = code === "missing" ? "item_lost" : "keychain_locks";
		return of(signingStep(from, event, atoms) ?? from);
	}

	/** The wallets a reading of the keychain speaks for beyond its own: every other one of this home that signs. */
	const siblings = async (key: string, ctx: Context) =>
		Object.entries(await commit(async (tx) => copy((await tx.doc(Wallets)).wallets), ctx))
			.filter(([address, record]) => address !== key && (record.state === "ready" || record.state === "archived"))
			.map(([address]) => address);

	/**
	 * One wallet's check. A refusal that is the home's and not the wallet's (the keychain locked or absent, the lease
	 * another home's) is the same for every wallet of the home (one keychain, one lease item): each of them takes the
	 * same reading through the model in the same step, so no wallet looks able to pay while its sibling says it cannot.
	 */
	function checkOne(key: string, ctx: Context): Promise<Signing | undefined> {
		return serial(key, async () => {
			const record = await recordOf(key, ctx);
			if (record === undefined || record.state === "creating" || record.state === "removing") return undefined;
			const proof = await withLease((lease) => signer.derive(lease, key as Address), false, ctx);
			const from = signing.get(key)?.state ?? "online";
			const to = reading(from, proof, host());
			const { restored } = options;
			if (from === "key_missing" && to.state !== "key_missing" && restored !== undefined)
				await commit((tx) => restored(tx, key), ctx);
			setSigning(key, to);
			if (!proof.ok && HOME_WIDE.has(proof.code))
				for (const other of await siblings(key, ctx))
					setSigning(other, reading(signing.get(other)?.state ?? "online", proof, host()));
			return to;
		});
	}

	/**
	 * Whether this home can sign for the wallet now (C16): the signer proves its key derives the address and the lease
	 * is this home's. The state is kept in memory for the screens, never stored; a key that is back for a wallet whose
	 * key was missing is told to `restored` first. A check that finds the home able to sign again checks each other
	 * wallet a home-wide refusal held, one at a time and outside this one's step.
	 */
	async function unlockCheck(address: string, ctx: Context = context): Promise<Signing | undefined> {
		const key = checksummed(address);
		const to = await checkOne(key, ctx);
		if (to?.state === "online" || to?.state === "offline_host_mode")
			for (const other of await siblings(key, ctx)) {
				const code = signing.get(other)?.code;
				if (code !== undefined && HOME_WIDE.has(code)) await checkOne(other, ctx);
			}
		return to;
	}

	/** The last `unlockCheck` of a wallet, if any. */
	const signingOf = (address: string): Signing | undefined => signing.get(checksummed(address));

	/**
	 * What a restart, or a keychain that answers again, settles: every `creating` wallet from its item, every ready one
	 * an account, every `removing` one taken on. A step the keychain stops waits for the next call; a wallet that fails
	 * stops none after it, and the first failure that is not a refusal (a store that did not sync is not one) is thrown
	 * once every wallet was tried. The codes of the refusals, one per wallet refused, so a caller can tell a keychain
	 * that may answer later from one that won't.
	 */
	async function recover(ctx: Context = context): Promise<(SignerCode | undefined)[]> {
		const all = await commit(async (tx) => copy((await tx.doc(Wallets)).wallets), ctx);
		const failed: unknown[] = [];
		const refused: (SignerCode | undefined)[] = [];
		for (const [address, record] of Object.entries(all)) {
			await serial(address, async () => {
				if (record.state === "creating") await settle(address, "restart", ctx);
				else if (record.state === "removing") await finish(address, ctx);
				else await join(address, ctx);
			}).catch((error: unknown) => {
				if (error instanceof WalletRefused && error.code !== "unsynced") refused.push(error.code);
				else failed.push(error);
			});
		}
		if (failed.length > 0) throw failed[0];
		return refused;
	}

	/**
	 * The addresses this home's keychain has items for that no wallet names (C15, H-045): listed, never deleted or
	 * adopted. Undefined when the keychain cannot list them (Linux: the listing could miss the Secret Service's).
	 */
	async function orphans(ctx: Context = context): Promise<string[] | undefined> {
		// at this home's lease: a fork or a copy lists nothing (H-283). A keychain with no lease item holds none of the
		// home's keys either (H-286): nothing to list
		const at = await signer.leased();
		if (at.ok && at.lease === null) return [];
		const found = await leased((lease) => signer.find(lease), ctx);
		if (!found.ok) return undefined;
		const wallets = await commit(async (tx) => copy((await tx.doc(Wallets)).wallets), ctx);
		return found.addresses.map(checksummed).filter((address) => wallets[address] === undefined);
	}

	/** A signer call at this home's lease, the store caught up to the keychain's after a move (C15, H-289). */
	const leased = <T>(call: (lease: number) => Promise<Outcome<T>>, ctx: Context = context) =>
		withLease(call, false, ctx);

	return { create, archive, unarchive, skip, confirmSaved, remove, unlockCheck, signingOf, recover, orphans, leased };
}
