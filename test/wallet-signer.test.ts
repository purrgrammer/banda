/**
 * The signer child and its client (src/wallet/signer.ts, src/wallet/signer-client.ts, C20): a real child started from
 * this process's binary per call, over a file-backed test keystore; never the OS keychain. A call past its deadline is
 * killed and its late answer dropped, one call runs per home at a time, inspector and heap-dump flags take every call
 * offline, each failure is a fixed code, and no answer ever carries the key.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "../src/wallet/address.ts";
import { canaryAccount, claimLease, type SignerHome, walletAccount } from "../src/wallet/home-id.ts";
import {
	type FakeState,
	FileKeystore,
	KeychainStore,
	type Keystore,
	type KeystoreFault,
	memoryKeystore,
} from "../src/wallet/keystore.ts";
import { addressOf, generateKey, type Key, signTransfer, signTransferWithAuthorization } from "../src/wallet/sign.ts";
import { CANARY_SLOTS, canary, serve } from "../src/wallet/signer.ts";
import { CHILD_FLAGS, SIGNER, Signer, signerNode } from "../src/wallet/signer-client.ts";
import { HostSigner } from "../src/wallet/signer-host.ts";
import { debugging, HOST_OPS } from "../src/wallet/signer-protocol.ts";
import { until } from "./helpers.ts";

const dirs: string[] = [];
const signers: Signer[] = [];
afterEach(async () => {
	for (const signer of signers.splice(0)) signer.stop();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Setup = { home: SignerHome; store: FileKeystore; signer: HostSigner; env: NodeJS.ProcessEnv; dir: string };

async function setup(options: { deadline?: number; script?: string } = {}): Promise<Setup> {
	const dir = await mkdtemp(join(tmpdir(), "banda-signer-"));
	dirs.push(dir);
	const path = join(dir, "keys.json");
	const env = { ...process.env, BANDA_TEST_KEYSTORE: path };
	const home = { id: `h-${randomBytes(4).toString("hex")}`, binding: randomBytes(32).toString("hex") };
	const signer = new HostSigner(home, { env, deadline: options.deadline ?? 10_000, ...options });
	signers.push(signer);
	return { home, store: new FileKeystore(path), signer, env, dir };
}

const stateOf = async (store: FileKeystore): Promise<FakeState> => JSON.parse(await readFile(store.path, "utf8"));

async function fault(store: FileKeystore, ...faults: KeystoreFault[]) {
	const state = await stateOf(store).catch(() => ({ items: {}, faults: [], calls: [] }) as FakeState);
	state.faults.push(...faults);
	await writeFile(store.path, JSON.stringify(state));
}

/** A home with the lease and one wallet, made through the child. */
async function withWallet(options: { deadline?: number } = {}) {
	const s = await setup(options);
	const leased = await s.signer.lease(null);
	if (!leased.ok) throw new Error(leased.code);
	const made = await s.signer.create(leased.epoch, async () => {});
	if (!made.ok) throw new Error(made.code);
	const key = (await s.store.read(walletAccount(s.home.id, made.address as Address))) as Key;
	return { ...s, lease: leased.epoch, address: made.address as Address, key };
}

const TRANSFER = {
	chainId: 31337,
	nonce: 0n,
	maxFee: 2_000_000_000n,
	tip: 1_000_000_000n,
	gasLimit: 21_000n,
	to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
	value: 10n ** 15n,
};

