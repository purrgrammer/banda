/**
 * The signer child (C20): a short-lived process the daemon starts from its own binary for one keychain operation, so
 * the key never enters the daemon, a call blocked on a prompt starves no thread of the daemon's, and the daemon can end
 * it at its deadline by SIGKILL. It reads one request from stdin (src/wallet/signer-protocol.ts), answers once on
 * stdout, and exits. Of signing it offers two operations, an EIP-1559 transfer and an EIP-3009 authorization, and no
 * others; the rest keep the keychain: the canary, the lease and its state, a creation, the owner's Restore key, the
 * proof of a key, a removal (only of an item that derives the wallet's address, H-045), the listing of a home's
 * items, and for the owner's backup a reveal, an export and the check of a saved copy.
 *
 * A reveal is the one way the key leaves for the daemon's client (C16): once the child proved the key it says so, the
 * daemon spends the reveal and hands it the client's connection over the IPC channel, and the child writes the whole
 * HTTP response onto it and closes it, so the key never passes through the daemon (C20). An export answers the key to
 * the host process that asked (src/wallet/signer-host.ts), which only the desktop app's main process starts.
 *
 * Before it signs or says a key is good it proves it: this home must hold the lease at the epoch the daemon's store
 * took (C16, H-020), checked before any key is read, so a copy of the home never reads the live wallet's key (H-283);
 * and the key read must derive the wallet's address (C16, H-025). The one exception is the owner's move (UC-21), which
 * the host alone sends: it proves each key before it takes the lease, so a key that fails is found while the home
 * holding the lease is still online. A null read alone never means "missing": the canary
 * decides (H-037). An item is never overwritten (H-024), and every write is read back (H-006). An answer carries a
 * fixed code on failure, never what the keychain or the request said (H-010).
 *
 * A child whose parent is gone starts no write and no removal (`whileAsked`): a daemon killed while its child waits on
 * a prompt leaves that child behind, and the next daemon's child writes the same items, which a late write of the
 * first would race (H-036 across processes). The parent's end shows as the end of stdin, which it never closes, or as
 * the child handed to another parent.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import inspector from "node:inspector";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { type Address, checksummed } from "./address.ts";
import { canarySlot, canaryValue } from "./draws.ts";
import {
	canaryAccount,
	claimLease,
	leaseMine,
	leaseOf,
	moveLease,
	reclaimLease,
	type SignerHome,
	Unreadable,
	walletAccount,
	walletPrefix,
} from "./home-id.ts";
import { type Keystore, KeystoreError, keystoreFor } from "./keystore.ts";
import { addressOf, generateKey, type Key, signTransfer, signTransferWithAuthorization } from "./sign.ts";
import { type Answer, debugging, Go, Request, type SignerCode } from "./signer-protocol.ts";

class Stop extends Error {
	readonly code: SignerCode;
	readonly why: string | undefined;
	constructor(code: SignerCode, why?: string) {
		super(code);
		this.code = code;
		this.why = why;
	}
}

function stop(code: SignerCode, why?: string): never {
	throw new Stop(code, why);
}

const KEY = /^0x[0-9a-fA-F]{64}$/;

/** How many canary accounts a home has: a small fixed set, so a call killed after its write leaves at most these. */
export const CANARY_SLOTS = 8;

/** How many slots a canary tries before it says the keychain does not answer: another call may hold the first. */
const CANARY_TRIES = 3;

/**
 * Sets, reads back and removes a canary: silent when the keychain answers, its failure's code when not. It never lists
 * the keychain: a listing answers every item of the service with its secret (every key of every home on this computer,
 * forks and copies included) and may prompt once per item another binary wrote (H-009, H-037). So a canary is one of a
 * small fixed set of accounts (`CANARY_SLOTS`), each overwritten by whichever call takes it next: a call killed at its
 * deadline leaves its slot holding nothing but random bytes, and the next call on that slot takes it back. Every copy
 * of a home and the desktop's signer share the id, so a slot another call holds reads back its value: the call tries
 * the next slot, and only a keychain that keeps none of its writes is said not to answer.
 */
export async function canary(
	keystore: Keystore,
	home: SignerHome,
	pick: () => number = () => canarySlot(CANARY_SLOTS),
): Promise<void> {
	const first = pick();
	for (let tries = 0; tries < CANARY_TRIES; tries++) {
		const account = canaryAccount(home.id, (first + tries) % CANARY_SLOTS);
		const value = canaryValue();
		await keystore.write(account, value);
		const back = await keystore.read(account);
		await keystore.remove(account);
		if (back === value) return;
	}
	stop("no_keychain");
}

/** The wallet's key, proven to derive its address. */
async function keyOf(keystore: Keystore, home: SignerHome, address: Address): Promise<Key> {
	const raw = await keystore.read(walletAccount(home.id, address));
	if (raw === null) {
		await canary(keystore, home);
		return stop("missing");
	}
	if (!KEY.test(raw)) stop("wrong_key");
	let derived: Address;
	try {
		derived = addressOf(raw as Key);
	} catch {
		return stop("wrong_key");
	}
	if (derived !== checksummed(address)) stop("wrong_key");
	return raw as Key;
}

