/**
 * The signer as the host process uses it: the desktop app's main process, never the daemon (`banda wallet` reveals
 * through the creation's capability instead, C16). Only it sends a request carrying a key, the owner's Restore key, so
 * the key never passes through the daemon (C20) and the restore is host-only like the export (H-014); only it asks for
 * the export, whose answer carries the key (OD-2); and only it moves the lease to a home whose binding is not the home
 * secret's (UC-21). No module of the daemon imports this one, which test/wallet-signer.test.ts holds.
 *
 * The desktop app's main process runs under Electron, whose own binary is not the daemon's: it passes `node`, the
 * bundled node the daemon runs, so the keychain sees the one code identity its items trust.
 */
import type { Address } from "./address.ts";
import type { Hex } from "./sign.ts";
import { Signer } from "./signer-client.ts";

export class HostSigner extends Signer {
	/** Keeps the owner's exported key for a wallet whose item is gone, only if it derives `address` (H-014). */
	restore(lease: number, address: Address, key: Hex) {
		return this.call({ op: "restore", lease, address, key });
	}

	/**
	 * Moves the lease to this home from the one holding it at `expected`, binding a fresh home secret here (UC-21), once
	 * each of `addresses` proved its key: a key missing or not the address's fails the move before it writes anything,
	 * so the home holding the lease stays online. The new epoch is past `after` too, the one the home's store last took,
	 * so the store takes it whatever the keychain held (a lease item rolled back behind the store). `expected` is null
	 * where no lease is held anywhere: no lease item, and none the store took. It reads the lease, the home secret and
	 * each key, any of which may wait on the owner's answer after an update (H-017): its deadline is one answer's each.
	 */
	move(expected: number | null, addresses: readonly Address[], after?: number) {
		return this.call(
			{ op: "move", expected, addresses: [...addresses], ...(after === undefined ? {} : { after }) },
			{ items: addresses.length + 2 },
		);
	}

	/** The wallet's key, proven to derive `address`, for the owner's later reveal on this computer (OD-2, UC-02 A2). */
	export(lease: number, address: Address) {
		return this.call({ op: "export", lease, address });
	}
}
