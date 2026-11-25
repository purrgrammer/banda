/**
 * What the desktop app's main process does for the home's wallets (desktop/src/wallets.ts): its host signer runs the
 * bundled node under Electron, and the owner's reveal, Restore and move of signing each re-authenticate the owner where
 * they move a key or the lease, act at this home's lease alone, and tell the daemon only that they happened. The reveal
 * is behind a click on the daemon's page that a browser test cannot make, so the handler is held here.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLIPBOARD_CLEAR,
	deleteOrphan,
	normalKey as desktopNormalKey,
	exportOrphan,
	type HeldState,
	type HeldWallet,
	type HostSigner,
	hostSigner,
	KEY_PAGE,
	type Load,
	laterReveal,
	moveSigning,
	restoreKey,
	revealKey,
	secretClipboard,
	WALLET_ACTS,
	type WalletDeps,
	walletDeps,
} from "../desktop/src/wallets.ts";
import { installationId } from "../src/home.ts";
import type { Address } from "../src/wallet/address.ts";
import { leaseAccount, signerHome, walletAccount } from "../src/wallet/home-id.ts";
import { normalKey } from "../src/wallet/key-text.ts";
import { type FakeState, FileKeystore } from "../src/wallet/keystore.ts";
import { shortAddress } from "../src/wallet/label.ts";
import { addressOf, type Key } from "../src/wallet/sign.ts";
import { tempHome, until } from "./helpers.ts";

const sources: Load = (name) => import(`../src/wallet/${name}.ts`);
const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const KEY = `0x${"ab".repeat(32)}`;

/** Whether a process with this pid still runs. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	vi.unstubAllEnvs();
});

/** Runs `act` as the main process under Electron: `process.versions.electron` set. */
async function underElectron<T>(act: () => Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
	Object.defineProperty(process.versions, "electron", { value: "39.0.0", configurable: true, enumerable: true });
	try {
		return await act();
	} finally {
		if (descriptor === undefined) Reflect.deleteProperty(process.versions, "electron");
		else Object.defineProperty(process.versions, "electron", descriptor);
	}
}

/** A host signer that answers as given and records what it was asked. */
function fake(answers: Partial<Record<keyof HostSigner, unknown>> = {}) {
	const asked: unknown[][] = [];
	let stopped = 0;
	const signer = {
		leased: async () => (answers.leased ?? { ok: true, lease: { epoch: 3, mine: true } }) as never,
		export: async (...args: unknown[]) => {
			asked.push(["export", ...args]);
			return (answers.export ?? { ok: true, address: ADDRESS, key: KEY }) as never;
		},
		restore: async (...args: unknown[]) => {
			asked.push(["restore", ...args]);
			return (answers.restore ?? { ok: true, address: ADDRESS }) as never;
		},
		move: async (...args: unknown[]) => {
			asked.push(["move", ...args]);
			return (answers.move ?? { ok: true, epoch: 4 }) as never;
		},
		remove: async (...args: unknown[]) => {
			asked.push(["remove", ...args]);
			return (answers.remove ?? { ok: true, removed: true }) as never;
		},
		stop: () => {
			stopped += 1;
		},
	} satisfies HostSigner;
	return { signer, asked, stopped: () => stopped };
}

function deps(
	signer: HostSigner,
	options: {
		reauthenticated?: boolean;
		states?: (HeldState | undefined)[];
		listed?: boolean;
		/** The home's other wallets, as the daemon lists them. */
		others?: HeldWallet[];
	} = {},
) {
	const told: string[] = [];
	const shown: [string, string][] = [];
	const asks: string[] = [];
	const states = [...(options.states ?? [])];
	const made: WalletDeps = {
		signer: async () => signer,
		reauthenticate: async (why) => {
			asks.push(why);
			return options.reauthenticated ?? true;
		},
		reauthenticates: true,
		identityLost: async () => false,
		lease: async () => 3,
		wallets: async () => {
			const state = states.length > 0 ? states.shift() : { state: "ready", signing: { state: "key_missing" } };
			return [...(state === undefined ? [] : [{ address: ADDRESS, ...state }]), ...(options.others ?? [])];
		},
		tell: async (path) => {
			told.push(path);
			return options.listed ?? true;
		},
		show: async (address, key) => {
			shown.push([address, key]);
		},
	};
	return { deps: made, told, shown, asks };
}