async function held(keystore: Keystore, home: SignerHome, lease: number): Promise<void> {
	if (!(await leaseMine(keystore, home, lease))) stop("other_home");
}

/** Writes `key` where nothing is, and reads it back. */
async function keep(keystore: Keystore, home: SignerHome, address: Address, key: Key): Promise<void> {
	const account = walletAccount(home.id, address);
	if ((await keystore.read(account)) !== null) stop("exists");
	await keystore.write(account, key);
	if ((await keystore.read(account)) !== key) stop("other", "the keychain did not keep the key");
}

/** The SHA-256 of a key as the owner saves it, `0x` and lowercase hex: what a saved copy is checked by. */
export const keyDigest = (key: string): string =>
	createHash("sha256").update(key.trim().toLowerCase(), "utf8").digest("hex");

/** The reveal as its client reads it: the whole HTTP response, the key beside the address it opens, never cached. */
export function revealed(address: Address, key: Key): string {
	const body = JSON.stringify({ address, key: key.toLowerCase() });
	return [
		"HTTP/1.1 200 OK",
		"content-type: application/json",
		"cache-control: no-store",
		"x-content-type-options: nosniff",
		`content-length: ${Buffer.byteLength(body)}`,
		"connection: close",
		"",
		body,
	].join("\r\n");
}

/** Writes `response` onto the client's connection and closes it; false when the connection is gone. */
export function writeOnto(connection: Socket, response: string): Promise<boolean> {
	return new Promise((resolve) => {
		if (connection.destroyed || !connection.writable) return resolve(false);
		connection.once("error", () => resolve(false));
		connection.end(response, () => resolve(true));
	});
}

async function run(
	request: Request,
	keystore: Keystore,
	drawn: (address: Address) => Promise<boolean>,
	shown: (response: string) => Promise<boolean>,
): Promise<unknown> {
	const { home } = request;
	switch (request.op) {
		case "canary":
			await canary(keystore, home);
			return {};
		case "lease": {
			const epoch = await claimLease(keystore, home, request.expected);
			if (epoch === null) stop("other_home");
			return { epoch };
		}
		case "leased":
			return { lease: await leaseOf(keystore, home) };
		case "move": {
			const epoch = await moveLease(
				keystore,
				home,
				request.expected,
				async () => {
					for (const address of request.addresses) await keyOf(keystore, home, address as Address);
				},
				request.after,
			);
			if (epoch === null) stop("other_home");
			return { epoch };
		}
		case "create": {
			await held(keystore, home, request.lease);
			let key: Key;
			try {
				key = generateKey();
			} catch {
				return stop("other", "banda could not make a key on this computer");
			}
			const address = addressOf(key);
			if (!(await drawn(address))) stop("other");
			await keep(keystore, home, address, key);
			return { address };
		}
		case "restore": {
			// a keychain that lost every banda item has no lease to restore under: the proven key takes it back, past the
			// epoch the store took (`lease`), before it is kept (H-286); a keychain with a lease item restores under it
			const lost = (await leaseOf(keystore, home)) === null;
			if (!lost) await held(keystore, home, request.lease);
			else if (home.fork === true) stop("other_home");
			const address = checksummed(request.address as Address);
			let derived: Address;
			try {
				derived = addressOf(request.key as Key);
			} catch {
				return stop("wrong_key");
			}
			if (derived !== address) stop("wrong_key");
			if (lost && (await reclaimLease(keystore, home, request.lease)) === null) stop("other_home");
			await keep(keystore, home, address, request.key.toLowerCase() as Key);
			return { address };
		}
		case "derive": {
			await held(keystore, home, request.lease);
			await keyOf(keystore, home, request.address as Address);
			return { address: checksummed(request.address as Address) };
		}
		case "transfer": {
			await held(keystore, home, request.lease);
			const key = await keyOf(keystore, home, request.address as Address);
			const { fields } = request;
			return signTransfer({
				key,
				chainId: fields.chainId,
				nonce: BigInt(fields.nonce),
				maxFee: BigInt(fields.maxFee),
				tip: BigInt(fields.tip),
				gasLimit: BigInt(fields.gasLimit),
				to: fields.to as Address,
				value: BigInt(fields.value),
				...(fields.token === undefined ? {} : { token: fields.token as Address }),
			});
		}
		case "authorization": {
			await held(keystore, home, request.lease);
			const key = await keyOf(keystore, home, request.address as Address);
			const { fields } = request;
			return signTransferWithAuthorization({
				key,
				chainId: fields.chainId,
				token: { ...fields.token, address: fields.token.address as Address },
				to: fields.to as Address,
				value: BigInt(fields.value),
				validAfter: BigInt(fields.validAfter),
				validBefore: BigInt(fields.validBefore),
				nonce: fields.nonce as `0x${string}`,
			});
		}
		case "remove": {
			await held(keystore, home, request.lease);
			await keyOf(keystore, home, request.address as Address);
			return { removed: await keystore.remove(walletAccount(home.id, request.address as Address)) };
		}
		case "reveal": {
			await held(keystore, home, request.lease);
			const address = checksummed(request.address as Address);
			const key = await keyOf(keystore, home, address);
			if (!(await shown(revealed(address, key)))) stop("other");
			return {};
		}
		case "confirm": {
			await held(keystore, home, request.lease);
			const key = await keyOf(keystore, home, request.address as Address);
			return { matches: timingSafeEqual(Buffer.from(keyDigest(key), "hex"), Buffer.from(request.digest, "hex")) };
		}
		case "export": {
			await held(keystore, home, request.lease);
			const address = checksummed(request.address as Address);
			return { address, key: (await keyOf(keystore, home, address)).toLowerCase() };
		}
		case "find": {
			// the listing answers every item of the keychain's service with its secret: only the home that holds the lease
			// lists, never a fork or a copy of it, so they read no key of the live wallets' (H-283)
			if (home.fork === true) stop("other_home");
			await held(keystore, home, request.lease);
			const prefix = walletPrefix(home.id);
			const addresses: Address[] = [];
			for (const account of await keystore.find(prefix)) {
				try {
					addresses.push(checksummed(account.slice(prefix.length)));
				} catch {}
			}
			return { addresses };
		}
	}
}

