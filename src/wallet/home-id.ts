/**
 * Which home a keychain item belongs to, and which home may sign (C16, R-12). The id names: it is the home's own
 * `auth/device-id`, so every item a home makes is findable under `<home-id>/…`, and a backup or a hand copy, which
 * carry the id, look at the same items. The lease decides: a home signs only while the keychain's lease item
 * `<home-id>/lease` names the hash of the home secret, and the home secret `<home-id>/home-secret` is bound to the
 * home's binding: its realpath, its folder's inode and birth time, and the mark a restore left (src/core/restored.ts).
 * The binding lives in no file, so a backup, a restore (wherever it lands, at the same path too), a fork or a hand copy
 * (`cp -a`, rsync, a restore to another folder) has another one and starts offline.
 * It holds only what stays while the home lives where it is: the device number is not in it, since a remount or a
 * reboot can renumber a volume (an external disk, a btrfs subvolume), and on Linux neither is the birth time, which
 * Node reports as the change time where statx is missing, and that moves with every entry made in the folder.
 *
 * The home secret is written only for a home that never held a lease: once a lease exists, a missing or unreadable
 * secret is never made again, since any copy carrying the id could make it (H-287). Taking the lease to a home whose
 * binding is not the secret's (one moved to another folder, a restore the owner chose) is `moveLease`, the owner's
 * explicit host act (UC-21). A fork (`npm run home:fork`) signs nothing: its marker makes it refuse every lease, so it
 * never signs, whatever id it has (H-283).
 *
 * The functions on a `Keystore` run in the signer child (C20), the only process that reaches the keychain. Only the
 * lease's epoch is rewritten by a claim (C15); the home secret only by a move.
 */