const AUTHORIZATION = {
	chainId: 84532,
	token: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address, name: "USDC", version: "2" },
	to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
	value: 10_000n,
	validAfter: 1_700_000_000n,
	validBefore: 1_700_000_100n,
	nonce: `0x${"11".repeat(32)}` as `0x${string}`,
};

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("the lease and the canary", () => {
	it("answers the canary and leaves no item behind", async () => {
		const { signer, store } = await setup();
		expect(await signer.canary()).toEqual({ ok: true });
		expect((await stateOf(store)).items).toEqual({});
	});

	it("leaves a killed call's canary in one of the home's few slots, which the next call on it takes back", async () => {
		const { signer, store, home } = await setup();
		await fault(store, { point: "keychain:write", account: "/canary/", kill: true, times: 1 });
		expect((await signer.canary()).ok).toBe(false);
		const [left] = Object.keys((await stateOf(store)).items);
		const slots = Array.from({ length: CANARY_SLOTS }, (_, slot) => canaryAccount(home.id, slot));
		expect(slots).toContain(left);
		// a call on another slot leaves it; the call on its slot overwrites it and removes it
		await canary(store, home, () => (slots.indexOf(left as string) + 1) % CANARY_SLOTS);
		expect(Object.keys((await stateOf(store)).items)).toEqual([left]);
		await canary(store, home, () => slots.indexOf(left as string));
		expect((await stateOf(store)).items).toEqual({});
		// a slot another call holds reads back its value: the call goes on to the next slot
		let held = 0;
		const raced: Keystore = {
			...store,
			read: async (account) => (account === slots[0] ? `taken-${++held}` : store.read(account)),
			write: (account, secret) => store.write(account, secret),
			remove: (account) => store.remove(account),
			find: () => Promise.reject(new Error("a canary never lists the keychain")),
		};
		await canary(raced, home, () => 0);
		expect(held).toBe(1);
		// a keychain that keeps no write is said not to answer, after a few slots
		const forgetful: Keystore = { ...raced, read: async () => null };
		await expect(canary(forgetful, home, () => 0)).rejects.toMatchObject({ code: "no_keychain" });
	});

	it("never lists the keychain for a canary or a missing key, and lists it only at this home's lease, never for a fork (H-009, H-283)", async () => {
		const items = new Map<string, string>([
			[walletAccount("live", addressOf(`0x${"11".repeat(32)}`)), `0x${"11".repeat(32)}`],
			["other/home-secret", JSON.stringify({ secret: "a".repeat(64), binding: "b".repeat(64) })],
			[walletAccount("other", addressOf(`0x${"22".repeat(32)}`)), `0x${"22".repeat(32)}`],
		]);
		const listed: string[] = [];
		class Entry {
			readonly account: string;
			constructor(_service: string, account: string) {
				this.account = account;
			}
			async getPassword() {
				return items.get(this.account) ?? null;
			}
			async setPassword(value: string) {
				items.set(this.account, value);
			}
			async deletePassword() {
				return items.delete(this.account);
			}
		}
		const store = new KeychainStore("banda-test-canary", {
			platform: "darwin",
			load: async () =>
				({
					AsyncEntry: Entry,
					findCredentialsAsync: async (service: string) => {
						listed.push(service);
						return [...items].map(([account, password]) => ({ account, password }));
					},
				}) as never,
		});
		const home = { id: "live", binding: "c".repeat(64) };
		await canary(store, home);
		// a key-missing decision runs the canary: still no listing
		const lease = await claimLease(store, home, null);
		expect(lease).toBe(1);
		expect(await serve({ id: "r-1", op: "derive", home, lease: 1, address: TRANSFER.to }, store)).toEqual({
			id: "r-1",
			ok: false,
			code: "missing",
		});
		expect(listed).toEqual([]);
		// a copy of the home without the lease, and a fork, list nothing
		const copy = { id: "copy", binding: "d".repeat(64) };
		expect(await serve({ id: "r-2", op: "find", home: copy, lease: 1 }, store)).toEqual({
			id: "r-2",
			ok: false,
			code: "other_home",
		});
		expect(await serve({ id: "r-3", op: "find", home: { ...home, fork: true }, lease: 1 }, store)).toEqual({
			id: "r-3",
			ok: false,
			code: "other_home",
		});
		expect(listed).toEqual([]);
		// the home at its lease lists its own wallets, for the owner's orphans alone
		expect(await serve({ id: "r-4", op: "find", home, lease: 1 }, store)).toMatchObject({ ok: true });
		expect(listed).toHaveLength(1);
	});

	it("takes the lease by compare-and-set on its epoch", async () => {
		const { signer } = await setup();
		expect(await signer.lease(null)).toEqual({ ok: true, epoch: 1 });
		expect(await signer.lease(null)).toEqual({ ok: false, code: "other_home" });
		expect(await signer.lease(3)).toEqual({ ok: false, code: "other_home" });
		expect(await signer.lease(1)).toEqual({ ok: true, epoch: 2 });
	});

	it("says the keychain's epoch and whether it is this home's, so a move killed before its store commit finishes (H-289)", async () => {
		const { signer, home, env, lease, address } = await withWallet();
		expect(await signer.leased()).toEqual({ ok: true, lease: { epoch: lease, mine: true } });
		const moved = new HostSigner({ id: home.id, binding: randomBytes(32).toString("hex") }, { env });
		signers.push(moved);
		// the move reaches the keychain, and its store commit never runs: the store still holds `lease`
		expect(await moved.move(lease, [address])).toEqual({ ok: true, epoch: lease + 1 });
		expect(await moved.move(lease, [address])).toEqual({ ok: false, code: "other_home" });
		expect(await moved.derive(lease, address)).toEqual({ ok: false, code: "other_home" });
		expect(await moved.leased()).toEqual({ ok: true, lease: { epoch: lease + 1, mine: true } });
		expect(await moved.derive(lease + 1, address)).toEqual({ ok: true, address });
		expect(await signer.leased()).toEqual({ ok: true, lease: { epoch: lease + 1, mine: false } });
		const fresh = await setup();
		expect(await fresh.signer.leased()).toEqual({ ok: true, lease: null });
	});

	it("never gives a fork the lease, so it never makes, restores or signs (H-283)", async () => {
		const { home, env, store } = await setup();
		const fork = new HostSigner({ ...home, fork: true }, { env });
		signers.push(fork);
		expect(await fork.lease(null)).toEqual({ ok: false, code: "other_home" });
		expect(await fork.create(1, async () => {})).toEqual({ ok: false, code: "other_home" });
		expect(await fork.restore(1, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address, generateKey())).toEqual({
			ok: false,
			code: "other_home",
		});
		expect(Object.keys((await stateOf(store)).items)).toEqual([]);
		expect(await fork.move(1, [])).toEqual({ ok: false, code: "other_home" });
	});

	it("is moved by the host to a home whose binding is not the secret's, and the old home loses it (UC-21)", async () => {
		const { signer, home, env, lease, address } = await withWallet();
		const moved = new HostSigner({ id: home.id, binding: randomBytes(32).toString("hex") }, { env });
		signers.push(moved);
		expect(await moved.lease(lease)).toEqual({ ok: false, code: "other_home" });
		expect(await moved.move(lease + 1, [address])).toEqual({ ok: false, code: "other_home" });
		expect(await moved.move(lease, [address])).toEqual({ ok: true, epoch: lease + 1 });
		expect(await moved.leased()).toEqual({ ok: true, lease: { epoch: lease + 1, mine: true } });
		expect(await moved.derive(lease + 1, address)).toEqual({ ok: true, address });
		expect(await signer.leased()).toEqual({ ok: true, lease: { epoch: lease + 1, mine: false } });
		expect(await signer.derive(lease + 1, address)).toEqual({ ok: false, code: "other_home" });
		expect(await signer.lease(lease + 1)).toEqual({ ok: false, code: "other_home" });
	});

	it("proves each key before a move writes, so a key that fails leaves the home holding the lease online (UC-21)", async () => {
		const { signer, store, home, env, lease, address } = await withWallet();
		const moved = new HostSigner({ id: home.id, binding: randomBytes(32).toString("hex") }, { env });
		signers.push(moved);
		const before = (await stateOf(store)).items;
		const other = addressOf(generateKey());
		expect(await moved.move(lease, [address, other])).toEqual({ ok: false, code: "missing" });
		await store.write(walletAccount(home.id, other), generateKey());
		const planted = (await stateOf(store)).items;
		expect(await moved.move(lease, [address, other])).toEqual({ ok: false, code: "wrong_key" });
		expect((await stateOf(store)).items).toEqual(planted);
		await store.remove(walletAccount(home.id, other));
		expect((await stateOf(store)).items).toEqual(before);
		expect(await signer.leased()).toEqual({ ok: true, lease: { epoch: lease, mine: true } });
		expect(await signer.derive(lease, address)).toEqual({ ok: true, address });
	});

	it("leaves both homes offline when stopped between its two writes, and a rerun or the new home's claim completes it", async () => {
		for (const stopped of [
			{ point: "keychain:write", account: "/lease", throw: "User canceled the operation.", times: 1 },
			{ point: "keychain:write", account: "/home-secret", kill: true, times: 1 },
		] satisfies KeystoreFault[]) {
			for (const recover of ["move", "claim"] as const) {
				const { signer, store, home, env, lease, address } = await withWallet();
				const moved = new HostSigner({ id: home.id, binding: randomBytes(32).toString("hex") }, { env });
				signers.push(moved);
				await fault(store, stopped);
				expect((await moved.move(lease, [address])).ok).toBe(false);
				expect(await signer.leased()).toEqual({ ok: true, lease: { epoch: lease, mine: false } });
				expect(await moved.leased()).toEqual({ ok: true, lease: { epoch: lease, mine: false } });
				expect(await signer.derive(lease, address)).toEqual({ ok: false, code: "other_home" });
				expect(await moved.derive(lease, address)).toEqual({ ok: false, code: "other_home" });
				expect(await signer.lease(lease)).toEqual({ ok: false, code: "other_home" });
				const done = recover === "move" ? await moved.move(lease, [address]) : await moved.lease(lease);
				expect(done).toEqual({ ok: true, epoch: lease + 1 });
				expect(await moved.leased()).toEqual({ ok: true, lease: { epoch: lease + 1, mine: true } });
				expect(await moved.derive(lease + 1, address)).toEqual({ ok: true, address });
				expect(await signer.leased()).toEqual({ ok: true, lease: { epoch: lease + 1, mine: false } });
			}
		}
	});
});

