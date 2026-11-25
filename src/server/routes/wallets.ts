/**
 * The owner's wallets (docs/wallets.md "Architecture", UC-01 to UC-05): `GET /api/wallets` lists them and the
 * networks' RPCs, masked; `POST /api/wallets` makes one; under `/api/wallets/<address>/` the owner reveals its key
 * once at creation, confirms the saved copy or skips saving it, opens Receive, archives it and brings it back, removes
 * it, switches it on or off for an agent, and has its key checked; `PUT /api/wallets/rpc/<network>` sets a network's
 * RPC. Each wallet is an account of the wallet connection (D0), switched on agent by agent (OD-1); its tools come
 * through the connection, so the area installs none.
 *
 * The key never passes through the daemon (C20). The creation's reveal is minted by the ready commit and spent once,
 * within ten minutes, by the client that sent the creation, from this computer alone (C16): one answer of the creation
 * alone carries the secret it is spent with (the first from this computer to find it ready, whose claim the store
 * keeps), and every other answer gets none. The signer child proves the key,
 * the reveal is spent in a commit of its own, and the child is handed the request's connection and writes the response
 * onto it. A saved copy is checked by its SHA-256, in the child. Any later reveal is the desktop app's, behind the OS's
 * re-authentication (OD-2), and the daemon is only told it happened.
 *
 * The indexer and the recovery of what a stop left (C15) start here, once the store is open and migrated (C23); the
 * signer's call in flight is killed as the daemon stops (H-034).
 */

import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { isIP, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { log as activity } from "../../core/activity.ts";
import { addressRefusal, bareHost, isLoopback, isLoopbackHost } from "../../core/addresses.ts";
import { accountKey, Connected, credentialsOf, WALLET, walletOf } from "../../core/connections.ts";
import { writeDurably } from "../../core/durable-file.ts";
import { keyedSerial } from "../../core/keyed-serial.ts";
import { context, syncNow } from "../../core/store.ts";
import { type Config, madeInstallationId, readConfig } from "../../home.ts";
import { type Address, checksummed } from "../../wallet/address.ts";
import { maskedRpc, rpcOf, shownRpc, walletRpc } from "../../wallet/config.ts";
import { Incoming, noteReveal, type WalletRecord, Wallets } from "../../wallet/docs.ts";
import { IDENTITY_LOST, identityLost, type SignerHome, signerHome } from "../../wallet/home-id.ts";
import { createIndexer, type Indexer, type IndexerDeps, incomingConfirmed } from "../../wallet/indexer.ts";
import { walletLabel } from "../../wallet/label.ts";
import { openLifecycle, revealDigest, type Signing, UNSYNCED, WalletRefused, WORDS } from "../../wallet/lifecycle.ts";
import { type Network, type NetworkId, networkOf, networks } from "../../wallet/networks.ts";
import { codeAt, rpcClients, tokenBalance } from "../../wallet/rpc.ts";
import { Signer, type SignerOptions } from "../../wallet/signer-client.ts";
import type { SignerCode } from "../../wallet/signer-protocol.ts";
import { type OfflineCode, offlineCode } from "../../wallet/tools.ts";
import type {
	IncomingView,
	OutsideView,
	WalletErrorCode,
	WalletIncoming,
	WalletMade,
	WalletNetworkView,
	WalletOrphans,
	WalletReceive,
	WalletsView,
	WalletView,
} from "../api/wallets.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule, AreaReply, AreaRequest } from "./area.ts";

/** An act on a wallet's key (its reveal, its saved copy, skipping its saving), refused to a paired device. */
const HERE = "Open banda on your computer to do this: a wallet's key is shown only there.";
/** Any other act the computer alone makes (removing a wallet, acknowledging code, a network's RPC), refused to a device. */
const HERE_HOST = "Open banda on your computer to do this.";
/** A check of the keychain, refused to a paired device: it may raise a prompt on the computer's screen. */
const HERE_KEYCHAIN = "Open banda on your computer to check its keychain: it may ask you there.";
/** What a reveal's spend changed, to take it back: the reveal and showings as they were, and when it was spent. */
type Taken = {
	readonly was: { readonly reveal: NonNullable<WalletRecord["reveal"]>; readonly reveals: WalletRecord["reveals"] };
	readonly at: number;
};
/** The homes, with their ids, whose wallets this process ran: an id it made there names the wallets made after. */
const ranOn = new Set<string>();
/** A reveal another call spent, or that expired, while this one ran. */
class RevealSpent extends Error {}
/** A reveal whose spend could not be made safe on disk: taken back, so the same request may try again (C21). */
class RevealUnsynced extends Error {}

/**
 * A reveal spent, expired or never this client's. Only banda's desktop app on a Mac with Touch ID shows a key again
 * (OD-2, H-266): on any other computer these words never point to a later showing that is refused there.
 */
const SPENT =
	process.platform === "darwin"
		? "The key is shown once, to the app that made the wallet, within ten minutes. Later, only banda's desktop app on this Mac shows it again, if the Mac has Touch ID."
		: "The key is shown once, to the app that made the wallet, within ten minutes. This computer can't confirm it's you, so banda doesn't show it again here.";

/** A resolver of a host name to every address it answers, as `dns.lookup` with `all`. */
export type Resolve = (host: string) => Promise<readonly { readonly address: string }[]>;

const resolveAll: Resolve = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Why a URL the owner gives for an RPC is refused, after `walletRpc` took it: its host name is resolved once, every
 * answer, and any that is loopback, private, link-local or special purpose refuses it, as a literal address would be
 * (H-196). The name localhost, and a literal address, are what `walletRpc` decided. Fixed words, never the URL.
 */
export async function rpcHostProblem(url: string, resolve: Resolve = resolveAll): Promise<string | undefined> {
	const host = bareHost(new URL(url).hostname);
	if (isLoopbackHost(host) || isIP(host) !== 0) return undefined;
	let answers: readonly { readonly address: string }[];
	try {
		answers = await resolve(host);
	} catch {
		return "its host name could not be resolved";
	}
	if (answers.length === 0) return "its host name could not be resolved";
	for (const { address } of answers) {
		if (isIP(address) === 0) return "its host name resolved to something that is not an address";
		if (isLoopback(address)) return "its host name resolves to this computer: use localhost";
		if (addressRefusal(address) !== undefined) return "its host name resolves to a private address";
	}
	return undefined;
}

/** The one temporary a save of `config.json` (at `path`) writes before it renames it over the file. */
const rpcTemporary = (path: string) => `${path}.tmp`;

/**
 * Removes the temporary a save killed between its write and its rename left in `home`: it may hold a keyed RPC's URL
 * (H-195), which only `config.json` should.
 */
export const sweepRpcTemporary = (home: string) => rm(rpcTemporary(join(home, "config.json")), { force: true });

/** Each config.json's line of saves. */
const saving = keyedSerial();

/**
 * Sets `network`'s RPC in `config.json`'s `wallets.rpc` (or drops it, for the default banda ships), changing nothing
 * else in the file, after `walletRpc` and `rpcHostProblem` took it. The file is written whole and owner-only: the URL
 * may carry the RPC's key (H-195). Saves to one file run one at a time, each reading the file the last one wrote, so
 * two at once lose neither. Answers the URL masked; throws `BadRequest` in words that never quote it.
 */
export function saveRpc(
	home: string,
	network: Network,
	url: string | null,
	resolve: Resolve = resolveAll,
): Promise<string | undefined> {
	const path = join(home, "config.json");
	return saving(path, () => writeRpc(path, network, url, resolve));
}

async function writeRpc(
	path: string,
	network: Network,
	url: string | null,
	resolve: Resolve,
): Promise<string | undefined> {
	let raw: unknown = {};
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new BadRequest("config.json could not be read: fix it first", 409);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new BadRequest("config.json is not an object: fix it first", 409);
	const file = raw as { wallets?: { rpc?: Record<string, string> } };
	const rpc = { ...(file.wallets?.rpc ?? {}) };
	if (url === null) delete rpc[network.id];
	else rpc[network.id] = url;
	const { rpc: _was, ...rest } = file.wallets ?? {};
	const next = { ...file, wallets: { ...rest, ...(Object.keys(rpc).length === 0 ? {} : { rpc }) } };
	if (Object.keys(next.wallets).length === 0) delete (next as { wallets?: unknown }).wallets;
	let taken: string | undefined;
	try {
		// a refusal is said of the field the owner typed in, not of a file the owner never edited
		taken = walletRpc(next as Config, network, url === null ? `${network.label}'s RPC` : "This RPC").url;
	} catch (error) {
		throw new BadRequest((error as Error).message, 400);
	}
	if (url !== null) {
		const refused = await rpcHostProblem(url, resolve);
		if (refused !== undefined) throw new BadRequest(`That RPC is not taken: ${refused}`, 400);
	}
	// the home starts from this file: a power cut leaves the one before or this one, never a torn one (C21); the saves
	// are one at a time and the daemon is the file's one writer, so one temporary name serves every save
	await writeDurably(path, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600, temporary: rpcTemporary(path) });
	return url === null ? (taken === undefined ? undefined : maskedRpc(taken)) : maskedRpc(url);
}