import { createHash } from "node:crypto";
import { realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { readMarker } from "../core/marker.ts";
import { restoredOf } from "../core/restored.ts";
import { installationId, readInstallationId } from "../home.ts";
import { type Address, checksummed } from "./address.ts";
import { homeSecretValue } from "./draws.ts";
import { type Keystore, TEST_KEYSTORE_ENV, testKeystore } from "./keystore.ts";

/** What the signer is told of the home it serves. */
export type SignerHome = {
	/** Names the home's items. */
	id: string;
	/** sha256 of the home's realpath and its folder's inode and birth time, hex (`bindingOf`). */
	binding: string;
	/** A fork's, which never takes the lease. */
	fork?: true;
	/** A test's, whose signer is given a test keystore or none: it never opens the OS keychain (H-031). */
	test?: true;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * A binding from the home's realpath and its folder's stat, the birth time only where the platform keeps one, and the
 * mark a restore left, where one did: a home never restored is bound by its path and folder alone.
 */
export function bindingOf(
	path: string,
	folder: { ino: bigint; birthtimeNs: bigint },
	platform: NodeJS.Platform = process.platform,
	restored?: string,
): string {
	const born = platform === "linux" ? "" : String(folder.birthtimeNs);
	return sha256(["banda/home", path, folder.ino, born, ...(restored === undefined ? [] : [restored])].join("\0"));
}

/** The home's binding: where it is on this computer, as no copy of it can be. */
export async function homeBinding(home: string): Promise<string> {
	const path = await realpath(home);
	return bindingOf(path, await stat(path, { bigint: true }), process.platform, await restoredOf(path));
}

/**
 * The file at a fork's root that marks it as signing nothing. A file copy of a fork (`cp -a`, rsync) carries it and is one too;
 * a backup carries only the files src/core/backup.ts lists, so a fork's backup restores as a home that is not a fork,
 * and starts without the lease as every restore does.
 */
export const FORK_MARKER = "fork.json";
const ForkMarker = Type.Object({ fork: Type.Literal(true) }, { additionalProperties: false });

/**
 * The file at a test home's root (test/helpers.ts `tempHome` writes it): its signer, and that of every home a test
 * makes inside it, never opens the OS keychain.
 */
export const TEST_HOME_MARKER = "test-home.json";
const TestHomeMarker = Type.Object({ test: Type.Literal(true) }, { additionalProperties: false });

export async function markFork(home: string): Promise<void> {
	await writeFile(join(home, FORK_MARKER), `${JSON.stringify({ fork: true })}\n`);
}

export async function markTestHome(home: string): Promise<void> {
	await writeFile(join(home, TEST_HOME_MARKER), `${JSON.stringify({ test: true })}\n`);
}

/** Whether `home` holds `file`, checked against `schema`. A marker that is not one is refused, never read as absent. */
async function marked(home: string, file: string, schema: TSchema, what: string): Promise<boolean> {
	return (await readMarker(join(home, file), schema, `${what} marker`)) !== undefined;
}

export function isFork(home: string): Promise<boolean> {
	return marked(home, FORK_MARKER, ForkMarker, "a fork's");
}

/**
 * A folder under a test's home (a sub-home, a restore or fork beside it) is a test's too, up to `top` (the temp
 * folder), above which no marker is read.
 */
export async function isTestHome(home: string, top: string = tmpdir()): Promise<boolean> {
	const bound = await realpath(top);
	let at = await realpath(home).catch(() => resolve(home));
	for (;;) {
		if (await marked(at, TEST_HOME_MARKER, TestHomeMarker, "a test home's")) return true;
		const up = dirname(at);
		if (up === at || !up.startsWith(`${bound}${sep}`)) return false;
		at = up;
	}
}

/** Whether `home` lies under `top`, the temp folder. */
async function underTemp(home: string, top: string): Promise<boolean> {
	const bound = await realpath(top);
	const at = await realpath(home).catch(() => resolve(home));
	return at.startsWith(`${bound}${sep}`);
}

/** What the owner is told while the home's id is missing from a home that holds wallets (H-261). */
export const IDENTITY_LOST =
	"This home's identity is missing, and it names every wallet key in your keychain: put back the auth/device-id this home had, then start banda again. Until then the wallets are offline, and nothing is changed.";

/** The home's id is missing, and this call may not make one: its code is the wallets' `identity`. */
export class IdentityMissing extends Error {
	readonly code = "identity";
	constructor() {
		super(IDENTITY_LOST);
		this.name = "IdentityMissing";
	}
}

/**
 * `home` as its signer knows it. Its id is read, never made, unless `make` says this home holds no wallet yet (the
 * wallets' area, from its store): a signer elsewhere (the desktop app's) refuses a home whose id is missing with
 * `IdentityMissing`, so nothing is written under a new id while the old one names the wallets' keys (H-261). A test keystore (`TEST_KEYSTORE_ENV`) is refused for a home that is not a test's (no
 * marker, not under `top`, the temp folder): a daemon started from a checkout with it left set would lose its wallets'
 * keys at exit, or keep them in a plain file in the home.
 */
export async function signerHome(
	home: string,
	env: NodeJS.ProcessEnv = process.env,
	top: string = tmpdir(),
	options: { readonly make?: boolean } = {},
): Promise<SignerHome> {
	const fork = await isFork(home);
	const test = await isTestHome(home);
	if (!test && testKeystore(env) !== undefined && !(await underTemp(home, top)))
		throw new Error(`${TEST_KEYSTORE_ENV} is for a test's home: this home's keys would not be kept`);
	const id = options.make === true ? await installationId(home) : await readInstallationId(home);
	if (id === undefined) throw new IdentityMissing();
	const at: SignerHome = { id, binding: await homeBinding(home) };
	if (fork) at.fork = true;
	if (test) at.test = true;
	return at;
}

/**
 * Whether `id` is not the id this home's wallets were made under, from what the home holds: a wallet's credentials
 * that name a keychain account under another id, or an id this process made new (its file was missing) in a home whose
 * store holds wallets or a lease. Every keychain item is named by the id, so a wallet run on a new one reads as its key
 * missing while the key stays under the old id, out of reach and listed as no key without a wallet. The wallets go
 * offline instead, and nothing is made or rewritten under the new id, until the owner puts the old one back.
 */
export function identityLost(
	id: string,
	home: {
		/** This process made the id, its file missing (`madeInstallationId`). */
		readonly made: boolean;
		/** The store holds a wallet's record or the home's lease. */
		readonly wallets: boolean;
		/** The keychain account each wallet's credentials name. */
		readonly accounts: readonly string[];
	},
): boolean {
	if (home.accounts.some((account) => !account.startsWith(walletPrefix(id)))) return true;
	return home.made && home.wallets;
}

/** The keychain account of a wallet's key, named after its address (R-13). */
export const walletAccount = (id: string, address: Address) => `${id}/wallet/${checksummed(address)}`;
export const walletPrefix = (id: string) => `${id}/wallet/`;
export const leaseAccount = (id: string) => `${id}/lease`;
export const homeSecretAccount = (id: string) => `${id}/home-secret`;
/**
 * A canary that tells a missing key from a keychain that cannot answer (H-037): one of a home's few slots
 * (signer.ts `CANARY_SLOTS`), overwritten by the next call that takes it, so it is never found by listing the keychain.
 */
export const canaryAccount = (id: string, slot: number) => `${id}/canary/${slot}`;

const Hex64 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const HomeSecret = Type.Object({ secret: Hex64, binding: Hex64 }, { additionalProperties: false });
const Lease = Type.Object({ epoch: Type.Integer({ minimum: 1 }), holder: Hex64 }, { additionalProperties: false });

/** An item that holds what no banda wrote: never adopted, never rewritten. */
export class Unreadable extends Error {
	constructor() {
		super("a home item is not banda's");
		this.name = "Unreadable";
	}
}

function parsed<T extends TSchema>(schema: T, raw: string | null): Static<T> | null {
	if (raw === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Unreadable();
	}
	if (!Value.Check(schema, value)) throw new Unreadable();
	return value;
}

/** The lease as the keychain holds it, and whether it is this home's. */
export async function leaseOf(keystore: Keystore, home: SignerHome): Promise<{ epoch: number; mine: boolean } | null> {
	const lease = parsed(Lease, await keystore.read(leaseAccount(home.id)));
	if (lease === null) return null;
	const secret = parsed(HomeSecret, await keystore.read(homeSecretAccount(home.id)));
	const mine =
		home.fork !== true && secret !== null && secret.binding === home.binding && lease.holder === sha256(secret.secret);
	return { epoch: lease.epoch, mine };
}

/** Whether this home holds the lease at `epoch`, the one its store last took. */
export async function leaseMine(keystore: Keystore, home: SignerHome, epoch: number): Promise<boolean> {
	const lease = await leaseOf(keystore, home);
	return lease?.mine === true && lease.epoch === epoch;
}

/**
 * Takes the lease for this home by compare-and-set on its epoch: only when the keychain's epoch is `expected` (null for
 * a home with none yet) and the home secret is this home's. A home that never held a lease (no lease item, `expected`
 * null) writes its home secret first if there is none; one with a lease never does. Then the lease at the next epoch,
 * and both read back. The new epoch, or null when the compare failed, the secret is missing or another's, or the home
 * is a fork.
 */
export async function claimLease(
	keystore: Keystore,
	home: SignerHome,
	expected: number | null,
): Promise<number | null> {
	if (home.fork) return null;
	const current = parsed(Lease, await keystore.read(leaseAccount(home.id)));
	if ((current?.epoch ?? null) !== expected) return null;
	let secret = parsed(HomeSecret, await keystore.read(homeSecretAccount(home.id)));
	if (secret !== null && secret.binding !== home.binding) return null;
	if (secret === null) {
		if (current !== null) return null;
		secret = { secret: homeSecretValue(), binding: home.binding };
		await keystore.write(homeSecretAccount(home.id), JSON.stringify(secret));
		const back = parsed(HomeSecret, await keystore.read(homeSecretAccount(home.id)));
		if (back?.secret !== secret.secret || back.binding !== secret.binding) return null;
	}
	const next = { epoch: (expected ?? 0) + 1, holder: sha256(secret.secret) };
	await keystore.write(leaseAccount(home.id), JSON.stringify(next));
	return (await leaseMine(keystore, home, next.epoch)) ? next.epoch : null;
}

/**
 * Takes the lease back for this home on a keychain that holds no lease item for it (H-021, H-286): the keychain lost
 * banda's items, or the home came from another computer, while its store last took the lease at `after`. Only the
 * owner's Restore does it, re-authenticated and with a key proven to derive its wallet's address before this runs. A
 * fresh home secret bound to this home replaces any left, then the lease at `after + 1`, past every epoch the store
 * took, both read back. The new epoch, or null when the keychain holds a lease item (another home's, or this one's:
 * the ordinary restore then) or the home is a fork.
 */
export async function reclaimLease(keystore: Keystore, home: SignerHome, after: number): Promise<number | null> {
	if (home.fork) return null;
	if ((await keystore.read(leaseAccount(home.id))) !== null) return null;
	const secret = { secret: homeSecretValue(), binding: home.binding };
	await keystore.write(homeSecretAccount(home.id), JSON.stringify(secret));
	const back = parsed(HomeSecret, await keystore.read(homeSecretAccount(home.id)));
	if (back?.secret !== secret.secret || back.binding !== secret.binding) return null;
	const next = { epoch: after + 1, holder: sha256(secret.secret) };
	await keystore.write(leaseAccount(home.id), JSON.stringify(next));
	return (await leaseMine(keystore, home, next.epoch)) ? next.epoch : null;
}

/**
 * Moves the lease to this home (UC-21), the owner's explicit host act, by compare-and-set on its epoch: only when the
 * keychain holds a lease at `expected`, or holds no lease item at all while the store last took `expected`, or null for
 * none taken anywhere (the
 * keychain lost banda's items, or the home came from another computer: no home on this keychain holds it, H-286). `prove` runs before anything is written and throws to stop the move. A fresh
 * home secret bound to this home's binding replaces the old one, or a missing one (H-287), then the lease at the next
 * epoch, both read back; the home that held it reads the lease as not its own from then on. A move stopped between the
 * two writes leaves every home offline at `expected`, and its rerun completes it. The new epoch is past `after` as well
 * when given, the epoch the home's store last took: a lease item behind the store (a keychain rolled back) moves to
 * one the store takes. The new epoch, or null when the compare failed or the home is a fork.
 */
export async function moveLease(
	keystore: Keystore,
	home: SignerHome,
	expected: number | null,
	prove: () => Promise<void> = async () => {},
	after?: number,
): Promise<number | null> {
	if (home.fork) return null;
	const current = parsed(Lease, await keystore.read(leaseAccount(home.id)));
	if (current !== null && current.epoch !== expected) return null;
	parsed(HomeSecret, await keystore.read(homeSecretAccount(home.id)));
	await prove();
	const secret = { secret: homeSecretValue(), binding: home.binding };
	await keystore.write(homeSecretAccount(home.id), JSON.stringify(secret));
	const back = parsed(HomeSecret, await keystore.read(homeSecretAccount(home.id)));
	if (back?.secret !== secret.secret || back.binding !== secret.binding) return null;
	const next = { epoch: Math.max(expected ?? 0, after ?? 0) + 1, holder: sha256(secret.secret) };
	await keystore.write(leaseAccount(home.id), JSON.stringify(next));
	return (await leaseMine(keystore, home, next.epoch)) ? next.epoch : null;
}