describe("create", () => {
	it("names the address before anything is written, then writes, reads back and proves it (C15)", async () => {
		const { signer, store, home } = await setup();
		const leased = await signer.lease(null);
		if (!leased.ok) throw new Error(leased.code);
		let seen: Address | undefined;
		const made = await signer.create(leased.epoch, async (address) => {
			seen = address;
			expect(await store.read(walletAccount(home.id, address))).toBeNull();
		});
		expect(made).toEqual({ ok: true, address: seen });
		const key = await store.read(walletAccount(home.id, seen as Address));
		expect(addressOf(key as Key)).toBe(seen);
		expect(await signer.derive(leased.epoch, seen as Address)).toEqual({ ok: true, address: seen });
	});

	it("writes nothing when the creating commit fails", async () => {
		const { signer, store } = await setup();
		const leased = await signer.lease(null);
		if (!leased.ok) throw new Error(leased.code);
		const made = await signer.create(leased.epoch, async () => {
			throw new Error("the commit failed");
		});
		expect(made).toEqual({ ok: false, code: "other" });
		expect(Object.keys((await stateOf(store)).items).filter((a) => a.includes("/wallet/"))).toEqual([]);
	});

	it("never overwrites an item it finds where the key was to go (H-024)", async () => {
		const { signer, store, home } = await setup();
		const leased = await signer.lease(null);
		if (!leased.ok) throw new Error(leased.code);
		const made = await signer.create(leased.epoch, async (address) => {
			await store.write(walletAccount(home.id, address), "planted");
		});
		expect(made).toEqual({ ok: false, code: "exists" });
		const items = (await stateOf(store)).items;
		expect(Object.values(items)).toContain("planted");
	});

	it("fails when the read-back differs from what was written (H-006)", async () => {
		const { signer, store } = await setup();
		const leased = await signer.lease(null);
		if (!leased.ok) throw new Error(leased.code);
		const made = await signer.create(leased.epoch, () =>
			fault(
				store,
				{ point: "keychain:read", account: "/wallet/", answer: null, times: 1 },
				{ point: "keychain:read", account: "/wallet/", answer: generateKey(), times: 1 },
			),
		);
		expect(made).toMatchObject({ ok: false, code: "other", why: "the keychain did not keep the key" });
	});

	it("is refused to a home without the lease, before a key is drawn", async () => {
		const { signer } = await setup();
		let drawn = false;
		expect(
			await signer.create(1, async () => {
				drawn = true;
			}),
		).toEqual({ ok: false, code: "other_home" });
		expect(drawn).toBe(false);
	});
});