/** A path segment decoded; undefined when its escapes are malformed. */
function decoded(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment);
	} catch {
		return undefined;
	}
}

/** The wallet a path segment names, by its EIP-55 address; undefined when it names none. */
function walletFromPath(segment: string): string | undefined {
	const text = decoded(segment);
	if (text === undefined) return undefined;
	try {
		return checksummed(text);
	} catch {
		return undefined;
	}
}

/** The lifecycle's `WalletRefused` as the HTTP error it answers, with its code; any other error as it is. */
const asBadRequest = (error: unknown): never => {
	if (error instanceof WalletRefused) throw new BadRequest(error.message, error.status, error.code);
	throw error;
};

/** An HTTP error with its fixed word (`WalletErrorCode`), for the client to branch on. */
/** Whether a reveal's bound digest is the one given, compared in constant time; none bound is never the same (C16). */
const sameDigest = (bound: string | undefined, given: string): boolean => {
	if (bound === undefined) return false;
	const a = Buffer.from(bound, "hex");
	const b = Buffer.from(given, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
};

const walletError = (message: string, status: number, code: WalletErrorCode) => new BadRequest(message, status, code);

/**
 * A wallet no key on this computer opens (its item gone, or another key's), whose key was never saved either: no copy
 * anywhere spends from its address, so Receive gives it out to no one (H-021, H-261).
 */
const unopenable = (record: WalletRecord, signing: Signing | undefined): boolean =>
	record.backup !== "saved" && (signing?.state === "key_missing" || signing?.state === "wrong_key");

/** The incoming rows one page of a wallet's activity holds, newest first; `more` asks for the next. */
export const INCOMING_ROWS = 50;

/** Where a page of incoming rows ends: its last row's block and id, the order rows are listed in (newest first). */
const CURSOR = /^(\d+):(.+)$/;

/**
 * What commits made, that the wallets' view is built from: the wallets, the lease, and which agent each is switched on
 * for. `n` numbers the reads in the order the store made them, so a barrier that finished late never puts back an older
 * read than one a later barrier made safe.
 */
type Read = {
	wallets: { [address: string]: WalletRecord };
	lease?: number;
	on: { [agent: string]: { [connection: string]: string[] } };
	n: number;
};

/** The version an owner's act carries. */
async function versionOf(json: () => Promise<Record<string, unknown>>): Promise<number> {
	const { version } = await json();
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
		throw new BadRequest("version is the wallet's version the view showed");
	return version;
}

/** What the owner does to one wallet, under `/api/wallets/<address>/`, each a POST. */
const ACTIONS = new Set([
	"reveal",
	"revealed",
	"saved",
	"skip",
	"receive",
	"looking",
	"acknowledge-code",
	"archive",
	"unarchive",
	"remove",
	"check",
]);

/** The SHA-256 a saved copy is checked by, as the client sends it. */
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * How soon a wallet left `creating` or `removing` is settled again while the keychain may answer (UC-01 E1), and the
 * longest wait it doubles to while the keychain keeps refusing.
 */
const RESETTLE_MS = 30_000;
const RESETTLE_MAX_MS = 15 * 60_000;

/**
 * How long the settling timer waits next, after a try that waited `wait`: `base` once nothing is left to settle or the
 * keychain answered, twice `wait` (up to `RESETTLE_MAX_MS`) after a refusal or a failure, and undefined, no timer,
 * after a refusal no wait mends: another home holds the lease, or two items match.
 */
export function nextResettle(
	wait: number,
	base: number,
	after: { readonly left: boolean; readonly refused: readonly (SignerCode | undefined)[] } | "failed",
): number | undefined {
	if (after === "failed") return Math.min(wait * 2, RESETTLE_MAX_MS);
	if (!after.left) return base;
	if (after.refused.some((code) => code === "other_home" || code === "ambiguous")) return undefined;
	return after.refused.length > 0 ? Math.min(wait * 2, RESETTLE_MAX_MS) : base;
}

/**
 * The wallets' area; a test gives its signer a shorter deadline, its settling again another period, its indexer one
 * it observes, and its sync to disk one that fails.
 */
export const walletsArea = (
	options: {
		readonly signer?: Pick<SignerOptions, "deadline">;
		readonly resettle?: number;
		readonly indexer?: (deps: IndexerDeps) => Indexer;
		readonly sync?: (harness: Parameters<typeof syncNow>[0]) => Promise<void>;
	} = {},
): AreaModule => ({
	start: (deps) => {
		const { harness, home, log, connections } = deps;
		const host = deps.box === "host";
		const now = Date.now;
		/**
		 * What the wallets' view is built from, as the store holds it now: a plain copy of what the commit read (a draft
		 * is the store's own and leaves no commit).
		 */
		let reads = 0;
		const readNow = () =>
			harness.commit(async (tx) => {
				const read = JSON.parse(
					JSON.stringify({
						wallets: (await tx.doc(Wallets)).wallets,
						lease: (await tx.doc(Wallets)).lease,
						on: (await tx.doc(Connected)).on ?? {},
					}),
				) as Omit<Read, "n">;
				// derived, never kept: why the wallets are offline is read again for every view (C22, H-064, H-065)
				return { read: { ...read, n: ++reads }, offline: await offlineCode(tx, host) };
			}, context);
		/**
		 * The read the last barrier that passed made safe: taken before that barrier began, so every commit it saw is one
		 * the barrier flushed. While the last barrier failed (`unsafe`), what is shown, on the shell stream to every
		 * device and to `GET /wallets`, is this read, never a commit a power cut could undo (C21): the act answered as not
		 * yet safe shows nowhere as done, until a barrier passes again.
		 */
		let safe: Read | undefined;
		/**
		 * The newest read whose barrier failed: the view is frozen at `safe` while it is newer than `safe`, so a barrier
		 * that passes after it, whichever act's, ends the freeze, and one that failed before `safe` never starts one.
		 */
		let failed = 0;
		const unsafe = () => failed > (safe?.n ?? 0);
		/** The barriers under way: a read waits for them, so it never shows a commit whose barrier is still deciding. */
		const barriers = new Set<Promise<unknown>>();
		const sync = async () => {
			const { read: before } = await readNow();
			const run = (options.sync ?? syncNow)(harness);
			barriers.add(run);
			const was = unsafe();
			try {
				await run;
				if (before.n > (safe?.n ?? 0)) safe = before;
				// a freeze ended: the screens are told, as a commit would tell them
				if (was && !unsafe() && !stopped) deps.changed();
			} catch (error) {
				failed = Math.max(failed, before.n);
				throw error;
			} finally {
				barriers.delete(run);
			}
		};
		/**
		 * The barrier the area opens with, and each one a read tries again while none passed: the last process may have
		 * answered an act, or been killed before answering it, with its commit in the OS's or the drive's cache alone,
		 * and a restart flushes nothing. One flush at start makes everything it committed safe before anything is shown
		 * or answered (C21, one barrier, not one per commit); until one passes there is no safe read, and the view
		 * answers not yet safe.
		 */
		let opening: Promise<void> | undefined;
		const open = () => {
			opening ??= sync().finally(() => {
				opening = undefined;
			});
			return opening;
		};
		void open().catch(() => {
			// the store closed as the area started, or the disk refused: the first read tries again
		});
		/** What is shown: the safe read while the last barrier failed, with what is derived always read now. */
		const shownRead = async (): Promise<Read & { offline?: OfflineCode }> => {
			if (safe === undefined)
				await open().catch(() => {
					throw new BadRequest(UNSYNCED, 503, "unsynced" satisfies WalletErrorCode);
				});
			await Promise.allSettled([...barriers]);
			const now = await readNow();
			const read = unsafe() && safe !== undefined ? safe : now.read;
			return { ...read, ...(now.offline === undefined ? {} : { offline: now.offline }) };
		};
		const readRpc = rpcOf(home, deps.rpc ?? rpcClients(deps.fetch === undefined ? {} : { fetch: deps.fetch }));
		/** Whether the balance at `safe` is above zero, in ETH or the pinned token; undefined when it cannot be read. */
		const funded = async (address: Address, id: NetworkId): Promise<boolean | undefined> => {
			const network = networkOf(id);
			if (network === undefined) return undefined;
			try {
				const rpc = await readRpc(network);
				if ((await rpc.balance(address, "safe")) > 0n) return true;
				if (network.usdc === undefined) return false;
				return (await tokenBalance(rpc, network.usdc.address, address, "safe")) > 0n;
			} catch {
				return undefined;
			}
		};
		// a pass that moved a balance or a row is pushed to the open screens, as a commit of `Wallets` is
		const indexer = (options.indexer ?? createIndexer)({
			store: harness,
			rpc: readRpc,
			onChange: () => {
				if (!stopped) deps.changed();
			},
		});
		let stopped = false;
		/** What the home holds of the id its wallets were made under, as `identityLost` weighs it. */
		const holdings = async () => {
			const held = await harness.commit(
				async (tx) => ({
					wallets:
						Object.keys((await tx.doc(Wallets)).wallets).length > 0 || (await tx.doc(Wallets)).lease !== undefined,
					accounts: Object.keys((await tx.doc(Connected)).accounts?.[WALLET] ?? {}),
				}),
				context,
			);
			const accounts: string[] = [];
			for (const account of held.accounts) {
				const wallet = walletOf(await credentialsOf(home, WALLET, account));
				if (wallet !== undefined) accounts.push(wallet.account);
			}
			return { wallets: held.wallets, accounts };
		};
		/**
		 * Whether this home's id is not the one its wallets were made under (`identityLost`): then nothing runs under it,
		 * no recovery, no check, no act, so no item and no credential is written under the new id, until the owner puts
		 * the old one back and starts banda again.
		 */
		let lost = false;
		const ready = (async () => {
			await sweepRpcTemporary(home);
			const held = await holdings();
			// an id missing in a home that holds wallets is not made again here: the wallets' area makes nothing under one
			const missing = held.wallets && !existsSync(join(home, "auth", "device-id"));
			// an id is made here only for a home that holds no wallet yet: its first wallet is named by it
			const at: SignerHome = missing
				? { id: "", binding: "" }
				: await signerHome(home, undefined, undefined, { make: !held.wallets });
			const ran = `${resolve(home)}\n${at.id}`;
			// an id this process made is the wallets' own once an earlier start here ran them on it, before any was made
			lost = missing || identityLost(at.id, { made: madeInstallationId(home) && !ranOn.has(ran), ...held });
			if (!lost) ranOn.add(ran);
			const signer = new Signer(at, options.signer);
			if (lost) log("wallets: offline, since this home's id is not the one its wallets were made under");
			if (stopped || lost) signer.stop();
			const lifecycle = openLifecycle({
				harness,
				signer,
				home: at.id,
				accounts: connections,
				funded,
				host: () => host,
				sync,
				// a check moves what every screen shows, and commits nothing a watch would hear: push the wallets
				onSigning: () => deps.changed(),
				context,
			});
			// an agent's read that hands out an address asks how this process found the wallet's key (H-021, H-261)
			connections.checksWallets?.((address) => lifecycle.signingOf(address), sync);
			return { signer, lifecycle };
		})();
		/**
		 * The last creation, check of a key or check of the keychain found no keychain banda can use; a creation whose key
		 * was kept, or a check the keychain answers, clears it.
		 */
		let noKeychain = false;
		/** Keeps whether there is no keychain, and pushes the wallets to every open screen when that changes (C22, H-317). */
		const keychainNone = (none: boolean) => {
			if (none === noKeychain) return;
			noKeychain = none;
			deps.changed();
		};
		/**
		 * By address, whether code runs there as the last check at an unlock, a Receive or an acknowledgement read it, on
		 * which network, and the indexer's reading of the address it followed (its `at`). The indexer reads the same with
		 * the balances each pass: the notice goes by a check until a pass reads the address again (`codeOf`), and saving a
		 * network's RPC drops the checks read through the one before it (H-157, C22).
		 */
		const coded = new Map<
			string,
			{ readonly code: boolean; readonly network: NetworkId; readonly after: number | undefined }
		>();
		const noteCode = (address: string, network: NetworkId, code: boolean) =>
			coded.set(address, { code, network, after: indexer.status(network)?.balances[address]?.at });
		/** Reads whether code runs at a wallet's address, and keeps what it found; `unchecked` changes nothing kept. */
		const checkCode = async (address: string, id: NetworkId) => {
			const network = networkOf(id);
			if (network === undefined) return "unchecked" as const;
			const found = await codeAt(address, network, readRpc);
			if (found !== "unchecked") noteCode(address, id, found === "code");
			return found;
		};
		/** Whether code runs at a wallet's address, by the newest reading: a check, or the indexer's pass after it (H-157). */
		const codeOf = (address: string, network: NetworkId): boolean => {
			const passed = indexer.status(network)?.balances[address];
			const checked = coded.get(address);
			if (checked !== undefined && checked.network === network && passed?.at === checked.after) return checked.code;
			return passed?.code === true;
		};
		const said = (error: unknown) => {
			if (!stopped) log(`wallets: ${error instanceof Error ? error.message : String(error)}`);
		};
		/** What the owner is told of survives a power cut first (C21). */
		const durable = async () => {
			try {
				await sync();
			} catch {
				throw new BadRequest(UNSYNCED, 503, "unsynced" satisfies WalletErrorCode);
			}
		};

		/**
		 * Settles every wallet a stop or a silent keychain left `creating` or `removing` (C15), once nothing else is
		 * settling them: at start, whenever the keychain answers a check, and on a timer while one is left (UC-01 E1). The
		 * timer looks every `RESETTLE_MS` while none is left, waits twice as long after each try the keychain refused, up
		 * to `RESETTLE_MAX_MS`, and stops for a refusal no wait mends (another home holds the lease, two items match): the
		 * owner's act that mends it settles them. A `creating` wallet has no Discard: its item may be in the keychain, and
		 * a record dropped while the keychain is silent could leave an item no wallet names (C15); `settle` drops one only
		 * on the keychain's answer that it is not.
		 */
		let settling: Promise<void> | undefined;
		const base = options.resettle ?? RESETTLE_MS;
		let wait = base;
		let resettle: ReturnType<typeof setTimeout> | undefined;
		const arm = (next: number | undefined) => {
			clearTimeout(resettle);
			resettle = undefined;
			if (stopped || next === undefined) return;
			wait = next;
			resettle = setTimeout(() => void settleAgain().catch(said), wait);
			resettle.unref();
		};
		/**
		 * Whether a wallet waits on recovery: left `creating` or `removing`, or kept without its account (a sync failed) or
		 * without its account's credentials whole on disk (a power cut kept the account and lost the file).
		 */
		const unsettled = async () => {
			for (const [address, record] of Object.entries((await harness.snapshot(Wallets, context))?.wallets ?? {})) {
				if (record.state === "creating" || record.state === "removing") return true;
				if (!(await connections.walletKept(address, context))) return true;
			}
			return false;
		};
		const settleAgain = (): Promise<void> => {
			settling ??= (async () => {
				clearTimeout(resettle);
				const { lifecycle } = await ready;
				if (lost) return;
				// a barrier that failed freezes the view (C21) until one passes: the timer tries one, so the freeze ends
				// without waiting for the owner's next act
				if (unsafe()) await sync().catch(() => {});
				if (!(await unsettled())) return arm(nextResettle(wait, base, { left: false, refused: [] }));
				let refused: (SignerCode | undefined)[];
				try {
					refused = await lifecycle.recover();
				} catch (error) {
					arm(nextResettle(wait, base, "failed"));
					// a wallet this pass brought to ready is checked whatever another wallet's step did
					await unlockAll(false);
					throw error;
				}
				await unlockAll(false);
				if (!stopped) deps.changed();
				arm(nextResettle(wait, base, { left: await unsettled(), refused }));
			})().finally(() => {
				settling = undefined;
			});
			return settling;
		};
		arm(base);

		/** A wallet's key checked at unlock (C16), and whether code runs at its address (H-157). */
		const unlock = async (address: string, network: NetworkId) => {
			const { lifecycle } = await ready;
			await lifecycle.unlockCheck(address);
			await checkCode(address, network);
			return lifecycle.signingOf(address);
		};

		/**
		 * Checks every ready or archived wallet's key (`every`), or those not checked yet in this process: each on its
		 * own, so a wallet whose check fails stops none after it, and what failed is logged. A wallet left unchecked would
		 * show no reason it cannot pay, and Receive refuses it until it is checked (H-021, H-261): an archived one is
		 * checked too, so unarchiving it finds its key known.
		 */
		const unlockAll = async (every: boolean, also: (signing: Signing) => boolean = () => false) => {
			const { lifecycle } = await ready;
			let all: Record<string, WalletRecord>;
			try {
				all = (await harness.snapshot(Wallets, context))?.wallets ?? {};
			} catch (error) {
				said(error);
				return;
			}
			for (const [address, record] of Object.entries(all)) {
				if (stopped) return;
				if (record.state !== "ready" && record.state !== "archived") continue;
				const known = lifecycle.signingOf(address);
				if (!every && known !== undefined && !also(known)) continue;
				try {
					if ((await unlock(address, record.network))?.code === "no_keychain") keychainNone(true);
				} catch (error) {
					said(error);
				}
			}
		};

		void ready
			.then(async ({ lifecycle }) => {
				if (lost) return;
				// a recovery that failed for one wallet (a sync, an account) leaves the start-up check of every other to run
				await lifecycle.recover().catch(said);
				await unlockAll(true);
				if (!stopped) deps.changed();
			})
			.catch(said);
		indexer.start();

		/**
		 * How many times each network's block times were read behind an answer of money coming in: shown in the view, so
		 * the push that follows a read of them is a view that changed, and a screen listing the rows reads them again.
		 */
		const timed = new Map<NetworkId, number>();

		const networkView = async (): Promise<WalletNetworkView[]> => {
			let config: Config | undefined;
			try {
				config = await readConfig(home);
			} catch {}
			return networks().map((network) => {
				const set = config?.wallets?.rpc?.[network.id] !== undefined;
				const base = {
					id: network.id,
					label: network.label,
					testnet: network.testnet,
					set,
					shipped: network.rpc !== undefined,
					...(network.usdc === undefined ? {} : { usdc: true as const }),
					...(network.explorer === undefined ? {} : { explorer: network.explorer }),
				};
				if (config === undefined) return { ...base, problem: "config.json could not be read" };
				// a network with neither the owner's RPC nor banda's default is not set yet, which is no problem to show
				if (!set && !base.shipped) return base;
				const status = indexer.status(network.id);
				const failed = status?.failed;
				const logs = failed?.logs === false ? { logs: false as const } : {};
				const chain = failed?.otherChain === true ? { otherChain: true as const } : {};
				// an RPC of another chain answers: its network is not unread, it is served wrong (H-187), said apart
				const unread = failed === undefined || failed.otherChain === true ? {} : { unread: { since: failed.since } };
				const head = status?.head === undefined ? {} : { head: status.head };
				const times = timed.get(network.id);
				const dated = times === undefined ? {} : { timed: times };
				try {
					return {
						...base,
						rpc: shownRpc(walletRpc(config, network)),
						...logs,
						...chain,
						...unread,
						...head,
						...dated,
					};
				} catch (error) {
					return { ...base, problem: (error as Error).message };
				}
			});
		};

		/** The wallets as every client sees them; a creation's open reveal is its own answer's, never shown here (C16). */
		const view = async (): Promise<WalletsView> => {
			const { lifecycle } = await ready;
			const read = await shownRead();
			const shown: WalletView[] = Object.entries(read.wallets)
				.sort(([, a], [, b]) => a.at - b.at)
				.map(([address, record]) => {
					const account = accountKey(address);
					const signing = lifecycle.signingOf(address);
					const balance = indexer.status(record.network)?.balances[address];
					return {
						address,
						name: record.name,
						network: record.network,
						state: record.state,
						backup: record.backup,
						disclosed: record.disclosed,
						version: record.version,
						at: record.at,
						...(record.device === true ? { device: true as const } : {}),
						agents: Object.entries(read.on)
							.filter(([, on]) => on[WALLET]?.includes(account) === true)
							.map(([agent]) => agent)
							.sort(),
						...(signing === undefined ? {} : { signing }),
						...(codeOf(address, record.network) ? { code: true as const } : {}),
						// the newest showing alone: the list goes with the wallet's own page (H-214)
						...(record.reveals?.at(-1) === undefined ? {} : { revealed: record.reveals.at(-1)?.at as number }),
						...(balance === undefined
							? {}
							: {
									balance: {
										native: balance.native,
										...(balance.usdc === undefined ? {} : { usdc: balance.usdc }),
										block: balance.block,
										at: balance.at,
									},
								}),
					};
				});
			const offline = lost ? "identity" : read.offline;
			return {
				wallets: shown,
				networks: await networkView(),
				...(offline === undefined ? {} : { offline }),
				...(noKeychain ? { keychain: "none" as const } : {}),
				...(read.lease === undefined ? {} : { lease: read.lease }),
			};
		};

		const recordOf = async (address: string): Promise<WalletRecord> => {
			const record = (await harness.snapshot(Wallets, context))?.wallets[address];
			if (record === undefined) throw new BadRequest("there is no such wallet", 404);
			return record;
		};

		/** A spend taken back: the reveal put back as it was, bound to the same request and secret, its showing dropped. */
		const takeBack = (address: string, request: string, taken: Taken) =>
			harness.commit(async (tx) => {
				const record = (await tx.doc(Wallets)).wallets[address];
				if (record?.state !== "ready" || record.request !== request || record.reveal !== undefined) return;
				record.reveal = taken.was.reveal;
				const last = record.reveals?.at(-1);
				if (last?.kind === "creation" && last.at === taken.at) {
					if (taken.was.reveals === undefined) delete record.reveals;
					else record.reveals = taken.was.reveals;
				}
				record.version++;
			}, context);
		/**
		 * The creation's reveal, spent in a commit of its own once the signer proved the key, and told to the activity; the
		 * spend is on disk before the key goes out, or the key does not go out (C21): a power cut could otherwise bring the
		 * reveal back for a second showing. A spend that could not be synced is taken back, and answered as not yet safe.
		 */
		const spend = (address: string, request: string, givenDigest: string) => async (): Promise<Taken> => {
			const taken = await harness.commit(async (tx) => {
				const record = (await tx.doc(Wallets)).wallets[address];
				// the capability is decided in the commit that consumes it: a repeat of the creation that claimed again since
				// the check before the hand put its own digest in place, and the secret given here no longer spends (C16)
				if (
					record?.state !== "ready" ||
					record.request !== request ||
					record.reveal === undefined ||
					record.reveal.expires <= now() ||
					!sameDigest(record.reveal.digest, givenDigest)
				)
					throw new RevealSpent("the reveal is spent");
				const was = { reveal: { ...record.reveal }, reveals: record.reveals?.map((each) => ({ ...each })) };
				const at = now();
				delete record.reveal;
				// listed in the wallet's own activity as well as the home's (UC-02 A2, H-266)
				noteReveal(record, at, "creation");
				record.version++;
				await activity(tx, {
					at,
					what: `You asked to see the key of the wallet ${walletLabel(address, record)}`,
				});
				return { was, at };
			}, context);
			try {
				await sync();
			} catch {
				// not yet safe is never told as done (C21): the reveal is put back as it was, bound to the same request and
				// secret, and the showing it noted dropped, so the same request again, once a sync works, shows the key
				await takeBack(address, request, taken);
				throw new RevealUnsynced(UNSYNCED);
			}
			return taken;
		};

		const reveal = async (
			address: string,
			request: unknown,
			secret: unknown,
		): Promise<{ hand: (socket: Socket) => Promise<AreaReply | undefined> }> => {
			const record = await recordOf(address);
			// the SHA-256 of the secret the one answer of the creation that carried it gave, as the store keeps it (C16)
			const bound = record.reveal?.digest;
			const givenDigest = typeof secret === "string" ? revealDigest(secret) : undefined;
			if (
				typeof request !== "string" ||
				record.state !== "ready" ||
				record.request !== request ||
				record.reveal === undefined ||
				record.reveal.expires <= now() ||
				givenDigest === undefined ||
				!sameDigest(bound, givenDigest)
			)
				throw walletError(SPENT, 403, "spent");
			const { signer, lifecycle } = await ready;
			return {
				hand: async (socket) => {
					/** Another call spent the reveal first. */
					let spentElsewhere = false;
					let unsynced = false;
					let spent = false;
					let handed = false;
					/** The connection reached the signer child. */
					let childHasConnection = false;
					let spending: Promise<void> | undefined;
					let taken: Taken | undefined;
					const outcome = await lifecycle.leased((lease) =>
						signer.reveal(
							lease,
							address as Address,
							socket,
							() => {
								spending = spend(address, request, givenDigest)().then(
									(made) => {
										spent = true;
										taken = made;
									},
									(error: unknown) => {
										spentElsewhere = error instanceof RevealSpent;
										unsynced = error instanceof RevealUnsynced;
										throw error;
									},
								);
								return spending;
							},
							() => {
								handed = true;
							},
							() => {
								childHasConnection = true;
							},
						),
					);
					// the connection left the daemon: the signer wrote the response onto it, or the child has it
					if (handed) return undefined;
					// the signer may give up (its deadline) while the spend's commit is still on its way: its end decides
					await spending?.catch(() => {});
					// a spend not yet on disk was taken back: the same request again, with its secret, shows the key
					if (unsynced) return { status: 503, body: { error: UNSYNCED, code: "unsynced" } };
					const code: SignerCode = outcome.ok ? "other" : outcome.code;
					// spent, and the connection never given to the child (its deadline passed first, the connection went): the
					// key provably never left, so the spend is taken back, and the same request with its secret shows the key
					if (spent && !childHasConnection && taken !== undefined) {
						const back = await takeBack(address, request, taken).then(
							() => true,
							(error: unknown) => {
								said(error);
								return false;
							},
						);
						if (back) {
							// told to try again only once the reveal is back on disk past a power cut (C21): the spend before it
							// passed a barrier, so a take-back that did not could leave the reveal spent after a cut, the owner told
							// to try again; not yet safe is said as such, and the same request again finds the reveal or the truth
							const safe = await sync().then(
								() => true,
								(error: unknown) => {
									said(error);
									return false;
								},
							);
							return safe
								? { status: 503, body: { error: WORDS[code], code } }
								: { status: 503, body: { error: UNSYNCED, code: "unsynced" } };
						}
					}
					// spent and given to the child, which never said it wrote: the key may have left, so it is gone all the same
					if (spentElsewhere || spent) return { status: 403, body: { error: SPENT, code: "spent" } };
					return { status: 503, body: { error: WORDS[code], code } };
				},
			};
		};

		/** Each block's time as the RPC gave it, by network and block: read once per process for the rows shown. */
		const times = new Map<string, number>();
		/** The blocks whose times are being read now, so two pages never read one twice. */
		const filling = new Set<string>();
		/** A block's time if it was read already; never asks the RPC. */
		const knownTime = (network: Network, block: number) => times.get(`${network.id} ${block}`);
		/**
		 * Reads the times of `blocks` not known yet, one at a time, behind the page that listed them: a page never waits on
		 * the RPC's shared bucket for its rows' times (H-198), and once some were read the open screens are told, so the
		 * page reads again and finds them. An RPC that did not give one block's time is not asked for the rest.
		 */
		const fillTimes = (network: Network, blocks: readonly number[]) => {
			const wanted = [...new Set(blocks)].filter((block) => {
				const key = `${network.id} ${block}`;
				return !times.has(key) && !filling.has(key);
			});
			if (wanted.length === 0) return;
			for (const block of wanted) filling.add(`${network.id} ${block}`);
			void (async () => {
				let read = false;
				try {
					for (const block of wanted) {
						if (stopped) return;
						if ((await timeOf(network, block)) === undefined) return;
						read = true;
					}
				} finally {
					for (const block of wanted) filling.delete(`${network.id} ${block}`);
					if (read && !stopped) {
						timed.set(network.id, (timed.get(network.id) ?? 0) + 1);
						deps.changed();
					}
				}
			})();
		};
		const timeOf = async (network: Network, block: number): Promise<number | undefined> => {
			const key = `${network.id} ${block}`;
			const known = times.get(key);
			if (known !== undefined) return known;
			try {
				const got = await (await readRpc(network)).getBlock(BigInt(block));
				if (got === null) return undefined;
				const at = Number(got.timestamp) * 1000;
				times.set(key, at);
				return at;
			} catch {
				return undefined;
			}
		};

		/**
		 * The money that came in to `address` (EIP-55), newest first, a page at a time from `before` (the `more` of the
		 * page before), and why the rows may not be all of it (UC-14 A3, H-207, H-214).
		 */
		const incoming = async (address: string, wake: boolean, before: string | null): Promise<WalletIncoming> => {
			const record = await recordOf(address);
			const network = networkOf(record.network);
			const value = await harness.snapshot(Incoming, context);
			const cursor = before === null ? undefined : CURSOR.exec(before);
			if (cursor === null) throw new BadRequest("before is the more of the page before");
			const after =
				cursor === undefined
					? () => true
					: ([id, row]: readonly [string, { readonly block: number }]) =>
							row.block < Number(cursor[1]) || (row.block === Number(cursor[1]) && id < (cursor[2] as string));
			const kept = value?.gaps?.[address] ?? [];
			// a nonce moved by more than banda's own transactions: spent outside banda (H-210), a row of its own at the block
			// that holds it, paged with the payments in one window under one cursor, so a page stays bounded however many
			// there are (H-214)
			const listed = [
				...Object.entries(value?.rows ?? {})
					.filter(([, row]) => row.wallet === address)
					.map(([id, row]) => [id, { block: row.block, row, gap: undefined }] as const),
				...kept
					.filter((gap) => gap.why === "unexplained")
					.map((gap) => [`outside:${gap.from}:${gap.to}`, { block: gap.to, row: undefined, gap }] as const),
			]
				.filter(after)
				.sort(([a, x], [b, y]) => y.block - x.block || (a < b ? 1 : -1));
			const page = listed.slice(0, INCOMING_ROWS);
			const last = page.at(-1);
			const more = listed.length > page.length && last !== undefined ? `${last[1].block}:${last[0]}` : undefined;
			const rows = page.flatMap(([id, { row }]) => (row === undefined ? [] : [[id, row] as const]));
			const shown: IncomingView[] = [];
			// the rows say the times already read, and their blocks meanwhile: the rest are read behind this answer
			for (const [id, row] of rows) {
				const at = network === undefined ? undefined : knownTime(network, row.block);
				shown.push({
					id,
					asset: row.asset,
					amount: row.amount,
					...(row.from === undefined ? {} : { from: row.from }),
					block: row.block,
					...(at === undefined ? {} : { at }),
					confirmed: incomingConfirmed(row, value?.cursors ?? {}, record.network),
				});
			}
			const status = indexer.status(record.network);
			const outside: OutsideView[] = page.flatMap(([id, { gap }]) => {
				if (gap === undefined) return [];
				const at = network === undefined ? undefined : knownTime(network, gap.to);
				return [
					{
						id,
						from: gap.from,
						block: gap.to,
						...(at === undefined ? {} : { at }),
						confirmed: incomingConfirmed({ block: gap.to }, value?.cursors ?? {}, record.network),
					},
				];
			});
			// the native stretches not listed, each by what the indexer does with it: a stretch below the state the RPC
			// serves is not asked again through it (H-204), one with code at the address cannot be read through, the
			// rest are asked again each pass
			const stateFrom = status?.stateFrom;
			const pruned = kept
				.filter((gap) => gap.why === "state" && stateFrom !== undefined && gap.to <= stateFrom)
				.reduce<number | undefined>((top, gap) => (top === undefined || gap.to > top ? gap.to : top), undefined);
			const prunedAt = pruned === undefined || network === undefined ? undefined : knownTime(network, pruned);
			const gaps = {
				...(kept.some((gap) => gap.why === "state" && (stateFrom === undefined || gap.to > stateFrom))
					? { again: true as const }
					: {}),
				...(kept.some((gap) => gap.why === "code") ? { code: true as const } : {}),
				...(pruned === undefined ? {} : { pruned, ...(prunedAt === undefined ? {} : { prunedAt }) }),
			};
			const incomplete =
				status?.failed?.logs === false
					? "logs"
					: // the RPC answers for another chain: nothing it serves is this network's, said as that alone (H-187)
						status?.failed?.otherChain === true
						? "chain"
						: // the last read stopped short: what came in since the last read is not listed (H-207, H-208)
							status?.failed !== undefined
							? "unread"
							: Object.keys(gaps).length > 0
								? "gaps"
								: // only a wallet the indexer reads is being read: a creating or removing one never is
									(record.state === "ready" || record.state === "archived") &&
										value?.read?.[address] === undefined &&
										status?.head === undefined
									? "reading"
									: undefined;
			// how far the rows are whole: the wallet's history is read and final to its read cursor (H-207)
			const readTo = value?.read?.[address];
			const readAt = readTo === undefined || network === undefined ? undefined : knownTime(network, readTo);
			if (network !== undefined)
				fillTimes(network, [
					...rows.map(([, row]) => row.block),
					...outside.map((row) => row.block),
					...(readTo === undefined ? [] : [readTo]),
					...(pruned === undefined ? [] : [pruned]),
				]);
			const dropped = more === undefined ? value?.dropped?.[address] : undefined;
			if (wake) indexer.wake(record.network);
			// the wallet's page is open: its network is read at the fast cadence while the page renews this (UC-14)
			if (before === null) indexer.looking(record.network);
			// every showing of the key, on the first page, in its declared shape: a later reveal's retry id stays in the
			// store (C21)
			const reveals = before === null ? (record.reveals ?? []).map(({ at, kind }) => ({ at, kind })) : [];
			return {
				rows: shown,
				...(outside.length === 0 ? {} : { outside }),
				...(reveals.length === 0 ? {} : { reveals }),
				...(more === undefined ? {} : { more }),
				...(incomplete === undefined ? {} : { incomplete }),
				...(incomplete === "unread" && status?.failed !== undefined ? { since: status.failed.since } : {}),
				...(incomplete === "gaps" ? { gaps } : {}),
				...(incomplete === undefined || readTo === undefined
					? {}
					: { through: { block: readTo, ...(readAt === undefined ? {} : { at: readAt }) } }),
				// past the final cursor, the rows go to the head last read: what came in after it is what is missing
				...(incomplete === "unread" && status?.head !== undefined && status.head > (readTo ?? -1)
					? { head: status.head }
					: {}),
				...(dropped === undefined ? {} : { dropped }),
			};
		};

		const receive = async (address: string): Promise<WalletReceive> => {
			const record = await recordOf(address);
			if (record.state !== "ready") throw new BadRequest("the wallet is not ready: it takes no payment now", 409);
			if (record.backup === "unsaved") return { state: "save_first" };
			if (networkOf(record.network) === undefined)
				throw new BadRequest("banda does not offer that wallet's network", 409);
			// a wallet no key opens any more, its key never saved: nothing sent to it could ever leave (H-021, H-261); one
			// not checked yet in this process is checked first, and one whose check still says nothing is not given out
			const { lifecycle } = await ready;
			if (record.backup !== "saved" && lifecycle.signingOf(address) === undefined)
				await unlock(address, record.network).catch(said);
			const signing = lifecycle.signingOf(address);
			if (record.backup !== "saved" && signing === undefined) return { state: "key_unchecked" };
			if (unopenable(record, signing)) return { state: "unopenable" };
			// no address is shown that runs code, nor one whose code could not be checked (H-157: fail closed)
			const code = await checkCode(address, record.network);
			if (code === "unchecked") return { state: "unchecked" };
			if (code === "code") {
				deps.changed();
				return { state: "code", acknowledged: record.code !== undefined };
			}
			// the record is read again in the commit that discloses it: a removal or an archive that began while the
			// code was read would otherwise hand out the address of a key it deletes (C17)
			await harness.commit(async (tx) => {
				const current = (await tx.doc(Wallets)).wallets[address];
				if (current?.state !== "ready" || current.backup === "unsaved")
					throw new BadRequest("the wallet changed: look again", 409);
				if (current.disclosed) return;
				current.disclosed = true;
				current.version++;
			}, context);
			// the mark that bars removing an unsaved key survives a power cut before the address is shown (C21)
			await durable();
			return { state: "ready", address, network: record.network };
		};

		/**
		 * The owner acknowledges the code at a wallet's address, on this computer (H-157, `acknowledge_code`): its hash and
		 * the block it was read at are kept, for the owner's Send to go on while that code stays. Receive keeps its
		 * warning. Any ready wallet acknowledges, whatever its save step: a key shown at its making and used elsewhere
		 * before it was saved can have set code there (transitions.json, `ready_unsaved acknowledge_code`).
		 */
		const acknowledgeCode = async (address: string): Promise<void> => {
			const record = await recordOf(address);
			if (record.state !== "ready") throw new BadRequest("only a wallet in use acknowledges code", 409);
			const network = networkOf(record.network);
			if (network === undefined) throw new BadRequest("banda does not offer that wallet's network", 409);
			let read: { code: string; block: bigint };
			try {
				const rpc = await readRpc(network);
				const block = await rpc.blockNumber();
				read = { code: await rpc.getCode(address, block), block };
			} catch {
				throw new BadRequest("banda could not read the wallet's address on its network: try again", 503);
			}
			if (read.code === "0x" || read.code === "") {
				noteCode(address, record.network, false);
				throw new BadRequest("no code runs at the wallet's address: there is nothing to acknowledge", 409);
			}
			noteCode(address, record.network, true);
			const hash = createHash("keccak-256")
				.update(Buffer.from(read.code.slice(2), "hex"))
				.digest("hex");
			await harness.commit(async (tx) => {
				const current = (await tx.doc(Wallets)).wallets[address];
				if (current?.state !== "ready") throw new BadRequest("the wallet changed: look again", 409);
				// this same code acknowledged already: an act tried again after its barrier failed is the same act, done
				// once, and only made safe now (C21)
				if (current.code?.hash === hash) return;
				current.code = { hash, block: Number(read.block), acknowledged: now() };
				current.version++;
				await activity(tx, {
					at: now(),
					what: `You acknowledged the code at the address of the wallet ${walletLabel(address, current)}`,
				});
			}, context);
			await durable();
		};

		const act = async (
			address: string,
			method: string,
			action: string,
			request: AreaRequest,
		): Promise<AreaReply | undefined> => {
			if (!ACTIONS.has(action)) return undefined;
			if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
			const { lifecycle } = await ready;
			switch (action) {
				case "reveal": {
					if (request.device !== undefined) throw new BadRequest(HERE, 403);
					const asked = await request.json();
					return reveal(address, asked.request, asked.secret);
				}
				case "revealed": {
					if (request.device !== undefined) throw new BadRequest(HERE, 403);
					// the desktop's id for this showing: its retry, after an answer not yet safe, lists it once (C21)
					const { id } = await request.json();
					if (id !== undefined && (typeof id !== "string" || id === "" || id.length > 100))
						throw new BadRequest("id is the desktop's id for this showing of the key");
					await harness.commit(async (tx) => {
						const record = (await tx.doc(Wallets)).wallets[address];
						if (record?.state !== "ready") throw new BadRequest("there is no such wallet", 404);
						if (id !== undefined && record.reveals?.some((each) => each.id === id)) return;
						// listed in the wallet's own activity as well as the home's (OD-2, H-266)
						noteReveal(record, now(), "later", id);
						record.version++;
						await activity(tx, {
							at: now(),
							what: `You saw the key of the wallet ${walletLabel(address, record)} on this computer`,
						});
					}, context);
					await durable();
					return { body: await view() };
				}
				case "saved": {
					// the save step is the computer's: a phone never saw the key it would vouch for (UC-02, UC-26)
					if (request.device !== undefined) throw new BadRequest(HERE, 403);
					const { digest } = await request.json();
					if (typeof digest !== "string" || !DIGEST.test(digest))
						throw new BadRequest("digest is the SHA-256 of the saved key, in lowercase hex");
					await recordOf(address);
					const { signer } = await ready;
					const checked = await lifecycle.leased((lease) => signer.confirm(lease, address as Address, digest));
					if (!checked.ok) throw walletError(WORDS[checked.code], 503, checked.code);
					await lifecycle.confirmSaved(address, checked.matches ? address : "").catch((error: unknown) => {
						if (!checked.matches && error instanceof WalletRefused && error.status === 409)
							throw walletError(error.message, 409, "wrong_copy");
						return asBadRequest(error);
					});
					return { body: await view() };
				}
				case "skip":
					if (request.device !== undefined) throw new BadRequest(HERE, 403);
					await lifecycle.skip(address).catch(asBadRequest);
					return { body: await view() };
				case "receive": {
					const given = await receive(address);
					// Receive is open: money sent to the address it shows is read in seconds, from now (UC-03, UC-14)
					if (given.state === "ready") {
						indexer.looking(given.network);
						indexer.wake(given.network);
					}
					return { body: given };
				}
				case "looking": {
					// an open wallet screen renews its look at the wallet's network (src/wallet/cadence.ts)
					indexer.looking((await recordOf(address)).network);
					return { body: {} };
				}
				case "acknowledge-code":
					if (request.device !== undefined) throw new BadRequest(HERE_HOST, 403);
					await acknowledgeCode(address);
					return { body: await view() };
				case "archive":
					await lifecycle.archive(address, await versionOf(request.json)).catch(asBadRequest);
					return { body: await view() };
				case "unarchive": {
					await lifecycle.unarchive(address, await versionOf(request.json)).catch(asBadRequest);
					// back in use, its key is checked again before the answer: the keychain may have lost it while archived
					const record = await recordOf(address);
					await unlock(address, record.network).catch(said);
					return { body: await view() };
				}
				case "remove":
					// deleting a key is the computer's: a paired device never removes one (UC-18)
					if (request.device !== undefined) throw new BadRequest(HERE_HOST, 403);
					await lifecycle.remove(address, await versionOf(request.json)).catch(asBadRequest);
					return { body: await view() };
				case "check": {
					// a check reads the host's keychain, which may prompt on its screen: never asked from a paired device
					if (request.device !== undefined) throw new BadRequest(HERE_KEYCHAIN, 403);
					await recordOf(address);
					// a wallet a silent keychain left `creating` or `removing` is settled first, now that it may answer
					await settleAgain().catch(said);
					const record = (await harness.snapshot(Wallets, context))?.wallets[address];
					if (record?.state === "ready" || record?.state === "archived") {
						const signing = await unlock(address, record.network);
						if (signing?.code === "no_keychain") keychainNone(true);
						else if (signing?.state === "online") keychainNone(false);
					}
					return { body: await view() };
				}
				default:
					return undefined;
			}
		};

		const route = async (request: AreaRequest): Promise<AreaReply | undefined> => {
			const { method, path, url, json, device } = request;
			if (path !== "/wallets" && !path.startsWith("/wallets/")) return undefined;
			// a home whose id is not its wallets' changes nothing of them: it is read, and its RPCs set, and that is all
			await ready.catch(() => {});
			if (lost && method !== "GET" && !path.startsWith("/wallets/rpc/"))
				throw walletError(IDENTITY_LOST, 503, "identity");
			if (lost && path === "/wallets/orphans") throw walletError(IDENTITY_LOST, 503, "identity");
			if (path === "/wallets") {
				if (method === "GET") return { body: await view() };
				if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
				const body = await json();
				const { request: id, name, network } = body;
				if (typeof id !== "string" || typeof name !== "string" || typeof network !== "string")
					throw new BadRequest("a wallet needs its request id, a name and a network");
				const { lifecycle } = await ready;
				const made = await lifecycle
					.create({ request: id, name, network: network as NetworkId, device: device !== undefined })
					.catch(async (error: unknown) => {
						if (!(error instanceof WalletRefused) || error.status !== 503) return asBadRequest(error);
						if (error.code === "no_keychain") keychainNone(true);
						// whether the creation waits on the keychain or left nothing is the store's to say, not the words'; one
						// that left nothing says the signer's reason, so the page tells a keychain that refused from a home that
						// does not hold the lease
						const all = (await harness.snapshot(Wallets, context))?.wallets ?? {};
						const waiting = Object.values(all).some((record) => record.request === id && record.state === "creating");
						const code: WalletErrorCode =
							error.code === "no_keychain" || error.code === "unsynced"
								? error.code
								: waiting
									? "creating"
									: (error.code ?? "dropped");
						throw walletError(error.message, 503, code);
					});
				keychainNone(false);
				// one answer of the creation carries the secret its reveal is spent with: the first from this computer to find
				// it ready (C16); a repeat after it opens nothing, nor does a paired device's creation, which stays Not backed
				// up until the host shows its key (UC-01 A3, H-267, H-268)
				const opened: WalletMade["reveal"] =
					made.secret === undefined || device !== undefined || made.record.reveal === undefined
						? undefined
						: { secret: made.secret, expires: made.record.reveal.expires };
				indexer.wake(made.record.network);
				const shown = (await view()).wallets.find((wallet) => wallet.address === made.address);
				return {
					status: 201,
					body: { wallet: shown, ...(opened === undefined ? {} : { reveal: opened }) } satisfies Partial<WalletMade>,
				};
			}
			if (path === "/wallets/keychain") {
				if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
				if (device !== undefined) throw new BadRequest(HERE_KEYCHAIN, 403);
				const { signer } = await ready;
				const answer = await signer.canary();
				const none = !answer.ok && answer.code === "no_keychain";
				keychainNone(none);
				// the keychain answers again: what it left `creating` or `removing` is settled now, not at the next start, and
				// each wallet a missing keychain held is checked again, so none still says there is no keychain (H-317, C22)
				if (answer.ok) {
					await settleAgain().catch(said);
					await unlockAll(false, (signing) => signing.code === "no_keychain");
				}
				return { body: await view() };
			}
			if (path === "/wallets/orphans") {
				if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };
				// listing the keychain may prompt on the host's screen: never asked from a paired device
				if (device !== undefined) throw new BadRequest(HERE_KEYCHAIN, 403);
				const { lifecycle } = await ready;
				return { body: { orphans: (await lifecycle.orphans()) ?? null } satisfies WalletOrphans };
			}
			const rpc = /^\/wallets\/rpc\/([^/]+)$/.exec(path);
			if (rpc !== null) {
				if (method !== "PUT") return { status: 405, body: { error: "method not allowed" } };
				if (device !== undefined) throw new BadRequest(HERE_HOST, 403);
				const id = decoded(rpc[1] as string);
				const network = id === undefined ? undefined : networkOf(id);
				if (network === undefined) throw new BadRequest("banda does not offer that network", 404);
				const { url } = await json();
				if (url !== null && typeof url !== "string") throw new BadRequest("url is the RPC's URL, or null");
				const shown = await saveRpc(home, network, url);
				log(`wallets: the ${network.label} RPC is now ${shown ?? "not set"}`);
				// what was read through the RPC before says nothing of this one's chain: the next pass reads it again (H-157)
				for (const [address, read] of coded) if (read.network === network.id) coded.delete(address);
				indexer.wake(network.id);
				return { body: (await networkView()).find((each) => each.id === network.id) };
			}
			const agent = /^\/wallets\/([^/]+)\/agents\/([^/]+)$/.exec(path);
			if (agent !== null) {
				const address = walletFromPath(agent[1] as string);
				if (address === undefined) throw new BadRequest("there is no such wallet", 404);
				if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
				const name = decoded(agent[2] as string);
				if (name === undefined) throw new BadRequest("there is no such agent", 404);
				const { on } = await json();
				if (typeof on !== "boolean") throw new BadRequest("on says whether the agent may use the wallet");
				const record = await recordOf(address);
				if (on && record.state !== "ready")
					throw new BadRequest("only a ready wallet is switched on for an agent", 409);
				await connections.switchAccount(name, WALLET, accountKey(address), on);
				await durable();
				return { body: await view() };
			}
			const coming = /^\/wallets\/([^/]+)\/incoming$/.exec(path);
			if (coming !== null) {
				if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };
				const address = walletFromPath(coming[1] as string);
				if (address === undefined) throw new BadRequest("there is no such wallet", 404);
				// a page reads again after each push, which a read of the chain made: only its first read asks for another
				return {
					body: await incoming(address, url.searchParams.get("wake") !== "false", url.searchParams.get("before")),
				};
			}
			const one = /^\/wallets\/([^/]+)\/([a-z-]+)$/.exec(path);
			if (one === null) return undefined;
			const address = walletFromPath(one[1] as string);
			if (address === undefined) throw new BadRequest("there is no such wallet", 404);
			return act(address, method, one[2] as string, request);
		};

		return {
			shell: async () => [{ type: "wallets", wallets: await view() }],
			own: [Wallets],
			route,
			stop: async () => {
				stopped = true;
				clearTimeout(resettle);
				const { signer } = await ready.catch(() => ({ signer: undefined }));
				signer?.stop();
				await indexer.stop();
			},
		};
	},
});

export const wallets: AreaModule = walletsArea();
