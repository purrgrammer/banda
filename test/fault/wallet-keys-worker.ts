/**
 * The process the desktop's key acts' fault suite kills: Move signing here (UC-21) and Restore key (UC-19), as the
 * signer runs them over a keystore in a JSON file under the home, then the check the desktop tells the daemon to run
 * after (`/wallets/:a/check`), which brings the store's lease up to the keychain's. A kill at a keychain point (once an
 * item is read, written or deleted, before anyone hears of it) or at a commit ends the act where a power cut would.
 * Each process asks the act and the check again until both are done, as the owner would after a crash. Before it does
 * anything, each process checks what the last one left: the wallet's item, when there is one, derives its address, a
 * wrong key the owner typed was never kept, no two homes read the lease as their own, and the store's lease is never
 * past the keychain's. Prints a summary as its last line.
 *
 * argv: home, act (move | restore), fault schedule JSON (Fault[])
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { context } from "../../src/core/store.ts";
import { type Address, checksummed } from "../../src/wallet/address.ts";
import { type WalletRecord, Wallets } from "../../src/wallet/docs.ts";
import { leaseOf, type SignerHome, walletAccount } from "../../src/wallet/home-id.ts";
import { type FakeState, FileKeystore } from "../../src/wallet/keystore.ts";
import { type LifecycleSigner, openLifecycle } from "../../src/wallet/lifecycle.ts";
import { addressOf, type Key } from "../../src/wallet/sign.ts";
import { serve } from "../../src/wallet/signer.ts";
import type { Request } from "../../src/wallet/signer-protocol.ts";
import { openConnected } from "../fixtures/connected.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";

/** A key invented for this suite, and the one the owner mistypes. */
export const KEY = `0x${createHash("sha256").update("banda fault wallet key").digest("hex")}` as Key;
export const WRONG = `0x${createHash("sha256").update("banda fault wrong key").digest("hex")}` as Key;
export const ID = "fault-home";
/** The home holding the lease before a move, and the copy that moves it here. */
export const THERE: SignerHome = { id: ID, binding: "a".repeat(64) };
export const HERE: SignerHome = { id: ID, binding: "b".repeat(64) };

if (process.argv[1]?.endsWith("wallet-keys-worker.ts")) {
	const [home, act, scheduleJson] = process.argv.slice(2) as [string, "move" | "restore", string];
	const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
	const path = join(home, "keychain.json");
	const keystore = new FileKeystore(path, { hit: (point) => faults.hit(point) });
	/** The same file read without faults: what the desktop learns of the lease between acts, and the summary. */
	const looking = new FileKeystore(path);
	const address = addressOf(KEY);
	const account = walletAccount(ID, address);
	const items = (): { [account: string]: string } =>
		existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FakeState).items : {};
	const violations: unknown[] = [];

	// the home's store: a copy of the home holding the lease (a move), or the home itself (a restore), at its epoch
	const s = await openConnected({
		home,
		respond: () => fauxAssistantMessage("Done."),
		wrapStorage: (storage) => faults.storage(storage),
		fault: (point) => faults.hit(point as FaultPoint),
	});
	const stored = async () => (await s.harness.snapshot(Wallets, context))?.lease;

	/** No two homes read the lease as their own, and the store never took an epoch the keychain has not reached. */
	const holds = async (when: string) => {
		const here = await leaseOf(looking, HERE);
		const there = await leaseOf(looking, THERE);
		if (here?.mine === true && there?.mine === true) violations.push({ when, both: here.epoch });
		const taken = await stored();
		if (taken !== undefined && (here === null || taken > here.epoch))
			violations.push({ when, stored: taken, keychain: here?.epoch ?? null });
	};

	// what the process before this one left
	const left = items()[account];
	if (act === "move" && left === undefined) violations.push({ lost: address });
	if (left !== undefined && left !== KEY.toLowerCase()) violations.push({ kept: left === WRONG ? "wrong" : "other" });
	await holds("start");

	const record: WalletRecord = {
		name: "Groceries",
		network: "base-sepolia",
		state: "ready",
		backup: "saved",
		default: "ask",
		disclosed: false,
		request: "request-fault",
		version: 1,
		at: 0,
	};
	await s.harness.commit(async (tx) => {
		const wallets = await tx.doc(Wallets);
		wallets.lease ??= 1;
		wallets.wallets[checksummed(address)] ??= record;
	}, context);

	/** The act asked of the signer: undefined once done, else the code it refused with. */
	const ask = async (body: object): Promise<string | undefined> => {
		const request = { ...body, id: randomBytes(16).toString("hex"), home: HERE } as Request;
		const answer = await serve(request, keystore);
		if ("step" in answer) return "other";
		return answer.ok ? undefined : answer.code;
	};
	/** The signer as the daemon's lifecycle calls it, here, at this home. */
	const call = async (body: object): Promise<never> => {
		const request = { ...body, id: randomBytes(16).toString("hex"), home: HERE } as Request;
		const answer = await serve(request, keystore);
		if ("step" in answer) return { ok: false, code: "other" } as never;
		return (answer.ok ? { ok: true, ...(answer.result as object) } : { ok: false, code: answer.code }) as never;
	};
	const signer: LifecycleSigner = {
		lease: (expected) => call({ op: "lease", expected }),
		leased: () => call({ op: "leased" }),
		create: (lease) => call({ op: "create", lease }),
		derive: (lease, address) => call({ op: "derive", lease, address }),
		remove: (lease, address) => call({ op: "remove", lease, address }),
		find: () => call({ op: "find" }),
	};
	const life = openLifecycle({
		harness: s.harness,
		signer,
		home: ID,
		accounts: s.capabilities,
		funded: async () => false,
		context,
	});

	const codes: string[] = [];
	for (let tries = 0; tries < 8; tries++) {
		const lease = await leaseOf(looking, HERE);
		if (lease === null) {
			violations.push({ lease: "gone" });
			break;
		}
		if (act === "move") {
			if (lease.mine) break;
			const moved = await ask({ op: "move", expected: lease.epoch, addresses: [address] });
			if (moved !== undefined) codes.push(moved);
			continue;
		}
		if (items()[account] === KEY.toLowerCase()) break;
		// the owner's mistyped key first: refused, and never kept
		const wrong = await ask({ op: "restore", lease: lease.epoch, address, key: WRONG });
		if (wrong === undefined) violations.push({ restored: "wrong" });
		const restored = await ask({ op: "restore", lease: lease.epoch, address, key: KEY });
		if (restored !== undefined) codes.push(restored);
	}
	await holds("act");

	// the check the desktop tells the daemon to run once the act is done: the store catches up to the keychain's lease
	let signing: string | undefined;
	for (let tries = 0; tries < 8 && signing !== "online"; tries++) {
		const checked = await life.unlockCheck(address as Address);
		signing = checked?.state;
		if (checked?.code !== undefined) codes.push(checked.code);
	}
	await holds("check");

	const lease = await leaseOf(looking, HERE);
	const there = await leaseOf(looking, THERE);
	const kept = items()[account];
	console.log(
		JSON.stringify({
			address: checksummed(address),
			lease,
			there: there?.mine ?? false,
			thereEpoch: there?.epoch ?? null,
			stored: (await stored()) ?? null,
			signing: signing ?? null,
			derives: kept === undefined ? false : addressOf(kept as Key) === address,
			wallets: Object.keys(items()).filter((name) => name.startsWith(`${ID}/wallet/`)),
			codes,
			violations,
			points: faults.counts(),
		}),
	);
	await s.close();
}