describe("proving and signing", () => {
	it("signs a transfer and an authorization as the signing module does, after proving the key", async () => {
		const { signer, lease, address, key } = await withWallet();
		expect(await signer.transfer(lease, address, TRANSFER)).toEqual({
			ok: true,
			...signTransfer({ key, ...TRANSFER }),
		});
		expect(await signer.authorization(lease, address, AUTHORIZATION)).toEqual({
			ok: true,
			...signTransferWithAuthorization({ key, ...AUTHORIZATION }),
		});
		const token = await signer.transfer(lease, address, {
			...TRANSFER,
			gasLimit: 80_000n,
			token: AUTHORIZATION.token.address,
		});
		expect(token).toEqual({
			ok: true,
			...signTransfer({ key, ...TRANSFER, gasLimit: 80_000n, token: AUTHORIZATION.token.address }),
		});
	});

	it("passes on the signing module's refusal as refused, in its fixed words", async () => {
		const { signer, lease, address } = await withWallet();
		expect(await signer.transfer(lease, address, { ...TRANSFER, gasLimit: 20_000n })).toEqual({
			ok: false,
			code: "refused",
			why: "cannot sign: the gas limit is below a transfer's",
		});
	});

	it("is wrong_key when the item holds another key, and signs nothing (H-025)", async () => {
		const { signer, store, home, lease, address } = await withWallet();
		await store.write(walletAccount(home.id, address), generateKey());
		expect(await signer.derive(lease, address)).toEqual({ ok: false, code: "wrong_key" });
		expect(await signer.transfer(lease, address, TRANSFER)).toEqual({ ok: false, code: "wrong_key" });
		await store.write(walletAccount(home.id, address), "not a key");
		expect(await signer.derive(lease, address)).toEqual({ ok: false, code: "wrong_key" });
	});

	it("takes a key only in [1, n - 1] and of 32 bytes, from the keychain and from a restore (H-003)", async () => {
		const { signer, store, home, lease, address, key } = await withWallet();
		const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
		const bad = [`0x${"00".repeat(32)}`, `0x${n.toString(16)}`, `0x${"ab".repeat(31)}`];
		for (const each of bad) {
			await store.write(walletAccount(home.id, address), each);
			expect(await signer.derive(lease, address), each).toEqual({ ok: false, code: "wrong_key" });
			expect(await signer.transfer(lease, address, TRANSFER), each).toEqual({ ok: false, code: "wrong_key" });
		}
		expect(await signer.remove(lease, address)).toEqual({ ok: false, code: "wrong_key" });
		await store.remove(walletAccount(home.id, address));
		// a key of 0 or n is not the wallet's; 31 bytes is not a request the child takes (the paste refuses it before)
		for (const [each, code] of bad.map((each, i) => [each, i < 2 ? "wrong_key" : "other"] as const)) {
			expect(await signer.restore(lease, address, each as Key), each).toEqual({ ok: false, code });
			expect(await store.read(walletAccount(home.id, address))).toBeNull();
		}
		expect(await signer.restore(lease, address, key)).toEqual({ ok: true, address });
		// n - 1, the last key there is, is a key like any other
		const last = `0x${(n - 1n).toString(16)}` as Key;
		const lastAddress = addressOf(last);
		await store.write(walletAccount(home.id, lastAddress), last);
		expect(await signer.derive(lease, lastAddress)).toEqual({ ok: true, address: lastAddress });
		expect((await signer.transfer(lease, lastAddress, TRANSFER)).ok).toBe(true);
	});

	it("is missing only when the canary shows the keychain answers (H-037)", async () => {
		const { signer, store, home, lease, address } = await withWallet();
		await store.remove(walletAccount(home.id, address));
		expect(await signer.derive(lease, address)).toEqual({ ok: false, code: "missing" });
		await fault(store, {
			point: "keychain:write",
			throw: "Couldn't access platform storage: Secret Service: no result found",
		});
		expect(await signer.derive(lease, address)).toEqual({ ok: false, code: "no_keychain" });
	});

	it("keeps two canaries of one home apart, whatever order their calls interleave in", async () => {
		// two processes on one home (a copy, the desktop's signer beside the daemon's): each canary's write, read and
		// removal run between the other's
		const items = new Map<string, string>();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		const keystore: Keystore = {
			read: async (account) => items.get(account) ?? null,
			write: async (account, secret) => {
				items.set(account, secret);
				if (first) {
					first = false;
					await held;
				}
			},
			remove: async (account) => items.delete(account),
			find: async (prefix) => [...items.keys()].filter((account) => account.startsWith(prefix)),
		};
		const home = { id: "h-shared", binding: "0".repeat(64) };
		const slow = canary(keystore, home);
		await until(async () => (items.size === 1 ? true : undefined));
		await canary(keystore, home);
		release();
		await slow;
		expect([...items.keys()]).toEqual([]);
	});

	it("names the keychain's state when it cannot read", async () => {
		const { signer, store, lease, address } = await withWallet();
		await fault(store, {
			point: "keychain:read",
			account: "/wallet/",
			throw: "Couldn't access platform storage: Secret Service: unlock prompt was dismissed",
			times: 1,
		});
		expect(await signer.derive(lease, address)).toEqual({ ok: false, code: "locked" });
		await fault(store, {
			point: "keychain:read",
			account: "/wallet/",
			throw: "Platform failure: User canceled the operation.",
			times: 1,
		});
		expect(await signer.transfer(lease, address, TRANSFER)).toEqual({ ok: false, code: "denied" });
		await fault(store, {
			point: "keychain:read",
			account: "/wallet/",
			throw: "Entry is matched by 2 credentials",
			times: 1,
		});
		expect(await signer.derive(lease, address)).toEqual({ ok: false, code: "ambiguous" });
		expect(await signer.derive(lease, address)).toEqual({ ok: true, address });
	});

	it("is other_home at a stale epoch, or for a copy of the home elsewhere, which never reads a key (C16, H-020, H-283)", async () => {
		const { signer, store, home, env, lease, address } = await withWallet();
		const claimed = await signer.lease(lease);
		expect(claimed).toEqual({ ok: true, epoch: lease + 1 });
		expect(await signer.derive(lease, address)).toEqual({ ok: false, code: "other_home" });
		expect(await signer.derive(lease + 1, address)).toEqual({ ok: true, address });
		const copy = new Signer({ id: home.id, binding: randomBytes(32).toString("hex") }, { env });
		signers.push(copy);
		const before = (await stateOf(store)).calls.length;
		expect(await copy.derive(lease + 1, address)).toEqual({ ok: false, code: "other_home" });
		expect(await copy.transfer(lease + 1, address, TRANSFER)).toEqual({ ok: false, code: "other_home" });
		expect(await copy.authorization(lease + 1, address, AUTHORIZATION)).toEqual({ ok: false, code: "other_home" });
		expect(await copy.lease(lease + 1)).toEqual({ ok: false, code: "other_home" });
		expect(await copy.remove(lease + 1, address)).toEqual({ ok: false, code: "other_home" });
		const calls = (await stateOf(store)).calls.slice(before);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.filter((call) => call.account.includes("/wallet/"))).toEqual([]);
	});

	it("lists the home's wallets, removes one, and restores only a key that derives its address (H-014)", async () => {
		const { signer, lease, address, key } = await withWallet();
		expect(await signer.find(lease)).toEqual({ ok: true, addresses: [address] });
		expect(await signer.find(lease + 1)).toEqual({ ok: false, code: "other_home" });
		expect(await signer.restore(lease, address, key)).toEqual({ ok: false, code: "exists" });
		expect(await signer.remove(lease, address)).toEqual({ ok: true, removed: true });
		expect(await signer.remove(lease, address)).toEqual({ ok: false, code: "missing" });
		expect(await signer.find(lease)).toEqual({ ok: true, addresses: [] });
		expect(await signer.restore(lease, address, generateKey())).toEqual({ ok: false, code: "wrong_key" });
		expect(await signer.restore(lease, address, key)).toEqual({ ok: true, address });
		expect(await signer.derive(lease, address)).toEqual({ ok: true, address });
	});

	it("removes only an item that derives the wallet's address: another key under its account is kept (H-045)", async () => {
		const { signer, store, home, lease, address } = await withWallet();
		const account = walletAccount(home.id, address);
		const other = generateKey();
		await store.write(account, other);
		expect(await signer.remove(lease, address)).toEqual({ ok: false, code: "wrong_key" });
		expect(await store.read(account)).toBe(other);
		await store.write(account, "not a key");
		expect(await signer.remove(lease, address)).toEqual({ ok: false, code: "wrong_key" });
		expect(await store.read(account)).toBe("not a key");
	});

	it("never says the key in an answer (H-010)", async () => {
		const { signer, store, home, lease, address, key } = await withWallet();
		const outcomes: unknown[] = [
			await signer.derive(lease, address),
			await signer.transfer(lease, address, TRANSFER),
			await signer.transfer(lease, address, { ...TRANSFER, gasLimit: 1n }),
			await signer.authorization(lease, address, AUTHORIZATION),
			await signer.authorization(lease, address, { ...AUTHORIZATION, validBefore: AUTHORIZATION.validAfter }),
			await signer.restore(lease, address, key),
			await signer.find(lease),
		];
		await store.write(walletAccount(home.id, address), generateKey());
		outcomes.push(await signer.derive(lease, address));
		const said = JSON.stringify(outcomes).toLowerCase();
		expect(said).not.toContain(key.slice(2).toLowerCase());
		expect(said).not.toContain(Buffer.from(key.slice(2), "hex").toString("base64").toLowerCase());
	});
});