/** `keystore` while `asked` holds: once it does not, a write or a removal stops before it starts, as `other`. */
function whileAsked(keystore: Keystore, asked: () => boolean): Keystore {
	const still = () => {
		if (!asked()) stop("other", "the process that asked is gone");
	};
	return {
		read: (account) => keystore.read(account),
		write: async (account, secret) => {
			still();
			await keystore.write(account, secret);
		},
		remove: async (account) => {
			still();
			return keystore.remove(account);
		},
		find: (prefix) => keystore.find(prefix),
	};
}

/**
 * Does `request` against `keystore`. `drawn` hears a creation's address before anything is written and says whether
 * to go on; `shown` is told a reveal's response once its key is proven, writes it onto the client's connection, and
 * says whether it did. The daemon's child runs this; so does a test's signer in process, with a test keystore.
 */
export async function serve(
	request: Request,
	keystore: Keystore,
	drawn: (address: Address) => Promise<boolean> = async () => true,
	shown: (response: string) => Promise<boolean> = async () => false,
): Promise<Answer> {
	const { id } = request;
	if (debugging(process.execArgv, process.env.NODE_OPTIONS, inspector.url()))
		return { id, ok: false, code: "debugging" };
	try {
		return { id, ok: true, result: await run(request, keystore, drawn, shown) };
	} catch (error) {
		if (error instanceof Stop)
			return { id, ok: false, code: error.code, ...(error.why === undefined ? {} : { why: error.why }) };
		if (error instanceof KeystoreError) return { id, ok: false, code: error.code };
		if (error instanceof Unreadable) return { id, ok: false, code: "other", why: error.message };
		if (error instanceof Error && error.message.startsWith("cannot sign: "))
			return { id, ok: false, code: "refused", why: error.message };
		return { id, ok: false, code: "other" };
	}
}

async function main(): Promise<void> {
	const parent = process.ppid;
	let ended = false;
	process.stdin.once("end", () => {
		ended = true;
	});
	const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
	const next = async (): Promise<unknown> => {
		const line = await lines.next();
		if (line.done) return undefined;
		try {
			return JSON.parse(line.value);
		} catch {
			return undefined;
		}
	};
	const say = (answer: Answer) =>
		new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(answer)}\n`, () => resolve()));
	const request = await next();
	if (!Value.Check(Request, request)) process.exit(2);
	let keystore: Keystore;
	try {
		keystore = whileAsked(keystoreFor(process.env, undefined, request.home), () => !ended && process.ppid === parent);
	} catch {
		await say({ id: request.id, ok: false, code: "other" });
		process.exit(0);
	}
	const answer = await serve(
		request,
		keystore,
		async (address) => {
			await say({ id: request.id, step: "drawn", address });
			const go = await next();
			return Value.Check(Go, go) && go.id === request.id;
		},
		async (response) => {
			if (process.send === undefined) return false;
			const handed = new Promise<Socket | undefined>((resolve) => {
				process.once("message", (go: unknown, connection: unknown) =>
					resolve(Value.Check(Go, go) && go.id === request.id ? (connection as Socket | undefined) : undefined),
				);
				process.once("disconnect", () => resolve(undefined));
			});
			await say({ id: request.id, step: "proven" });
			const connection = await handed;
			return connection === undefined ? false : writeOnto(connection, response);
		},
	);
	await say(answer);
	process.exit(0);
}

const entry = process.argv[1];
let isMain = false;
try {
	isMain = entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
} catch {}
if (isMain) await main();
