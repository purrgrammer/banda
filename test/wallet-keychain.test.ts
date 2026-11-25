/**
 * @keychain: the signer child against the real OS keychain, under a throwaway service `banda-test-<run>-<hex>`, never
 * banda's own (H-031). It runs only when asked, with `BANDA_TEST_KEYCHAIN=1`, on macOS (it may raise a keychain prompt
 * for the person at the screen) or in the Linux keychain image; everything it made is removed after it, and on macOS
 * the listing shows nothing is left (Linux refuses the listing).
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Address } from "../src/wallet/address.ts";
import { homeSecretAccount, leaseAccount, walletAccount } from "../src/wallet/home-id.ts";
import { KeychainStore } from "../src/wallet/keystore.ts";
import { Signer } from "../src/wallet/signer-client.ts";

const asked =
	process.env.BANDA_TEST_KEYCHAIN === "1" && (process.platform === "darwin" || process.platform === "linux");
const service = `banda-test-${Date.now()}-${randomBytes(4).toString("hex")}`;
const home = { id: `t-${randomBytes(4).toString("hex")}`, binding: randomBytes(32).toString("hex") };
const items: string[] = [leaseAccount(home.id), homeSecretAccount(home.id)];
const listed = process.platform === "darwin";

afterAll(async () => {
	if (!asked) return;
	const store = new KeychainStore(service);
	if (listed) for (const account of await store.find("")) await store.remove(account);
	for (const account of items) await store.remove(account);
	if (listed) expect(await store.find("")).toEqual([]);
	else for (const account of items) expect(await store.read(account)).toBeNull();
});

describe.skipIf(!asked)("@keychain the signer on the OS keychain", () => {
	it("sets the canary, leases, creates, proves, signs and removes, under a throwaway service", async () => {
		const env: NodeJS.ProcessEnv = { ...process.env, BANDA_TEST_KEYCHAIN_SERVICE: service };
		delete env.BANDA_TEST_KEYSTORE;
		const signer = new Signer(home, { env });
		expect(await signer.canary()).toEqual({ ok: true });
		const leased = await signer.lease(null);
		if (!leased.ok) throw new Error(leased.code);
		const made = await signer.create(leased.epoch, async (address) => {
			items.push(walletAccount(home.id, address));
		});
		if (!made.ok) throw new Error(made.code);
		const address = made.address as Address;
		expect(await signer.derive(leased.epoch, address)).toEqual({ ok: true, address });
		const signed = await signer.transfer(leased.epoch, address, {
			chainId: 31337,
			nonce: 0n,
			maxFee: 2_000_000_000n,
			tip: 1_000_000_000n,
			gasLimit: 21_000n,
			to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
			value: 1n,
		});
		expect(signed.ok).toBe(true);
		expect(await signer.find(leased.epoch)).toEqual(
			listed ? { ok: true, addresses: [address] } : { ok: false, code: "no_keychain" },
		);
		expect(await signer.remove(leased.epoch, address)).toEqual({ ok: true, removed: true });
		expect(await signer.derive(leased.epoch, address)).toEqual({ ok: false, code: "missing" });
	});
});