describe("the deadline", () => {
	it("kills a call blocked on the keychain at its deadline (H-018, H-032)", async () => {
		const { signer, store, lease, address } = await withWallet({ deadline: 700 });
		await fault(store, { point: "keychain:read", account: "/wallet/", hang: true, times: 1 });
		// the read hangs for good, so an answer at all is the deadline's
		expect(await signer.derive(lease, address)).toEqual({ ok: false, code: "timeout" });
		const hung = (await stateOf(store)).calls.filter((call) => call.account.includes("/wallet/")).at(-1);
		expect(hung).toBeDefined();
		expect(hung?.end).toBeUndefined();
		await until(() => !alive(hung?.pid as number));
		expect(await signer.derive(lease, address)).toEqual({ ok: true, address });
	});

	it("drops an answer that comes after the deadline, and the next call gets its own (H-035)", async () => {
		// a transfer reads three items (the lease, the home secret, the key): one answer's time each, 2.1 s in all
		const { signer, store, lease, address } = await withWallet({ deadline: 700 });
		await fault(store, { point: "keychain:read", account: "/wallet/", delay: 2_500, times: 1 });
		expect(await signer.transfer(lease, address, TRANSFER)).toEqual({ ok: false, code: "timeout" });
		expect(await signer.derive(lease, address)).toEqual({ ok: true, address });
	});

	it("gives a move one answer's time for each item it reads, so many wallets whose items each prompt still move (H-017)", async () => {
		const s = await setup({ deadline: 1_500 });
		const leased = await s.signer.lease(null);
		if (!leased.ok) throw new Error(leased.code);
		const addresses: Address[] = [];
		for (let n = 0; n < 3; n++) {
			const made = await s.signer.create(leased.epoch, async () => {});
			if (!made.ok) throw new Error(made.code);
			addresses.push(made.address as Address);
		}
		// after an update every item asks the owner again: each wallet's read waits nearly a whole deadline
		await fault(s.store, { point: "keychain:read", account: "/wallet/", delay: 1_200, times: 3 });
		const moved = new HostSigner(
			{ id: s.home.id, binding: randomBytes(32).toString("hex") },
			{ env: s.env, deadline: 1_500 },
		);
		signers.push(moved);
		expect(await moved.move(leased.epoch, addresses)).toEqual({ ok: true, epoch: leased.epoch + 1 });
		// a call still has only one answer's time for each item it reads
		await fault(s.store, { point: "keychain:read", account: "/wallet/", delay: 5_000, times: 1 });
		expect(await moved.derive(leased.epoch + 1, addresses[0] as Address)).toEqual({ ok: false, code: "timeout" });
	});

	it("gives every op one answer's time for the lease, the home secret and the key it reads, each of which may prompt (H-017)", async () => {
		const { signer, store, lease, address } = await withWallet({ deadline: 1_500 });
		// after an update the lease and the home secret prompt too, before the key does: each nearly a whole deadline
		const prompts = (times: number, ...accounts: string[]) =>
			fault(store, ...accounts.map((account) => ({ point: "keychain:read" as const, account, delay: 1_200, times })));
		await prompts(1, "/lease", "/home-secret", "/wallet/");
		expect(await signer.derive(lease, address)).toEqual({ ok: true, address });
		await prompts(1, "/lease", "/home-secret", "/wallet/");
		expect((await signer.export(lease, address)).ok).toBe(true);
		await prompts(1, "/lease", "/home-secret");
		expect((await signer.create(lease, async () => {})).ok).toBe(true);
	});

	it("answers with a fixed code when the child cannot start, and the home's next call still runs", async () => {
		const { home, env, signer } = await setup();
		const big = new Signer(home, { env: { ...env, BANDA_TEST_PAD: "a".repeat(4_000_000) } });
		signers.push(big);
		expect(await big.canary()).toEqual({ ok: false, code: "other" });
		const unnamed = new Signer(home, { env, script: "signer\0.mjs" });
		signers.push(unnamed);
		expect(await unnamed.canary()).toEqual({ ok: false, code: "other" });
		expect(await signer.canary()).toEqual({ ok: true });
	});

	it("starts the child unable to open an inspector on SIGUSR1 (H-012)", async () => {
		const { dir, home, env } = await setup();
		const flags = join(dir, "flags.mjs");
		await writeFile(
			flags,
			[
				'import { createInterface } from "node:readline";',
				"createInterface({ input: process.stdin }).once('line', (line) => {",
				"  const { id } = JSON.parse(line);",
				"  const why = JSON.stringify(process.execArgv);",
				"  process.stdout.write(JSON.stringify({ id, ok: false, code: 'locked', why }) + '\\n');",
				"});",
			].join("\n"),
		);
		const reporting = new Signer(home, { env, script: flags });
		signers.push(reporting);
		const answer = await reporting.canary();
		expect(answer).toMatchObject({ ok: false, code: "locked" });
		expect(JSON.parse((answer as { why: string }).why)).toEqual([...CHILD_FLAGS]);
		expect(CHILD_FLAGS).toContain("--disable-sigusr1");
	});

	it("never starts Electron's binary as the child: under Electron it runs the node it is given, or none (C20)", async () => {
		expect(signerNode(undefined, { ...process.versions, electron: "39.0.0" }, "/Applications/Banda.app/x")).toBe(
			undefined,
		);
		expect(signerNode("/bundled/node", { ...process.versions, electron: "39.0.0" }, "/x")).toBe("/bundled/node");
		expect(signerNode(undefined, process.versions, "/usr/bin/node")).toBe("/usr/bin/node");
		const { dir, home, env } = await setup();
		const where = join(dir, "where.mjs");
		await writeFile(
			where,
			[
				'import { createInterface } from "node:readline";',
				"createInterface({ input: process.stdin }).once('line', (line) => {",
				"  const { id } = JSON.parse(line);",
				"  const why = JSON.stringify([process.execPath, process.env.NODE_OPTIONS ?? null]);",
				"  process.stdout.write(JSON.stringify({ id, ok: false, code: 'locked', why }) + '\\n');",
				"});",
			].join("\n"),
		);
		const descriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
		Object.defineProperty(process.versions, "electron", { value: "39.0.0", configurable: true, enumerable: true });
		try {
			const bare = new Signer(home, { env, script: where });
			signers.push(bare);
			expect(await bare.canary()).toEqual({ ok: false, code: "other" });
			const given = new Signer(home, {
				env: { ...env, NODE_OPTIONS: "--no-warnings" },
				script: where,
				node: process.execPath,
			});
			signers.push(given);
			const answer = await given.canary();
			expect(answer).toMatchObject({ ok: false, code: "locked" });
			expect(JSON.parse((answer as { why: string }).why)).toEqual([process.execPath, null]);
		} finally {
			if (descriptor === undefined) Reflect.deleteProperty(process.versions, "electron");
			else Object.defineProperty(process.versions, "electron", descriptor);
		}
	});

	it("ignores a line that names another request, and treats a child that dies as not done (H-033)", async () => {
		const { dir, home, env } = await setup();
		const stray = join(dir, "stray.mjs");
		await writeFile(
			stray,
			[
				'import { createInterface } from "node:readline";',
				"const lines = createInterface({ input: process.stdin });",
				"lines.once('line', (line) => {",
				"  const { id } = JSON.parse(line);",
				`  process.stdout.write(JSON.stringify({ id: "${"0".repeat(32)}", ok: true, result: {} }) + "\\n");`,
				"  process.stdout.write('not json\\n');",
				"  process.stdout.write(JSON.stringify({ id, ok: false, code: 'locked' }) + '\\n');",
				"  process.exit(0);",
				"});",
			].join("\n"),
		);
		const strayed = new Signer(home, { env, script: stray });
		signers.push(strayed);
		expect(await strayed.canary()).toEqual({ ok: false, code: "locked" });
		const dies = join(dir, "dies.mjs");
		await writeFile(dies, "process.exit(1);\n");
		const dying = new Signer(home, { env, script: dies });
		signers.push(dying);
		expect(await dying.canary()).toEqual({ ok: false, code: "other" });
		const forged = join(dir, "forged.mjs");
		await writeFile(
			forged,
			[
				'import { createInterface } from "node:readline";',
				"createInterface({ input: process.stdin }).once('line', (line) => {",
				"  const { id } = JSON.parse(line);",
				"  process.stdout.write(JSON.stringify({ id, ok: true, result: { address: 'nope' } }) + '\\n');",
				"});",
			].join("\n"),
		);
		const forging = new Signer(home, { env, script: forged });
		signers.push(forging);
		expect(await forging.derive(1, TRANSFER.to)).toEqual({ ok: false, code: "other" });
	});

	it("holds a call in process to the wire's schema as the child is: what the child refuses fails in both", async () => {
		const { home, env } = await setup();
		const child = new HostSigner(home, { env });
		const inProcess = new HostSigner(
			{ id: `h-${randomBytes(4).toString("hex")}`, binding: home.binding },
			{ env: { ...env, BANDA_TEST_KEYSTORE: "1" } },
		);
		signers.push(child, inProcess);
		// an epoch of 0 is no epoch the wire carries: the child exits without an answer, and in process it fails the same
		expect(await child.move(0, [])).toEqual({ ok: false, code: "other" });
		expect(await inProcess.move(0, [])).toEqual({ ok: false, code: "other" });
		// none held anywhere is null, which both take
		expect(await child.move(null, [])).toEqual({ ok: true, epoch: 1 });
		expect(await inProcess.move(null, [])).toEqual({ ok: true, epoch: 1 });
		memoryKeystore().state = { items: {}, faults: [], calls: [] };
	});

	it("stop kills a call in flight and refuses later ones (H-034)", async () => {
		const { signer, store, lease, address } = await withWallet({ deadline: 30_000 });
		await fault(store, { point: "keychain:read", account: "/wallet/", hang: true, times: 1 });
		const pending = signer.derive(lease, address);
		await until(async () => (await stateOf(store)).calls.some((c) => c.account.includes("/wallet/") && !c.end));
		signer.stop();
		expect(await pending).toEqual({ ok: false, code: "other" });
		expect(await signer.canary()).toEqual({ ok: false, code: "other" });
	});
});