describe("the desktop app and the home's wallets", () => {
	it("builds its host signer to run the bundled node, and a Restore through it answers under Electron", async () => {
		const home = await tempHome();
		await installationId(home);
		const keys = join(await tempHome(), "keys.json");
		vi.stubEnv("BANDA_TEST_KEYSTORE", keys);
		const store = new FileKeystore(keys);
		// a wallet made by the home's own signer, whose keychain item is then gone
		const maker = await hostSigner(sources, home, process.execPath);
		let address: Address;
		let key: Key;
		try {
			const leased = await maker.leased();
			expect(leased).toEqual({ ok: true, lease: null });
			const { Signer } = await import("../src/wallet/signer-client.ts");
			const plain = new Signer(await signerHome(home));
			try {
				const claimed = await plain.lease(null);
				if (!claimed.ok) throw new Error(claimed.code);
				const made = await plain.create(claimed.epoch, async () => {});
				if (!made.ok) throw new Error(made.code);
				address = made.address as Address;
			} finally {
				plain.stop();
			}
			const account = walletAccount((await signerHome(home)).id, address);
			key = (await store.read(account)) as Key;
			expect(addressOf(key)).toBe(address);
			expect(await store.remove(account)).toBe(true);
		} finally {
			maker.stop();
		}
		const told: string[] = [];
		let signing = "key_missing";
		const made: WalletDeps = {
			signer: () => hostSigner(sources, home, process.execPath),
			reauthenticate: async () => true,
			reauthenticates: true,
			identityLost: async () => false,
			lease: async () => 1,
			wallets: async () => [{ address, state: "ready", signing: { state: signing } }],
			tell: async (path) => {
				told.push(path);
				return true;
			},
			show: async () => {},
		};
		expect(await underElectron(() => restoreKey(address, `  ${key}  `, made))).toEqual({ ok: true });
		expect(told).toEqual([`/wallets/${address}/check`]);
		expect(await store.read(walletAccount((await signerHome(home)).id, address))).toBe(key);
		signing = "online";
		// the key it shows later is the wallet's, and the daemon hears only that it was shown
		const shown: [string, string][] = [];
		expect(
			await underElectron(() =>
				revealKey(address, {
					...made,
					show: async (at, k) => {
						shown.push([at, k]);
					},
				}),
			),
		).toEqual({ ok: true });
		expect(shown).toHaveLength(1);
		expect(addressOf(shown[0]![1] as Key)).toBe(address);
		expect(shown[0]![0]).toBe(shortAddress(address));
		expect(told).toEqual([`/wallets/${address}/check`, `/wallets/${address}/revealed`]);
		// a key the keychain holds is not restored over
		expect(await underElectron(() => restoreKey(address, key, made))).toEqual({ ok: false, code: "not_missing" });
	});

	it("restores a key on a keychain that lost every banda item, taking the lease back past the store's (H-021, H-286)", async () => {
		const home = await tempHome();
		await installationId(home);
		const keys = join(await tempHome(), "keys.json");
		vi.stubEnv("BANDA_TEST_KEYSTORE", keys);
		const store = new FileKeystore(keys);
		const { Signer } = await import("../src/wallet/signer-client.ts");
		const at = await signerHome(home);
		const plain = new Signer(at);
		let address: Address;
		let epoch: number;
		try {
			const claimed = await plain.lease(null);
			if (!claimed.ok) throw new Error(claimed.code);
			epoch = claimed.epoch;
			const one = await plain.create(claimed.epoch, async () => {});
			if (!one.ok) throw new Error(one.code);
			address = one.address as Address;
		} finally {
			plain.stop();
		}
		const key = (await store.read(walletAccount(at.id, address))) as Key;
		// the keychain reset: the lease, the home secret and the key are all gone
		for (const account of await store.find(`${at.id}/`)) await store.remove(account);
		expect(await store.find(`${at.id}/`)).toEqual([]);
		const told: string[] = [];
		const asked: WalletDeps = {
			signer: () => hostSigner(sources, home, process.execPath),
			reauthenticate: async () => true,
			reauthenticates: true,
			identityLost: async () => false,
			lease: async () => epoch,
			wallets: async () => [{ address, state: "ready", signing: { state: "key_missing" } }],
			tell: async (path) => {
				told.push(path);
				return true;
			},
			show: async () => {},
		};
		// a key that opens another address takes nothing back, nor does a key of 0 or of the curve's order n; 31 bytes are
		// no key's text at all
		const n = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141";
		for (const wrong of [`0x${"cd".repeat(32)}`, `0x${"00".repeat(32)}`, n])
			expect(await underElectron(() => restoreKey(address, wrong, asked)), wrong).toEqual({
				ok: false,
				code: "wrong_key",
			});
		expect(await underElectron(() => restoreKey(address, `0x${key.slice(4)}`, asked))).toEqual({
			ok: false,
			code: "not_a_key",
		});
		expect(await store.find(`${at.id}/`)).toEqual([]);
		expect(await underElectron(() => restoreKey(address, key, asked))).toEqual({ ok: true });
		expect(told).toEqual([`/wallets/${address}/check`]);
		expect(await store.read(walletAccount(at.id, address))).toBe(key);
		const { leaseOf } = await import("../src/wallet/home-id.ts");
		expect(await leaseOf(store, at)).toEqual({ epoch: epoch + 1, mine: true });
	});

	it("moves signing to a home whose keychain holds no lease item, once each kept key is proven", async () => {
		const home = await tempHome();
		await installationId(home);
		const keys = join(await tempHome(), "keys.json");
		vi.stubEnv("BANDA_TEST_KEYSTORE", keys);
		const store = new FileKeystore(keys);
		const at = await signerHome(home);
		const { leaseOf } = await import("../src/wallet/home-id.ts");
		const asked = (wallets: HeldWallet[]): WalletDeps => ({
			signer: () => hostSigner(sources, home, process.execPath),
			reauthenticate: async () => true,
			reauthenticates: true,
			identityLost: async () => false,
			lease: async () => 4,
			wallets: async () => wallets,
			tell: async () => true,
			show: async () => {},
		});
		// a kept wallet whose key is not here: nothing is taken
		expect(await underElectron(() => moveSigning(asked([{ address: ADDRESS, state: "ready" }])))).toEqual({
			ok: false,
			code: "missing",
		});
		expect(await leaseOf(store, at)).toBeNull();
		// no wallet kept: the lease is taken past the store's, for the home to make wallets again
		expect(await underElectron(() => moveSigning(asked([])))).toEqual({ ok: true });
		expect(await leaseOf(store, at)).toEqual({ epoch: 5, mine: true });
	});

	it("moves signing over a home secret a stopped claim left bound elsewhere, where no lease was ever taken (C15, H-287)", async () => {
		const home = await tempHome();
		await installationId(home);
		const keys = join(await tempHome(), "keys.json");
		vi.stubEnv("BANDA_TEST_KEYSTORE", keys);
		const store = new FileKeystore(keys);
		const at = await signerHome(home);
		const { homeSecretAccount, leaseOf } = await import("../src/wallet/home-id.ts");
		// a first claim stopped between its two writes, then the home's binding changed: no lease item, none stored
		await store.write(homeSecretAccount(at.id), JSON.stringify({ secret: "a".repeat(64), binding: "b".repeat(64) }));
		const asked: WalletDeps = {
			signer: () => hostSigner(sources, home, process.execPath),
			reauthenticate: async () => true,
			reauthenticates: true,
			identityLost: async () => false,
			lease: async () => undefined,
			wallets: async () => [],
			tell: async () => true,
			show: async () => {},
		};
		// the real child: the request it is sent is one its schema takes
		expect(await underElectron(() => moveSigning(asked))).toEqual({ ok: true });
		expect(await leaseOf(store, at)).toEqual({ epoch: 1, mine: true });
	});

	it("constructs the host signer with the release's bundled node, and reads and tells the daemon as the owner", async () => {
		const built: { at: unknown; node: string }[] = [];
		const load: Load = async (name) =>
			name === "signer-host"
				? {
						HostSigner: class {
							constructor(at: unknown, options: { node: string }) {
								built.push({ at, node: options.node });
							}
						},
					}
				: { signerHome: async (home: string) => ({ id: `id-of-${home}` }) };
		const asked: { url: string; init: RequestInit }[] = [];
		let attached: { port: number; token: string } | undefined;
		const made = walletDeps({
			release: () => ({ node: "/bundled/node", cli: "/bundled/app/dist/cli/index.js" }),
			home: "/the/home",
			daemon: () => attached,
			show: async () => {},
			load,
			fetch: (async (url: string, init: RequestInit) => {
				asked.push({ url, init });
				if (init.method === "GET")
					return Response.json({
						wallets: [{ address: ADDRESS, state: "archived", signing: { state: "online" } }],
					});
				return new Response("{}", { status: 200 });
			}) as typeof fetch,
		});
		await made.signer();
		expect(built).toEqual([{ at: { id: "id-of-/the/home" }, node: "/bundled/node" }]);
		// no daemon attached: nothing read, and a tell is not taken
		expect(await made.wallets()).toBeUndefined();
		expect(await made.tell(`/wallets/${ADDRESS}/revealed`)).toBe(false);
		expect(asked).toEqual([]);
		attached = { port: 7799, token: "owner-token" };
		expect(await made.wallets()).toEqual([{ address: ADDRESS, state: "archived", signing: { state: "online" } }]);
		expect(await made.tell(`/wallets/${ADDRESS}/revealed`)).toBe(true);
		expect(asked.map(({ url, init }) => [init.method, url])).toEqual([
			["GET", "http://127.0.0.1:7799/api/wallets"],
			["POST", `http://127.0.0.1:7799/api/wallets/${ADDRESS}/revealed`],
		]);
		expect(
			asked.every(({ init }) => (init.headers as Record<string, string>).authorization === "Bearer owner-token"),
		).toBe(true);
		// a computer without re-authentication lets no act on; one with it goes by its answer
		expect(await made.reauthenticate("why")).toBe(false);
		expect(made.reauthenticates).toBe(false);
		const refusing = walletDeps({
			release: () => ({ node: "/n", cli: "/c" }),
			home: "/h",
			daemon: () => undefined,
			show: async () => {},
			authenticate: async () => {
				throw new Error("cancelled");
			},
		});
		expect(await refusing.reauthenticate("why")).toBe(false);
	});

	it("reveals, restores and moves later behind the OS's re-authentication alone, and fails closed without it (OD-2)", async () => {
		expect(laterReveal(true)).toBe("reauthenticated");
		expect(laterReveal(false)).toBe("refused");
		const on = (authenticate?: (why: string) => Promise<void>) =>
			walletDeps({
				release: () => ({ node: "/n", cli: "/c" }),
				home: "/h",
				daemon: () => undefined,
				show: async () => {},
				...(authenticate === undefined ? {} : { authenticate }),
			});
		// a Mac with Touch ID: the main process passes `authenticate` there alone
		expect(on(async () => {}).reauthenticates).toBe(true);
		expect(await on(async () => {}).reauthenticate("why")).toBe(true);
		// Linux, Windows, and a Mac without Touch ID: nothing re-authenticates the owner
		expect(on().reauthenticates).toBe(false);
		expect(await on().reauthenticate("why")).toBe(false);
		// none of the acts asks the daemon, the owner or the keychain, and no key is shown
		const signer = fake();
		const none = deps(signer.signer);
		const closed = { ...none.deps, reauthenticates: false };
		expect(await revealKey(ADDRESS, closed)).toEqual({ ok: false, code: "no_reauthentication" });
		expect(await restoreKey(ADDRESS, `0x${"1".repeat(64)}`, closed)).toEqual({
			ok: false,
			code: "no_reauthentication",
		});
		expect(await moveSigning(closed)).toEqual({ ok: false, code: "no_reauthentication" });
		expect(none.asks).toEqual([]);
		expect(none.shown).toEqual([]);
		expect(none.told).toEqual([]);
		expect(signer.asked).toEqual([]);
	});

	it("reveals a key only once the owner re-authenticated, at this home's lease, and tells the daemon after", async () => {
		const denied = fake();
		const refused = deps(denied.signer, { reauthenticated: false });
		expect(await revealKey(ADDRESS, refused.deps)).toEqual({ ok: false, code: "denied" });
		expect(denied.asked).toEqual([]);
		expect(refused.told).toEqual([]);

		// only a ready wallet: archived, being removed, gone or unread, nothing is asked of the owner or the keychain
		for (const state of [{ state: "archived" }, { state: "removing" }, { state: "creating" }, undefined]) {
			const signer = fake();
			const each = deps(signer.signer, { states: [state] });
			expect(await revealKey(ADDRESS, each.deps)).toEqual({ ok: false, code: "not_ready" });
			expect(each.asks).toEqual([]);
			expect(signer.asked).toEqual([]);
		}
		// removing committed while the key was exported: it is not shown, and the daemon hears nothing
		const raced = fake();
		const removing = deps(raced.signer, { states: [{ state: "ready" }, { state: "removing" }] });
		expect(await revealKey(ADDRESS, removing.deps)).toEqual({ ok: false, code: "not_ready" });
		expect(removing.shown).toEqual([]);
		expect(removing.told).toEqual([]);
		// a reveal the daemon did not list is not shown (H-266)
		const unheard = fake();
		const unlisted = deps(unheard.signer, { listed: false });
		expect(await revealKey(ADDRESS, unlisted.deps)).toEqual({ ok: false, code: "unlisted" });
		expect(unlisted.shown).toEqual([]);
		expect(unheard.stopped()).toBe(1);

		const ok = fake();
		const given = deps(ok.signer);
		expect(await revealKey(ADDRESS, given.deps)).toEqual({ ok: true });
		expect(ok.asked).toEqual([["export", 3, ADDRESS]]);
		// the address beside the key is short: a whole address leaves banda only through Receive (H-005, C17)
		expect(given.shown).toEqual([[shortAddress(ADDRESS), KEY]]);
		expect(given.told).toEqual([`/wallets/${ADDRESS}/revealed`]);
		expect(given.asks).toHaveLength(1);
		expect(ok.stopped()).toBe(1);

		for (const [answers, code] of [
			[{ leased: { ok: true, lease: { epoch: 3, mine: false } } }, "other_home"],
			// a keychain with no lease item holds none of the home's keys: the key is missing here, not another home's
			[{ leased: { ok: true, lease: null } }, "missing"],
			[{ leased: { ok: false, code: "locked" } }, "locked"],
			[{ export: { ok: false, code: "key_missing" } }, "key_missing"],
		] as const) {
			const signer = fake(answers);
			const each = deps(signer.signer);
			expect(await revealKey(ADDRESS, each.deps), code).toEqual({ ok: false, code });
			expect(each.shown).toEqual([]);
			expect(each.told).toEqual([]);
			expect(signer.stopped()).toBe(1);
		}

		// a throwing window still stops the signer
		const thrown = fake();
		const broken = deps(thrown.signer);
		await expect(
			revealKey(ADDRESS, {
				...broken.deps,
				show: async () => {
					throw new Error("no window");
				},
			}),
		).rejects.toThrow("no window");
		expect(thrown.stopped()).toBe(1);

		for (const address of [undefined, 7, "0x12", `${ADDRESS}00`, "../wallets"]) {
			const signer = fake();
			const each = deps(signer.signer);
			expect(await revealKey(address, each.deps)).toEqual({ ok: false, code: "refused" });
			expect(each.asks).toEqual([]);
			expect(signer.asked).toEqual([]);
		}
	});

	it("exports a key without a wallet only once the owner re-authenticated, at this home's lease, never through the daemon (H-045)", async () => {
		// no wallet at the address: the signer reads that one item, never a listing of the keychain
		const orphan = { states: [undefined, undefined, undefined] };
		const ok = fake();
		const given = deps(ok.signer, orphan);
		expect(await exportOrphan(ADDRESS, given.deps)).toEqual({ ok: true });
		expect(ok.asked).toEqual([["export", 3, ADDRESS]]);
		expect(given.shown).toEqual([[ADDRESS, KEY]]);
		// the daemon is told nothing: there is no wallet to list it in, and the key never goes to it (C20)
		expect(given.told).toEqual([]);
		expect(given.asks).toEqual(["show the private key of a key without a wallet"]);
		expect(ok.stopped()).toBe(1);

		// without the OS's re-authentication, or refused it: nothing asked of the keychain, nothing shown
		const denied = fake();
		const refused = deps(denied.signer, { ...orphan, reauthenticated: false });
		expect(await exportOrphan(ADDRESS, refused.deps)).toEqual({ ok: false, code: "denied" });
		expect(await exportOrphan(ADDRESS, { ...refused.deps, reauthenticates: false })).toEqual({
			ok: false,
			code: "no_reauthentication",
		});
		expect(denied.asked).toEqual([]);
		expect(refused.shown).toEqual([]);

		// a wallet's key is not this act's: the wallet's own reveal is
		{
			const signer = fake();
			const each = deps(signer.signer);
			expect(await exportOrphan(ADDRESS, each.deps)).toEqual({ ok: false, code: "not_orphan" });
			expect(each.asks).toEqual([]);
			expect(signer.asked).toEqual([]);
		}
		// a wallet made at the address while the key was exported: not shown
		const raced = fake();
		const made = deps(raced.signer, { states: [undefined, { state: "creating" }] });
		expect(await exportOrphan(ADDRESS, made.deps)).toEqual({ ok: false, code: "not_orphan" });
		expect(made.shown).toEqual([]);
		// the signer proves the item a key that opens its address, at this home's lease, or nothing is shown
		for (const [answers, code] of [
			[{ leased: { ok: true, lease: { epoch: 3, mine: false } } }, "other_home"],
			[{ leased: { ok: true, lease: null } }, "missing"],
			[{ export: { ok: false, code: "wrong_key" } }, "wrong_key"],
			// no item at the address: nothing to show
			[{ export: { ok: false, code: "missing" } }, "missing"],
		] as const) {
			const signer = fake(answers);
			const each = deps(signer.signer, orphan);
			expect(await exportOrphan(ADDRESS, each.deps), code).toEqual({ ok: false, code });
			expect(each.shown).toEqual([]);
			expect(signer.stopped()).toBe(1);
		}
		for (const address of [undefined, 7, "0x12", `${ADDRESS}00`]) {
			const signer = fake();
			const each = deps(signer.signer, orphan);
			expect(await exportOrphan(address, each.deps)).toEqual({ ok: false, code: "refused" });
			expect(signer.asked).toEqual([]);
		}
	});

	it("deletes a key without a wallet, that one item alone, only once the owner re-authenticated (H-045)", async () => {
		const orphan = { states: [undefined, undefined, undefined] };
		const ok = fake();
		const given = deps(ok.signer, orphan);
		expect(await deleteOrphan(ADDRESS, given.deps)).toEqual({ ok: true });
		expect(ok.asked).toEqual([["remove", 3, ADDRESS]]);
		expect(given.shown).toEqual([]);
		expect(given.asks).toEqual(["delete a key without a wallet from this computer"]);
		expect(ok.stopped()).toBe(1);

		const denied = fake();
		const refused = deps(denied.signer, { ...orphan, reauthenticated: false });
		expect(await deleteOrphan(ADDRESS, refused.deps)).toEqual({ ok: false, code: "denied" });
		expect(await deleteOrphan(ADDRESS, { ...refused.deps, reauthenticates: false })).toEqual({
			ok: false,
			code: "no_reauthentication",
		});
		expect(denied.asked).toEqual([]);
		// a wallet's key is never deleted here, nor one a wallet came to name before the deletion
		const wallet = fake();
		expect(await deleteOrphan(ADDRESS, deps(wallet.signer).deps)).toEqual({
			ok: false,
			code: "not_orphan",
		});
		const raced = fake();
		const named = deps(raced.signer, { states: [undefined, { state: "creating" }] });
		expect(await deleteOrphan(ADDRESS, named.deps)).toEqual({ ok: false, code: "not_orphan" });
		expect([...wallet.asked, ...raced.asked]).toEqual([]);
		const other = fake({ leased: { ok: true, lease: { epoch: 3, mine: false } } });
		expect(await deleteOrphan(ADDRESS, deps(other.signer, orphan).deps)).toEqual({ ok: false, code: "other_home" });
		expect(other.asked).toEqual([]);
	});

	it("deletes a key without a wallet through the channel's act, from a keychain that keeps every other item", async () => {
		const home = await tempHome();
		await installationId(home);
		const keys = join(await tempHome(), "keys.json");
		vi.stubEnv("BANDA_TEST_KEYSTORE", keys);
		const store = new FileKeystore(keys);
		const { Signer } = await import("../src/wallet/signer-client.ts");
		const plain = new Signer(await signerHome(home));
		let address: string;
		let epoch: number;
		try {
			const claimed = await plain.lease(null);
			if (!claimed.ok) throw new Error(claimed.code);
			epoch = claimed.epoch;
			const made = await plain.create(claimed.epoch, async () => {});
			if (!made.ok) throw new Error(made.code);
			address = made.address;
		} finally {
			plain.stop();
		}
		const at = await signerHome(home);
		const item = walletAccount(at.id, address as Address);
		expect(await store.read(item)).not.toBeNull();
		const shown: [string, string][] = [];
		const given: WalletDeps = {
			signer: () => hostSigner(sources, home, process.execPath),
			reauthenticate: async () => true,
			reauthenticates: true,
			identityLost: async () => false,
			lease: async () => epoch,
			wallets: async () => [],
			tell: async () => true,
			show: async (to, key) => {
				shown.push([to, key]);
			},
		};
		const exported = await WALLET_ACTS["banda:export-orphan"]?.(given, address);
		expect(exported).toEqual({ ok: true });
		expect(shown).toHaveLength(1);
		expect(addressOf(shown[0]?.[1] as Key)).toBe(address);
		expect(await WALLET_ACTS["banda:delete-orphan"]?.(given, address)).toEqual({ ok: true });
		expect(await store.read(item)).toBeNull();
		// the lease and the home secret stay
		expect(await store.read(leaseAccount(at.id))).not.toBeNull();
		// neither act listed the keychain: each read the one item it names (H-009, H-037)
		const calls = (JSON.parse(readFileSync(keys, "utf8")) as FakeState).calls;
		expect(calls.filter((call) => call.op === "find")).toEqual([]);
	});

	it("kills an act's signer child parked on a keychain call that never answers when the app quits (H-034, C20)", async () => {
		const home = await tempHome();
		await installationId(home);
		const keys = join(await tempHome(), "keys.json");
		vi.stubEnv("BANDA_TEST_KEYSTORE", keys);
		const { Signer } = await import("../src/wallet/signer-client.ts");
		const plain = new Signer(await signerHome(home));
		let address: string;
		try {
			const claimed = await plain.lease(null);
			if (!claimed.ok) throw new Error(claimed.code);
			const made = await plain.create(claimed.epoch, async () => {});
			if (!made.ok) throw new Error(made.code);
			address = made.address;
		} finally {
			plain.stop();
		}
		const at = await signerHome(home);
		const state = JSON.parse(readFileSync(keys, "utf8")) as FakeState;
		// the key's read waits on a prompt nobody answers
		state.faults.push({ point: "keychain:read", account: walletAccount(at.id, address as Address), hang: true });
		await writeFile(keys, JSON.stringify(state));
		// a module of its own: once the app quits, every signer after is stopped as it comes
		vi.resetModules();
		const fresh = await import("../desktop/src/wallets.ts");
		const shell = fresh.walletDeps({
			release: () => ({ node: process.execPath, cli: join(process.cwd(), "dist/cli/index.js") }),
			home,
			daemon: () => undefined,
			show: async () => {},
			load: sources,
		});
		const given: WalletDeps = {
			...shell,
			reauthenticate: async () => true,
			reauthenticates: true,
			identityLost: async () => false,
			wallets: async () => [],
		};
		const exported = fresh.exportOrphan(address, given);
		const parked = async () => {
			const calls = (JSON.parse(readFileSync(keys, "utf8")) as FakeState).calls;
			return calls.find((call) => call.op === "read" && call.account.includes(address) && call.end === undefined);
		};
		let call: Awaited<ReturnType<typeof parked>>;
		await until(async () => {
			call = await parked();
			return call !== undefined;
		});
		const pid = (call as NonNullable<typeof call>).pid;
		expect(alive(pid)).toBe(true);
		fresh.stopSigners();
		await until(async () => !alive(pid));
		// killed by the quit, not by the child's deadline, which says `timeout`
		expect(await exported).toEqual({ ok: false, code: "other" });
		// a signer an act makes after the quit began asks the keychain nothing
		const before = (JSON.parse(readFileSync(keys, "utf8")) as FakeState).calls.length;
		expect((await fresh.exportOrphan(address, given)).ok).toBe(false);
		expect((JSON.parse(readFileSync(keys, "utf8")) as FakeState).calls.length).toBe(before);
	}, 60_000);

	it("reads a pasted key by the one rule the save step's check uses (src/wallet/key-text.ts)", () => {
		const hex = "ab".repeat(16) + "CD".repeat(16);
		for (const pasted of [
			`0x${hex}`,
			hex,
			` 0x ${hex.match(/.{4}/g)?.join(" ")}\n`,
			`0X${hex}`,
			`0x${hex}00`,
			"0x12",
			"",
			`0x${"zz".repeat(32)}`,
			`0x 0x${hex}`,
		])
			expect(desktopNormalKey(pasted), pasted).toBe(normalKey(pasted));
		expect(normalKey(` 0x ${hex.match(/.{4}/g)?.join(" ")}`)).toBe(`0x${hex.toLowerCase()}`);
	});

	it("takes a Restore only of a key in its shape, for a wallet whose key is missing, re-authenticated, at this home's lease", async () => {
		for (const state of [{ state: "ready", signing: { state: "online" } }, { state: "ready" }, undefined]) {
			const signer = fake();
			const each = deps(signer.signer, { states: [state] });
			expect(await restoreKey(ADDRESS, KEY, each.deps)).toEqual({ ok: false, code: "not_missing" });
			expect(each.asks).toEqual([]);
			expect(signer.asked).toEqual([]);
		}
		const denied = fake();
		const refusedOwner = deps(denied.signer, { reauthenticated: false });
		expect(await restoreKey(ADDRESS, KEY, refusedOwner.deps)).toEqual({ ok: false, code: "denied" });
		expect(denied.asked).toEqual([]);
		const restored = fake();
		const asked = deps(restored.signer);
		expect(await restoreKey(ADDRESS, KEY, asked.deps)).toEqual({ ok: true });
		expect(asked.asks).toHaveLength(1);
		expect(restored.asked).toEqual([["restore", 3, ADDRESS, KEY]]);
		// the copy as the owner may have written it: without 0x, in the groups of four it was shown in, across lines, in
		// capitals; each is the key, as the save step's check reads it (UC-19 A2, H-014)
		const groups = (hex: string) => hex.match(/.{4}/g)?.join(" ") ?? "";
		for (const written of [
			KEY.slice(2),
			`0x ${groups(KEY.slice(2))}`,
			groups(KEY.slice(2)),
			` ${KEY.slice(0, 34)}\n${KEY.slice(34)}\n`,
			KEY.toUpperCase().replace("0X", "0x"),
		]) {
			const signer = fake();
			const each = deps(signer.signer);
			expect(await restoreKey(ADDRESS, written, each.deps), written).toEqual({ ok: true });
			expect(signer.asked).toEqual([["restore", 3, ADDRESS, KEY]]);
		}
		// a copy that is no key's text is said apart from a key that opens another address, before anything is asked
		for (const key of [undefined, 7, "", "0x12", `0x${"ab".repeat(31)}`, `${KEY}00`, `0x${"zz".repeat(32)}`, "0x0x"]) {
			const signer = fake();
			const each = deps(signer.signer);
			expect(await restoreKey(ADDRESS, key, each.deps)).toEqual({ ok: false, code: "not_a_key" });
			expect(each.asks).toEqual([]);
			expect(signer.asked).toEqual([]);
		}
		expect(await restoreKey("nope", KEY, deps(fake().signer).deps)).toEqual({ ok: false, code: "refused" });
		const elsewhere = fake({ leased: { ok: true, lease: { epoch: 2, mine: false } } });
		expect(await restoreKey(ADDRESS, KEY, deps(elsewhere.signer).deps)).toEqual({ ok: false, code: "other_home" });
		expect(elsewhere.asked).toEqual([]);
		const wrong = fake({ restore: { ok: false, code: "wrong_key" } });
		const told = deps(wrong.signer);
		expect(await restoreKey(ADDRESS, KEY, told.deps)).toEqual({ ok: false, code: "wrong_key" });
		expect(told.told).toEqual([]);
	});

	it("moves signing here for every wallet whose key the home keeps, as the daemon lists them, once re-authenticated", async () => {
		const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
		const gone = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
		// no daemon answering: nothing is asked, nothing moves
		const unanswered = fake();
		const none = deps(unanswered.signer);
		expect(await moveSigning({ ...none.deps, wallets: async () => undefined })).toEqual({
			ok: false,
			code: "no_daemon",
		});
		expect(unanswered.asked).toEqual([]);
		// a home that keeps no wallet yet (a backup from before the first) moves with nothing to prove, so it can make
		// one, and the daemon settles what waited on the lease (UC-21 A1)
		const bare = fake({ leased: { ok: true, lease: { epoch: 4, mine: false } } });
		const empty = deps(bare.signer, { states: [undefined], others: [{ address: gone, state: "removing" }] });
		expect(await moveSigning(empty.deps)).toEqual({ ok: true });
		expect(empty.asks).toHaveLength(1);
		expect(bare.asked).toEqual([["move", 4, [], 3]]);
		expect(empty.told).toEqual(["/wallets/keychain"]);
		const denied = fake();
		expect(await moveSigning(deps(denied.signer, { reauthenticated: false }).deps)).toEqual({
			ok: false,
			code: "denied",
		});
		expect(denied.asked).toEqual([]);
		const here = fake();
		expect(await moveSigning(deps(here.signer).deps)).toEqual({ ok: true });
		expect(here.asked).toEqual([]);
		// this home's lease behind the store's (a keychain item rolled back): moved past the store's epoch
		const behind = fake({ leased: { ok: true, lease: { epoch: 2, mine: true } } });
		const rolled = deps(behind.signer, { states: [undefined] });
		expect(await moveSigning(rolled.deps)).toEqual({ ok: true });
		expect(behind.asked).toEqual([["move", 2, [], 3]]);
		expect(rolled.told).toEqual(["/wallets/keychain"]);
		// no lease item where the store never took one: moved all the same, over whatever home secret is left
		const unleased = fake({ leased: { ok: true, lease: null } });
		const fresh = deps(unleased.signer, { states: [undefined] });
		expect(await moveSigning({ ...fresh.deps, lease: async () => undefined })).toEqual({ ok: true });
		expect(unleased.asked).toEqual([["move", null, [], undefined]]);
		expect(fresh.told).toEqual(["/wallets/keychain"]);
		// every kept wallet is proven, an archived one too; one being removed or made is not the move's to prove
		const moved = fake({ leased: { ok: true, lease: { epoch: 5, mine: false } } });
		const each = deps(moved.signer, {
			others: [
				{ address: other, state: "archived" },
				{ address: gone, state: "removing" },
			],
		});
		expect(await moveSigning(each.deps)).toEqual({ ok: true });
		expect(moved.asked).toEqual([["move", 5, [ADDRESS, other], 3]]);
		expect(each.told).toEqual([`/wallets/${ADDRESS}/check`, `/wallets/${other}/check`, "/wallets/keychain"]);
	});

	it("writes nothing when a second wallet's key is not here, whichever wallet the move was asked from", async () => {
		const home = await tempHome();
		await installationId(home);
		const keys = join(await tempHome(), "keys.json");
		vi.stubEnv("BANDA_TEST_KEYSTORE", keys);
		const store = new FileKeystore(keys);
		const { Signer } = await import("../src/wallet/signer-client.ts");
		const plain = new Signer(await signerHome(home));
		const made: string[] = [];
		try {
			const claimed = await plain.lease(null);
			if (!claimed.ok) throw new Error(claimed.code);
			for (let i = 0; i < 2; i++) {
				const one = await plain.create(claimed.epoch, async () => {});
				if (!one.ok) throw new Error(one.code);
				made.push(one.address);
			}
		} finally {
			plain.stop();
		}
		const [first, second] = made as [string, string];
		const id = (await signerHome(home)).id;
		// another home took the lease, and this one lost the second wallet's key
		const lease = leaseAccount(id);
		const before = JSON.parse((await store.read(lease)) as string) as { epoch: number; holder: string };
		await store.write(lease, JSON.stringify({ epoch: before.epoch + 1, holder: "e".repeat(64) }));
		expect(await store.remove(walletAccount(id, second as Address))).toBe(true);
		const items = () => JSON.stringify((JSON.parse(readFileSync(keys, "utf8")) as { items: unknown }).items);
		const kept = items();
		const told: string[] = [];
		const asked: WalletDeps = {
			signer: () => hostSigner(sources, home, process.execPath),
			reauthenticate: async () => true,
			reauthenticates: true,
			identityLost: async () => false,
			lease: async () => 1,
			wallets: async () => [
				{ address: first, state: "ready" },
				{ address: second, state: "ready" },
			],
			tell: async (path) => {
				told.push(path);
				return true;
			},
			show: async () => {},
		};
		expect(await underElectron(() => moveSigning(asked))).toEqual({ ok: false, code: "missing" });
		expect(items()).toBe(kept);
		expect(told).toEqual([]);
	});

	it("answers each act of the daemon's page on the channel the preload sends it on", () => {
		expect(Object.keys(WALLET_ACTS).sort()).toEqual([
			"banda:delete-orphan",
			"banda:export-orphan",
			"banda:move-signing",
			"banda:restore-key",
			"banda:reveal-key",
		]);
		const preload = readFileSync(join(import.meta.dirname, "..", "desktop", "src", "preload.cts"), "utf8");
		for (const channel of Object.keys(WALLET_ACTS)) expect(preload).toContain(`ipcRenderer.invoke("${channel}"`);
		// the restore's key goes from the page to the act, and from it to the signer alone
		expect(preload).toContain(`ipcRenderer.invoke("banda:restore-key", address, key)`);
		const main = readFileSync(join(import.meta.dirname, "..", "desktop", "src", "main.ts"), "utf8");
		expect(main).toMatch(
			/for \(const \[channel, act\] of Object\.entries\(WALLET_ACTS\)\)[\s\S]{0,200}fromOwnPage\(event\)/,
		);
		// the page words its key steps by whether this computer asks the owner who they are, as the acts decide (H-266)
		expect(preload).toContain(`reauthenticates: ipcRenderer.sendSync("banda:reauthenticates") === true`);
		expect(main).toMatch(/ipcMain\.on\("banda:reauthenticates"[\s\S]{0,80}event\.returnValue = reauthenticates\(\)/);
		expect(main).toMatch(/reauthenticates\(\) \? \{ authenticate:/);
	});

	it("restores through the channel's act: a key that opens another address leaves it missing, its own brings it back", async () => {
		const home = await tempHome();
		await installationId(home);
		const keys = join(await tempHome(), "keys.json");
		vi.stubEnv("BANDA_TEST_KEYSTORE", keys);
		const store = new FileKeystore(keys);
		const { Signer } = await import("../src/wallet/signer-client.ts");
		const plain = new Signer(await signerHome(home));
		let address: Address;
		try {
			const claimed = await plain.lease(null);
			if (!claimed.ok) throw new Error(claimed.code);
			const one = await plain.create(claimed.epoch, async () => {});
			if (!one.ok) throw new Error(one.code);
			address = one.address as Address;
		} finally {
			plain.stop();
		}
		const account = walletAccount((await signerHome(home)).id, address);
		const key = (await store.read(account)) as Key;
		expect(await store.remove(account)).toBe(true);
		let signing = "key_missing";
		const told: string[] = [];
		const asked: WalletDeps = {
			signer: () => hostSigner(sources, home, process.execPath),
			reauthenticate: async () => true,
			reauthenticates: true,
			identityLost: async () => false,
			lease: async () => 1,
			wallets: async () => [{ address, state: "ready", signing: { state: signing } }],
			tell: async (path) => {
				told.push(path);
				signing = (await store.read(account)) === null ? "key_missing" : "online";
				return true;
			},
			show: async () => {},
		};
		const restore = WALLET_ACTS["banda:restore-key"] as (deps: WalletDeps, ...args: unknown[]) => Promise<unknown>;
		const another = `0x${"cd".repeat(32)}`;
		expect(addressOf(another as Key)).not.toBe(address);
		expect(await underElectron(() => restore(asked, address, another))).toEqual({ ok: false, code: "wrong_key" });
		expect(await store.read(account)).toBeNull();
		expect(signing).toBe("key_missing");
		expect(told).toEqual([]);
		expect(await underElectron(() => restore(asked, address, key))).toEqual({ ok: true });
		expect(await store.read(account)).toBe(key);
		expect(told).toEqual([`/wallets/${address}/check`]);
		expect(signing).toBe("online");
	});

	it("shows the key in a bundled page that allows its one script by hash, holds no key, and hides it after 30 s", async () => {
		const page = readFileSync(join(import.meta.dirname, "..", "desktop", ...KEY_PAGE), "utf8");
		const script = /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? "";
		const hash = createHash("sha256").update(script, "utf8").digest("base64");
		expect(page).toContain(`script-src 'sha256-${hash}'`);
		expect(page).toContain("default-src 'none'");
		expect(page).toContain("connect-src 'none'");
		expect(page).not.toMatch(/0x[0-9a-fA-F]{40}/);
		// the reveal screen's words (H-281): a screen reader reads the key aloud
		expect(page).toContain("A screen reader reads it aloud.");
		// how other wallets import it, and that there are no words to look for (H-008)
		expect(page).toContain("Import account → Private key");
		expect(page).toContain("There is no seed phrase");
		expect(page).not.toContain("break-all");
		// the page's script, on elements that only hold what it sets, with a clock the test turns
		type Element = {
			textContent: string;
			disabled: boolean;
			attributes: Map<string, string>;
			on: Map<string, (event?: unknown) => void>;
			click: () => void;
		};
		const listening = () => {
			const on = new Map<string, (event?: unknown) => void>();
			return { on, addEventListener: (type: string, then: (event?: unknown) => void) => on.set(type, then) };
		};
		const elements = new Map<string, Element>();
		const element = (id: string) => {
			let found = elements.get(id);
			if (found === undefined) {
				const attributes = new Map<string, string>();
				const { on, addEventListener } = listening();
				const made = {
					textContent: "",
					disabled: true,
					attributes,
					on,
					click: () => on.get("click")?.(),
					setAttribute: (name: string, value: string) => attributes.set(name, value),
					removeAttribute: (name: string) => attributes.delete(name),
					hasAttribute: (name: string) => attributes.has(name),
					addEventListener,
				};
				found = made;
				elements.set(id, found);
			}
			return found;
		};
		let given: ((shown: { address: string; key: string }) => void) | undefined;
		let copied = 0;
		const timers: { at: number; then: () => void }[] = [];
		let clock = 0;
		const windowEvents = listening();
		const documentEvents = listening();
		const document = { getElementById: element, visibilityState: "visible", ...documentEvents };
		runInNewContext(script, {
			document,
			window: {
				...windowEvents,
				bandaKey: {
					shown: (then: typeof given) => {
						given = then;
					},
					copy: () => {
						copied += 1;
					},
				},
			},
			setTimeout: (then: () => void, ms: number) => timers.push({ at: clock + ms, then }) - 1,
			clearTimeout: (id: number | undefined) => {
				if (id !== undefined && timers[id] !== undefined) timers[id].at = Number.POSITIVE_INFINITY;
			},
		});
		const turn = (ms: number) => {
			clock += ms;
			for (const timer of timers)
				if (timer.at <= clock) {
					timer.at = Number.POSITIVE_INFINITY;
					timer.then();
				}
		};
		const key = element("key");
		const label = element("hidden");
		given?.({ address: ADDRESS, key: KEY });
		expect(element("address").textContent).toBe(ADDRESS);
		expect(key.textContent).not.toContain(KEY.slice(2, 6));
		// hidden, a screen reader hears "private key, hidden" and never the key
		expect(key.attributes.get("aria-hidden")).toBe("true");
		expect(label.textContent).toBe(", hidden");
		element("show").click();
		// shown, in groups of four, which a screen reader reads group by group
		expect(key.textContent).toBe(KEY.match(/.{1,4}/g)?.join(" "));
		expect(key.textContent.replaceAll(" ", "")).toBe(KEY);
		expect(key.attributes.has("aria-hidden")).toBe(false);
		expect(label.textContent).toBe("");
		turn(29_999);
		expect(key.textContent.replaceAll(" ", "")).toBe(KEY);
		turn(1);
		expect(key.textContent).not.toContain(KEY.slice(2, 6));
		expect(key.attributes.get("aria-hidden")).toBe("true");
		expect(label.textContent).toBe(", hidden");
		expect(element("show").disabled).toBe(false);
		element("copy").click();
		expect(copied).toBe(1);
		// after Copy, the clipboard's words (H-271)
		expect(element("note").textContent).toContain("cleared in a minute");
		expect(element("note").textContent).toContain("A clipboard manager, or a clipboard shared with your other devices");
		// a copy selected by hand goes through the same clipboard, never the spaced groups
		element("show").click();
		let prevented = false;
		key.on.get("copy")?.({ preventDefault: () => (prevented = true) });
		expect(prevented).toBe(true);
		expect(copied).toBe(2);
		// switching away drops the key (H-274): hidden, Show and Copy off, and it cannot be shown again
		windowEvents.on.get("blur")?.();
		expect(key.textContent).not.toContain(KEY.slice(2, 6));
		expect(key.attributes.get("aria-hidden")).toBe("true");
		expect(element("show").disabled).toBe(true);
		expect(element("copy").disabled).toBe(true);
		element("show").click();
		element("copy").click();
		expect(key.textContent).not.toContain(KEY.slice(2, 6));
		expect(copied).toBe(2);
	});

	it("drops the key when the page is hidden, as on blur", () => {
		const page = readFileSync(join(import.meta.dirname, "..", "desktop", ...KEY_PAGE), "utf8");
		expect(page).toMatch(/visibilitychange[\s\S]*visibilityState === "hidden"\) drop\(\)/);
		// the window that shows it closes on blur and lets the key go, in the main process too
		const main = readFileSync(join(import.meta.dirname, "..", "desktop", "src", "main.ts"), "utf8");
		const shown = main.slice(main.indexOf("function keyWindow"), main.indexOf("const secret = secretClipboard"));
		expect(shown).toMatch(
			/shown\.on\("blur", \(\) => \{\s*delete held\.key;\s*if \(!shown\.isDestroyed\(\)\) shown\.close\(\);/,
		);
		expect(shown).toMatch(/shown\.on\("closed", \(\) => \{\s*delete held\.key;/);
	});
});

describe("a home whose id is not its wallets' (H-261)", () => {
	const failing: HostSigner = new Proxy({} as HostSigner, {
		get: () => () => {
			throw new Error("no signer runs while the home's id is lost");
		},
	});

	it("runs no act while the daemon says the id is lost: no Touch ID asked, no signer started", async () => {
		const made = deps(failing);
		let started = 0;
		const lost: WalletDeps = {
			...made.deps,
			identityLost: async () => true,
			signer: async () => {
				started++;
				return failing;
			},
		};
		for (const answer of [
			await revealKey(ADDRESS, lost),
			await restoreKey(ADDRESS, KEY, lost),
			await moveSigning(lost),
			await exportOrphan(ADDRESS, lost),
			await deleteOrphan(ADDRESS, lost),
		])
			expect(answer).toEqual({ ok: false, code: "identity" });
		expect(made.asks).toEqual([]);
		expect(started).toBe(0);
		expect(made.told).toEqual([]);
	});

	it("answers identity, and makes no id, when the signer finds the home's id missing", async () => {
		const home = await tempHome();
		const made = deps(failing);
		const missing: WalletDeps = {
			...made.deps,
			signer: () => hostSigner(sources, home, process.execPath),
		};
		expect(await revealKey(ADDRESS, missing)).toEqual({ ok: false, code: "identity" });
		expect(await moveSigning(missing)).toEqual({ ok: false, code: "identity" });
		expect(existsSync(join(home, "auth", "device-id"))).toBe(false);
	});

	it("reads the daemon's offline identity as the id lost, and no daemon as not", async () => {
		let offline: string | undefined = "identity";
		let attached: { port: number; token: string } | undefined = { port: 1, token: "t" };
		const read = walletDeps({
			release: () => ({ node: "/n", cli: "/c" }),
			home: "/the/home",
			daemon: () => attached,
			show: async () => {},
			fetch: async () => new Response(JSON.stringify({ wallets: [], networks: [], offline })),
		});
		expect(await read.identityLost()).toBe(true);
		offline = undefined;
		expect(await read.identityLost()).toBe(false);
		attached = undefined;
		expect(await read.identityLost()).toBe(false);
	});
});

describe("a copied key on the clipboard", () => {
	function board(start = "") {
		let text = start;
		const timers: { ms: number; then: () => void }[] = [];
		const secret = secretClipboard(
			{
				readText: () => text,
				writeText: (next) => {
					text = next;
				},
				clear: () => {
					text = "";
				},
			},
			(then, ms) => timers.push({ ms, then }),
		);
		const elapse = async () => {
			for (const timer of timers.splice(0)) timer.then();
			await Promise.resolve();
		};
		return {
			secret,
			timers,
			elapse,
			text: () => text,
			copyElse: (next: string) => {
				text = next;
			},
		};
	}

	it("is cleared after the delay", async () => {
		const { secret, timers, elapse, text } = board();
		await secret.copy(KEY);
		expect(text()).toBe(KEY);
		expect(timers.map((timer) => timer.ms)).toEqual([CLIPBOARD_CLEAR]);
		await elapse();
		expect(text()).toBe("");
	});

	it("is cleared on quit, before its delay", async () => {
		const { secret, timers, text } = board();
		await secret.copy(KEY);
		await secret.clear();
		expect(text()).toBe("");
		expect(timers).toHaveLength(1);
	});

	it("keeps a later copy of something else, at the delay and on quit", async () => {
		const { secret, elapse, text, copyElse } = board();
		await secret.copy(KEY);
		copyElse("a shopping list");
		await secret.clear();
		expect(text()).toBe("a shopping list");
		await elapse();
		expect(text()).toBe("a shopping list");
	});

	it("an empty clear with nothing copied leaves the clipboard alone", async () => {
		const { secret, text } = board("something the owner copied");
		await secret.clear();
		expect(text()).toBe("something the owner copied");
		await secret.copy(KEY);
		await secret.clear();
		expect(text()).toBe("");
		await secret.clear();
		expect(text()).toBe("");
	});
});