describe("one call per home at a time", () => {
	it("runs a home's calls one after another, across signers of that home (H-036)", async () => {
		const { signer, store, home, env, lease, address } = await withWallet();
		await fault(store, { point: "keychain:read", account: "/wallet/", delay: 300, times: 3 });
		const other = new Signer(home, { env });
		signers.push(other);
		const before = (await stateOf(store)).calls.length;
		const results = await Promise.all([
			signer.derive(lease, address),
			other.derive(lease, address),
			signer.transfer(lease, address, TRANSFER),
		]);
		for (const result of results) expect(result.ok).toBe(true);
		const calls = (await stateOf(store)).calls.slice(before);
		const spans = [...new Set(calls.map((c) => c.pid))].map((pid) => {
			const mine = calls.filter((c) => c.pid === pid);
			return { start: Math.min(...mine.map((c) => c.start)), end: Math.max(...mine.map((c) => c.end ?? c.start)) };
		});
		expect(spans).toHaveLength(3);
		spans.sort((a, b) => a.start - b.start);
		for (let i = 1; i < spans.length; i++) expect(spans[i]?.start).toBeGreaterThanOrEqual(spans[i - 1]?.end ?? 0);
	});
});

describe("the daemon's memory (C20)", () => {
	it("holds no key after a creation and a signature made through a child", { timeout: 60_000 }, async () => {
		const { home, signer, store } = await setup();
		const leased = await signer.lease(null);
		if (!leased.ok) throw new Error(leased.code);
		const made = await signer.create(leased.epoch, async () => {});
		if (!made.ok) throw new Error(made.code);
		expect((await signer.transfer(leased.epoch, made.address as Address, TRANSFER)).ok).toBe(true);
		// the snapshot is taken before this process ever reads the key, which it then looks for
		const snapshot = join(await mkdtemp(join(tmpdir(), "banda-heap-")), "daemon.heapsnapshot");
		dirs.push(dirname(snapshot));
		writeHeapSnapshot(snapshot);
		const key = (await store.read(walletAccount(home.id, made.address as Address))) as string;
		const bare = key.slice(2);
		const forms = [bare, bare.toUpperCase(), Buffer.from(bare, "hex").toString("base64")];
		const held = await readFile(snapshot);
		for (const form of forms)
			expect(held.includes(form), `the heap holds the key as ${form.length} characters`).toBe(false);
		// M1's positive control: a snapshot taken while this process holds every form finds each one, so the search
		// above can match at all. A snapshot carries no buffer's bytes, so the key is searched for as text only.
		const control = join(dirname(snapshot), "control.heapsnapshot");
		writeHeapSnapshot(control);
		const found = await readFile(control);
		for (const form of forms)
			expect(found.includes(form), `the control finds the key as ${form.length} characters`).toBe(true);
	});
});

describe("a child whose parent is gone (H-036 across processes)", () => {
	it("starts no write once the process that asked has gone, so a later daemon's child never races it", async () => {
		const { home, store, env } = await setup();
		// the lease read stalls, as a keychain prompt would; the parent goes meanwhile
		await fault(store, { point: "keychain:read", account: "/lease", delay: 600, times: 1 });
		const child = spawn(signerNode(undefined) as string, [...CHILD_FLAGS, SIGNER], {
			stdio: ["pipe", "pipe", "ignore"],
			env: { ...env, NODE_OPTIONS: "" },
		});
		let said = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			said += chunk.toString();
		});
		const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
		const id = randomBytes(16).toString("hex");
		child.stdin?.write(`${JSON.stringify({ id, op: "lease", home, expected: null })}\n`);
		// what a parent's end looks like to its child: its stdin ends
		await until(async () => ((await stateOf(store)).calls.some((call) => call.op === "read") ? true : undefined));
		child.stdin?.end();
		expect(await exited).toBe(0);
		expect(JSON.parse(said.trim())).toEqual({ id, ok: false, code: "other", why: "the process that asked is gone" });
		const state = await stateOf(store);
		expect(Object.keys(state.items).filter((account) => account.startsWith(home.id))).toEqual([]);
		expect(state.calls.filter((call) => call.op === "write")).toEqual([]);
		// a parent still there is answered as ever
		expect(await new Signer(home, { env }).lease(null)).toEqual({ ok: true, epoch: 1 });
	});
});

describe("a killed call", () => {
	it("holds the home's line until its child has exited, so the next child never starts beside it (H-036)", async () => {
		const { signer, store, lease, address } = await withWallet({ deadline: 700 });
		await fault(store, { point: "keychain:read", account: "/wallet/", hang: true, times: 1 });
		const children: ChildProcess[] = [];
		const othersGone: boolean[] = [];
		const watch = (message: unknown) => {
			othersGone.push(children.every((child) => child.exitCode !== null || child.signalCode !== null));
			children.push((message as { process: ChildProcess }).process);
		};
		subscribe("child_process", watch);
		try {
			const [hung, next] = await Promise.all([signer.derive(lease, address), signer.derive(lease, address)]);
			expect(hung).toEqual({ ok: false, code: "timeout" });
			expect(next).toEqual({ ok: true, address });
		} finally {
			unsubscribe("child_process", watch);
		}
		expect(children).toHaveLength(2);
		expect(children[0]?.signalCode).toBe("SIGKILL");
		expect(othersGone).toEqual([true, true]);
	});
});

describe("inspector and heap-dump flags (C20, H-012)", () => {
	it("are found on the command line, in NODE_OPTIONS and as an open inspector", () => {
		expect(debugging([], undefined, undefined)).toBe(false);
		expect(debugging(["--conditions=x", "--max-old-space-size=4096"], "--enable-source-maps", undefined)).toBe(false);
		for (const flag of [
			"--inspect",
			"--inspect=0",
			"--inspect-brk",
			"--inspect-wait=9229",
			"--inspect-port=0",
			"--heapsnapshot-signal=SIGUSR2",
			"--heapsnapshot-near-heap-limit=3",
			"--heap-prof",
			"--heapsnapshot_signal=SIGUSR2",
			"--heap_prof",
			"--inspect_brk",
			"--heapsnapshot_near_heap_limit=3",
		]) {
			expect(debugging([flag], undefined, undefined)).toBe(true);
			expect(debugging([], `--enable-source-maps ${flag}`, undefined)).toBe(true);
		}
		expect(debugging([], undefined, "ws://127.0.0.1:9229/x")).toBe(true);
	});

	it("are found in NODE_OPTIONS however Node's quoting spells them", () => {
		for (const options of [
			'"--heapsnapshot-signal=SIGUSR2"',
			'"--inspect"',
			'--enable-source-maps "--inspect=0"',
			'--"inspect"',
			'"--heap"_prof',
			'"--inspect\\-brk"',
			"--enable-source-maps\t--inspect",
		])
			expect(debugging([], options, undefined)).toBe(true);
		expect(debugging([], '"--enable-source-maps" "--max-old-space-size=4096"', undefined)).toBe(false);
	});

	it("make the child refuse whatever it is asked", async () => {
		const { home, env } = await setup();
		const child = spawn(process.execPath, ["--heapsnapshot-signal=SIGUSR2", SIGNER], {
			env,
			stdio: ["pipe", "pipe", "ignore"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		const id = "a".repeat(32);
		child.stdin.write(`${JSON.stringify({ id, op: "canary", home })}\n`);
		await new Promise((resolve) => child.on("close", resolve));
		expect(JSON.parse(out)).toEqual({ id, ok: false, code: "debugging" });
	});

	it("make a daemon's every call refused without starting a child", async () => {
		const { home, env, store } = await setup();
		const client = pathToFileURL(join(process.cwd(), "src/wallet/signer-client.ts")).href;
		const script = `const { Signer } = await import(${JSON.stringify(client)}); const s = new Signer(${JSON.stringify(home)}); process.stdout.write(JSON.stringify(await s.canary()));`;
		for (const [args, options] of [
			[["--heapsnapshot-signal=SIGUSR2"], ""],
			[[], "--heapsnapshot-signal=SIGUSR2"],
			[["--heapsnapshot_signal=SIGUSR2"], ""],
			[[], "--heapsnapshot_signal=SIGUSR2"],
			[["--inspect=127.0.0.1:0"], ""],
			[[], '"--heapsnapshot-signal=SIGUSR2"'],
		] as const) {
			const { stdout } = await promisify(execFile)(process.execPath, [...args, "--input-type=module", "-e", script], {
				env: { ...env, NODE_OPTIONS: options },
			});
			expect(JSON.parse(stdout)).toEqual({ ok: false, code: "debugging" });
		}
		await expect(readFile(store.path)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("in process, on the memory keystore", () => {
	it("does what the child does, and drops an answer that comes after the deadline", async () => {
		const env = { ...process.env, BANDA_TEST_KEYSTORE: "1" };
		const home = { id: `m-${randomBytes(4).toString("hex")}`, binding: randomBytes(32).toString("hex") };
		const signer = new Signer(home, { env, deadline: 500 });
		signers.push(signer);
		const memory = memoryKeystore();
		expect(await claimLease(memory, home, null)).toBe(1);
		const made = await signer.create(1, async () => {});
		if (!made.ok) throw new Error(made.code);
		const address = made.address as Address;
		const key = (await memory.read(walletAccount(home.id, address))) as Key;
		expect(await signer.transfer(1, address, TRANSFER)).toEqual({ ok: true, ...signTransfer({ key, ...TRANSFER }) });
		// a derive reads three items: 1.5 s in all
		memory.state.faults.push({ point: "keychain:read", account: address, delay: 2_000, times: 1 });
		expect(await signer.derive(1, address)).toEqual({ ok: false, code: "timeout" });
		expect(await signer.derive(1, address)).toEqual({ ok: true, address });
	});

	it("makes no effect after a call timed out, and runs the home's next call only once it settled", async () => {
		const env = { ...process.env, BANDA_TEST_KEYSTORE: "1" };
		const home = { id: `m-${randomBytes(4).toString("hex")}`, binding: randomBytes(32).toString("hex") };
		const signer = new Signer(home, { env, deadline: 300 });
		signers.push(signer);
		const memory = memoryKeystore();
		memory.state.faults.push({ point: "keychain:write", account: home.id, delay: 800, times: 1 });
		expect(await signer.lease(null)).toEqual({ ok: false, code: "timeout" });
		expect(await signer.canary()).toEqual({ ok: true });
		const calls = memory.state.calls.filter((call) => call.account.startsWith(home.id));
		const write = calls.findIndex((call) => call.op === "write");
		const canary = calls.findIndex((call) => call.account.includes("/canary/"));
		expect(write).toBeGreaterThanOrEqual(0);
		expect(canary).toBeGreaterThan(write);
		// the home's next call starts only once the delayed write ended
		expect(calls[write]?.end).toBeDefined();
		expect(calls.slice(write + 1, canary + 1).every((call) => call.start >= (calls[write]?.end ?? Infinity))).toBe(
			true,
		);
		expect(Object.keys(memory.state.items).filter((a) => a.startsWith(home.id))).toEqual([]);
		memory.state.faults.push({ point: "keychain:read", account: home.id, hang: true, times: 1 });
		expect(await signer.leased()).toEqual({ ok: false, code: "timeout" });
		expect(await signer.leased()).toEqual({ ok: true, lease: null });
	});

	it("frees the home's line when a creating commit hangs past the deadline, and writes no key", async () => {
		const env = { ...process.env, BANDA_TEST_KEYSTORE: "1" };
		const home = { id: `m-${randomBytes(4).toString("hex")}`, binding: randomBytes(32).toString("hex") };
		const signer = new Signer(home, { env, deadline: 300 });
		signers.push(signer);
		const memory = memoryKeystore();
		expect(await claimLease(memory, home, null)).toBe(1);
		expect(await signer.create(1, () => new Promise<void>(() => {}))).toEqual({ ok: false, code: "timeout" });
		// a line still held would leave this call waiting past the test's own timeout
		expect(await signer.leased()).toEqual({ ok: true, lease: { epoch: 1, mine: true } });
		expect(Object.keys(memory.state.items).filter((a) => a.startsWith(`${home.id}/wallet/`))).toEqual([]);
	});

	it("is other when no key can be made, before it names an address or writes anything (H-002)", async () => {
		const env = { ...process.env, BANDA_TEST_KEYSTORE: "1" };
		const home = { id: `m-${randomBytes(4).toString("hex")}`, binding: randomBytes(32).toString("hex") };
		const signer = new Signer(home, { env });
		signers.push(signer);
		const memory = memoryKeystore();
		expect(await claimLease(memory, home, null)).toBe(1);
		const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
			throw new Error("no entropy");
		});
		let drawn = false;
		try {
			expect(
				await signer.create(1, async () => {
					drawn = true;
				}),
			).toEqual({ ok: false, code: "other", why: "banda could not make a key on this computer" });
		} finally {
			random.mockRestore();
		}
		expect(drawn).toBe(false);
		expect(Object.keys(memory.state.items).filter((a) => a.startsWith(`${home.id}/wallet/`))).toEqual([]);
	});
});

describe("the keychain's fault points", () => {
	it("are hit once each call's effect is stored, and a kill there leaves the effect with no answer", async () => {
		const { signer, store, home } = await setup();
		const hits: string[] = [];
		const local = new FileKeystore(store.path, { hit: (point) => hits.push(point) });
		await local.write("x", "1");
		await local.read("x");
		await local.find("");
		await local.remove("x");
		expect(hits).toEqual(["keychain:write", "keychain:read", "keychain:read", "keychain:delete"]);
		await fault(store, { point: "keychain:write", account: "/lease", kill: true, times: 1 });
		expect(await signer.lease(null)).toEqual({ ok: false, code: "other" });
		expect(await signer.leased()).toEqual({ ok: true, lease: { epoch: 1, mine: true } });
		expect(await signer.lease(null)).toEqual({ ok: false, code: "other_home" });
		expect((await stateOf(store)).items[`${home.id}/lease`]).toBeDefined();
	});
});

describe("the host's ops: the export, the owner's Restore key and the lease's move", () => {
	it("are sent by the host alone: no module of the daemon imports the host's signer, nor has a method for them (C20, OD-2, H-014)", async () => {
		const root = process.cwd();
		const host = join(root, "src", "wallet", "signer-host.ts");
		const IMPORTS = /(?:\bfrom|\bimport\s*\(?)\s*["'`]([^"'`]+)["'`]/g;
		const importers: string[] = [];
		for (const dir of ["src", "scripts"]) {
			for (const entry of await readdir(join(root, dir), { recursive: true, withFileTypes: true })) {
				if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
				const path = join(entry.parentPath, entry.name);
				for (const [, specifier] of (await readFile(path, "utf8")).matchAll(IMPORTS))
					if (/(?:^|\/)signer-host(?:\.[cm]?[jt]s)?$/.test(specifier ?? "")) importers.push(relative(root, path));
			}
		}
		// the desktop app's main process, outside src/, is its one user
		expect(importers.filter((path) => path !== "src/wallet/signer-host.ts")).toEqual([]);
		// what `banda serve` loads before it runs: every static import from the CLI's and the daemon's entries
		const STATIC = /(?:^|\n)\s*(?:import|export)\b[^;"'`]*?(?:\bfrom\s*)?["'`](\.{1,2}\/[^"'`]+)["'`]/g;
		const reached = new Set<string>();
		const pending = [join(root, "src", "cli", "index.ts"), join(root, "src", "daemon.ts")];
		for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
			if (reached.has(file)) continue;
			reached.add(file);
			for (const [, specifier] of (await readFile(file, "utf8")).matchAll(STATIC)) {
				const target = resolve(dirname(file), (specifier ?? "").replace(/\.js$/, ".ts"));
				if (target.startsWith(join(root, "src", "/")) && /\.tsx?$/.test(target)) pending.push(target);
			}
		}
		expect(reached.size).toBeGreaterThan(10);
		expect([...reached].filter((file) => file === host || file.endsWith("/src/cli/wallet.ts"))).toEqual([]);
		// the daemon's signer has no method for an op whose answer or request carries the key, or that moves the lease
		expect(HOST_OPS).toEqual(expect.arrayContaining(["export", "restore", "move"]));
		const methods = Object.getOwnPropertyNames(Signer.prototype);
		expect(methods.filter((name) => (HOST_OPS as readonly string[]).includes(name))).toEqual([]);
		// and the only requests that name one are the host signer's: no other module calls `call({ op: "export" })`
		const NAMED = new RegExp(`\\bop:\\s*["'\`](${HOST_OPS.join("|")})["'\`]`);
		const senders: string[] = [];
		for (const dir of ["src", "scripts", join("desktop", "src")]) {
			for (const entry of await readdir(join(root, dir), { recursive: true, withFileTypes: true })) {
				if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
				const path = join(entry.parentPath, entry.name);
				if (NAMED.test(await readFile(path, "utf8"))) senders.push(relative(root, path));
			}
		}
		expect(senders).toEqual(["src/wallet/signer-host.ts"]);
	});
});
