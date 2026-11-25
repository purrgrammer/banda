/**
 * Which home may sign (src/wallet/home-id.ts, C16): the id a home's items are named by, the binding no copy of a home
 * shares, and the lease, a compare-and-set on its epoch in the keystore. A backup, its restore, a fork and a hand copy
 * all start without the lease, and none of them carries the home secret (`src/core/backup.ts` and
 * `scripts/fork-home.ts` never copy it); a fork is marked and can never take one. The keystore is a test one, kept
 * outside every home.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forkHome } from "../scripts/fork-home.ts";
import { backupHome, restoreHome } from "../src/core/backup.ts";
import { HOME_FORMAT } from "../src/core/format.ts";
import { RESTORED_MARKER, restoredOf } from "../src/core/restored.ts";
import { installationId } from "../src/home.ts";
import type { Address } from "../src/wallet/address.ts";
import {
	bindingOf,
	canaryAccount,
	claimLease,
	FORK_MARKER,
	homeBinding,
	homeSecretAccount,
	IdentityMissing,
	isFork,
	isTestHome,
	leaseAccount,
	leaseMine,
	leaseOf,
	moveLease,
	signerHome,
	TEST_HOME_MARKER,
	Unreadable,
	walletAccount,
	walletPrefix,
} from "../src/wallet/home-id.ts";
import { FileKeystore, MemoryKeystore } from "../src/wallet/keystore.ts";
import { seed } from "./fault/backup-scenario.ts";
import { tempHome, until } from "./helpers.ts";

async function* files(path: string): AsyncGenerator<string> {
	for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) yield* files(full);
		else if (entry.isFile()) yield full;
	}
}

/** Every file under `root` that holds any of `needles`, as text or as raw bytes. */
async function holding(root: string, needles: string[]): Promise<string[]> {
	const found: string[] = [];
	for await (const file of files(root)) {
		const bytes = await readFile(file);
		const text = bytes.toString("latin1").toLowerCase();
		for (const needle of needles) {
			if (text.includes(needle) || bytes.includes(Buffer.from(needle, "hex"))) found.push(file);
		}
	}
	return found;
}

describe("a home's id and binding", () => {
	it("binds and names as every released build did, so a home's items stay its own across an upgrade", async () => {
		// golden: a change here makes every existing home's binding or items another's, and it starts offline
		const folder = { ino: 42n, birthtimeNs: 1_700_000_000_123_456_789n };
		expect(bindingOf("/Users/owner/.banda", folder, "darwin")).toBe(
			"5da000b4fc3f9dc0b9aa35db597b28dc4d724862cf8b4e1f5cb03dcb655ada3a",
		);
		expect(bindingOf("/home/owner/.banda", folder, "linux")).toBe(
			"d89248e3ea7b18afe5a635cd227b792f2d4e2556df5d7cdce2bf97d50916f942",
		);
		expect(bindingOf("/Users/owner/.banda", folder, "darwin", "d".repeat(64))).toBe(
			"aafb9b6d279ceec3f044c458f2bd4e865db63927633e4c3f34088818470d643a",
		);
		const address = "0x804e4bbc0037b43a1b6a4b6508bee7e7dc188b3f" as Address;
		expect(walletAccount("home-1", address)).toBe("home-1/wallet/0x804e4bBc0037B43A1b6a4B6508beE7e7Dc188B3f");
		expect(walletPrefix("home-1")).toBe("home-1/wallet/");
		expect(leaseAccount("home-1")).toBe("home-1/lease");
		expect(homeSecretAccount("home-1")).toBe("home-1/home-secret");
		expect(canaryAccount("home-1", 5)).toBe("home-1/canary/5");
		// the items' JSON as a released build wrote them, read as this home's lease
		const keystore = new MemoryKeystore();
		const secret = "1".repeat(64);
		await keystore.write(homeSecretAccount("home-1"), JSON.stringify({ secret, binding: "2".repeat(64) }));
		await keystore.write(
			leaseAccount("home-1"),
			'{"epoch":3,"holder":"3138bb9bc78df27c473ecfd1410f7bd45ebac1f59cf3ff9cfe4db77aab7aedd3"}',
		);
		expect(await leaseOf(keystore, { id: "home-1", binding: "2".repeat(64) })).toEqual({ epoch: 3, mine: true });
	});

	it("names a home by its device id, and binds it to where it is", async () => {
		const home = await tempHome();
		const id = await installationId(home);
		expect(id).toBe(await installationId(home));
		expect(await installationId(home)).toBe(id);
		const binding = await homeBinding(home);
		expect(binding).toMatch(/^[0-9a-f]{64}$/);
		expect(await homeBinding(home)).toBe(binding);
		expect(await signerHome(home)).toEqual({ id, binding, test: true });
		expect(walletAccount(id, "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address)).toBe(
			`${id}/wallet/0x70997970C51812dc3A010C7d01b50e0d17dc79C8`,
		);
	});

	it("gives a hand copy the id and another binding, and so does a home put back in place", async () => {
		const area = await tempHome();
		const home = join(area, "home");
		await mkdir(home);
		const id = await installationId(home);
		const binding = await homeBinding(home);
		execFileSync("cp", ["-Rp", home, join(area, "copy")]);
		expect(await installationId(join(area, "copy"))).toBe(id);
		expect(await homeBinding(join(area, "copy"))).not.toBe(binding);
		await rename(home, join(area, "away"));
		execFileSync("cp", ["-Rp", join(area, "away"), home]);
		expect(await installationId(home)).toBe(id);
		expect(await homeBinding(home)).not.toBe(binding);
		await rm(home, { recursive: true });
		await rename(join(area, "away"), home);
		expect(await homeBinding(home)).toBe(binding);
	});

	it("makes the id once, the same to callers that race, and refuses a damaged one rather than make another", async () => {
		const home = await tempHome();
		const ids = await Promise.all(Array.from({ length: 8 }, () => installationId(home)));
		expect(new Set(ids).size).toBe(1);
		const [id] = ids as [string];
		// no temporary file is left beside it
		expect(await readdir(join(home, "auth"))).toEqual(["device-id"]);
		const path = join(home, "auth", "device-id");
		// an empty file (a cut write of an older build), a torn one, junk after it: every key is named by the id, so a
		// new one would leave them all out of reach; the file stays as it is for the owner to put back
		for (const damaged of ["", id.slice(0, 20), `${id}x`, "not an id\n"]) {
			await writeFile(path, damaged);
			await expect(installationId(home)).rejects.toThrow(/holds no installation id/);
			expect(await readFile(path, "utf8")).toBe(damaged);
			await expect(signerHome(home)).rejects.toThrow(/holds no installation id/);
		}
		await writeFile(path, `${id}\n`);
		expect(await installationId(home)).toBe(id);
	});

	it("reads the id and makes none for a signer unless told the home holds no wallet: the desktop's refuses (H-261)", async () => {
		const home = await tempHome();
		const refused = await signerHome(home).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(IdentityMissing);
		expect((refused as IdentityMissing).code).toBe("identity");
		expect(existsSync(join(home, "auth", "device-id"))).toBe(false);
		// the wallets' area, whose store holds no wallet yet, makes the id the first wallet is named by
		const made = await signerHome(home, undefined, undefined, { make: true });
		expect(made.id).toBe(await installationId(home));
		expect((await signerHome(home)).id).toBe(made.id);
	});

	it("is never the original's for a restore, even at its path with its folder's inode, as Linux may hand out again", async () => {
		const path = "/home/owner/.banda";
		const folder = { ino: 42n, birthtimeNs: 0n };
		const restore = "a".repeat(64);
		expect(bindingOf(path, folder, "linux", restore)).not.toBe(bindingOf(path, folder, "linux"));
		expect(bindingOf(path, folder, "linux", restore)).toBe(bindingOf(path, folder, "linux", restore));
		expect(bindingOf(path, folder, "linux", "b".repeat(64))).not.toBe(bindingOf(path, folder, "linux", restore));
		// the same folder, the same inode: a restore's marker alone tells it from the home it came from
		const home = join(await tempHome(), "home");
		await mkdir(home);
		const original = await homeBinding(home);
		await writeFile(join(home, RESTORED_MARKER), `${JSON.stringify({ restored: restore })}\n`);
		expect(await homeBinding(home)).not.toBe(original);
		await writeFile(join(home, RESTORED_MARKER), "{}");
		await expect(homeBinding(home)).rejects.toThrow(/not a restore's marker/);
	});

	it("stays while the home's entries are made, renamed and removed, which move its folder's change time", async () => {
		const home = join(await tempHome(), "home");
		await mkdir(home);
		const binding = await homeBinding(home);
		const before = await stat(home, { bigint: true });
		await mkdir(join(home, "auth"));
		// the entries are made, renamed and removed again until the folder's change time has moved past its tick
		await until(async () => {
			await writeFile(join(home, "store.db-wal.tmp"), "x");
			await rename(join(home, "store.db-wal.tmp"), join(home, "store.db-wal"));
			await rm(join(home, "store.db-wal"));
			return (await stat(home, { bigint: true })).ctimeNs !== before.ctimeNs;
		});
		expect(await homeBinding(home)).toBe(binding);
	});

	it("holds no device number, and on Linux no birth time, which Node reports as the change time without statx", () => {
		const path = "/home/owner/.banda";
		const folder = { ino: 42n, birthtimeNs: 1_000n, ctimeNs: 1_000n, dev: 1n };
		for (const platform of ["darwin", "linux", "win32"] as const)
			expect(bindingOf(path, { ...folder, dev: 2n } as typeof folder, platform)).toBe(
				bindingOf(path, folder, platform),
			);
		expect(bindingOf(path, { ...folder, birthtimeNs: 9_000n }, "linux")).toBe(bindingOf(path, folder, "linux"));
		expect(bindingOf(path, { ...folder, birthtimeNs: 9_000n }, "darwin")).not.toBe(bindingOf(path, folder, "darwin"));
		for (const platform of ["darwin", "linux"] as const) {
			expect(bindingOf(path, { ...folder, ino: 43n }, platform)).not.toBe(bindingOf(path, folder, platform));
			expect(bindingOf("/home/owner/copy", folder, platform)).not.toBe(bindingOf(path, folder, platform));
		}
	});
});

describe("the lease", () => {
	it("is taken by compare-and-set on its epoch, and held by the home whose secret it names", async () => {
		const keystore = new MemoryKeystore();
		const home = { id: "h", binding: "a".repeat(64) };
		expect(await leaseOf(keystore, home)).toBeNull();
		expect(await leaseMine(keystore, home, 1)).toBe(false);
		expect(await claimLease(keystore, home, 1)).toBeNull();
		expect(await claimLease(keystore, home, null)).toBe(1);
		expect(await leaseOf(keystore, home)).toEqual({ epoch: 1, mine: true });
		expect(await leaseMine(keystore, home, 1)).toBe(true);
		expect(await claimLease(keystore, home, null)).toBeNull();
		expect(await claimLease(keystore, home, 1)).toBe(2);
		expect(await leaseMine(keystore, home, 1)).toBe(false);
		expect(await leaseMine(keystore, home, 2)).toBe(true);
		const secret = await keystore.read(homeSecretAccount("h"));
		await claimLease(keystore, home, 2);
		expect(await keystore.read(homeSecretAccount("h"))).toBe(secret);
	});

	it("is never this home's for a copy elsewhere, which cannot take it (H-020)", async () => {
		const keystore = new MemoryKeystore();
		const home = { id: "h", binding: "a".repeat(64) };
		const copy = { id: "h", binding: "b".repeat(64) };
		expect(await claimLease(keystore, home, null)).toBe(1);
		expect(await leaseOf(keystore, copy)).toEqual({ epoch: 1, mine: false });
		expect(await leaseMine(keystore, copy, 1)).toBe(false);
		expect(await claimLease(keystore, copy, 1)).toBeNull();
		expect(await leaseMine(keystore, home, 1)).toBe(true);
	});

	it("never makes the home secret again once a lease exists, so no copy can take it when the secret is gone (H-287)", async () => {
		const keystore = new MemoryKeystore();
		const home = { id: "h", binding: "a".repeat(64) };
		const copy = { id: "h", binding: "b".repeat(64) };
		expect(await claimLease(keystore, home, null)).toBe(1);
		expect(await keystore.remove(homeSecretAccount("h"))).toBe(true);
		expect(await claimLease(keystore, copy, 1)).toBeNull();
		expect(await claimLease(keystore, home, 1)).toBeNull();
		expect(await leaseOf(keystore, copy)).toEqual({ epoch: 1, mine: false });
		expect(await leaseOf(keystore, home)).toEqual({ epoch: 1, mine: false });
		expect(await keystore.read(homeSecretAccount("h"))).toBeNull();
		await keystore.write(homeSecretAccount("h"), "planted");
		await expect(claimLease(keystore, copy, 1)).rejects.toBeInstanceOf(Unreadable);
		expect(await keystore.read(homeSecretAccount("h"))).toBe("planted");
	});

	it("is moved to a home whose binding is not the secret's only at the keychain's epoch, and the old home loses it (UC-21)", async () => {
		const keystore = new MemoryKeystore();
		const home = { id: "h", binding: "a".repeat(64) };
		const moved = { id: "h", binding: "b".repeat(64) };
		// a keychain with no lease item (it lost banda's items): the owner's move takes it past the store's epoch (H-286)
		const empty = new MemoryKeystore();
		expect(await moveLease(empty, moved, 4)).toBe(5);
		expect(await leaseOf(empty, moved)).toEqual({ epoch: 5, mine: true });
		expect(await moveLease(empty, { ...moved, fork: true }, 5)).toBeNull();
		expect(await claimLease(keystore, home, null)).toBe(1);
		expect(await moveLease(keystore, moved, 2)).toBeNull();
		expect(await leaseMine(keystore, home, 1)).toBe(true);
		expect(await moveLease(keystore, moved, 1)).toBe(2);
		expect(await leaseOf(keystore, moved)).toEqual({ epoch: 2, mine: true });
		expect(await leaseOf(keystore, home)).toEqual({ epoch: 2, mine: false });
		expect(await claimLease(keystore, home, 2)).toBeNull();
		expect(await claimLease(keystore, moved, 2)).toBe(3);
		expect(await moveLease(keystore, { ...home, fork: true }, 3)).toBeNull();
		expect(await leaseMine(keystore, moved, 3)).toBe(true);
		await keystore.write(homeSecretAccount("h"), "planted");
		await expect(moveLease(keystore, home, 3)).rejects.toBeInstanceOf(Unreadable);
		expect(await keystore.read(homeSecretAccount("h"))).toBe("planted");
	});

	it("is moved to a home whose secret is gone, and makes it the only one that signs (H-287)", async () => {
		const keystore = new MemoryKeystore();
		const home = { id: "h", binding: "a".repeat(64) };
		const moved = { id: "h", binding: "b".repeat(64) };
		expect(await claimLease(keystore, home, null)).toBe(1);
		expect(await keystore.remove(homeSecretAccount("h"))).toBe(true);
		expect(await leaseOf(keystore, home)).toEqual({ epoch: 1, mine: false });
		expect(await moveLease(keystore, moved, 1)).toBe(2);
		expect(await leaseOf(keystore, moved)).toEqual({ epoch: 2, mine: true });
		expect(await leaseOf(keystore, home)).toEqual({ epoch: 2, mine: false });
	});

	it("writes nothing when a key fails its proof, and the home holding it stays online", async () => {
		const keystore = new MemoryKeystore();
		const home = { id: "h", binding: "a".repeat(64) };
		const moved = { id: "h", binding: "b".repeat(64) };
		expect(await claimLease(keystore, home, null)).toBe(1);
		const before = structuredClone(keystore.state.items);
		await expect(
			moveLease(keystore, moved, 1, async () => {
				throw new Error("missing");
			}),
		).rejects.toThrow("missing");
		expect(keystore.state.items).toEqual(before);
		expect(await leaseMine(keystore, home, 1)).toBe(true);
	});

	it("leaves every home offline at the old epoch when stopped between its two writes, and its rerun completes it", async () => {
		const home = { id: "h", binding: "a".repeat(64) };
		const moved = { id: "h", binding: "b".repeat(64) };
		for (const recover of ["move", "claim"] as const) {
			const keystore = new MemoryKeystore();
			expect(await claimLease(keystore, home, null)).toBe(1);
			keystore.state.faults.push({ point: "keychain:write", account: "/lease", throw: "User canceled", times: 1 });
			await expect(moveLease(keystore, moved, 1)).rejects.toMatchObject({ code: "denied" });
			expect(await leaseOf(keystore, home)).toEqual({ epoch: 1, mine: false });
			expect(await leaseOf(keystore, moved)).toEqual({ epoch: 1, mine: false });
			expect(await claimLease(keystore, home, 1)).toBeNull();
			const epoch = recover === "move" ? await moveLease(keystore, moved, 1) : await claimLease(keystore, moved, 1);
			expect(epoch).toBe(2);
			expect(await leaseOf(keystore, moved)).toEqual({ epoch: 2, mine: true });
			expect(await leaseOf(keystore, home)).toEqual({ epoch: 2, mine: false });
		}
	});

	it("is never a fork's, whose marker it carries to its copies (H-283)", async () => {
		const keystore = new MemoryKeystore();
		const fork = { id: "f", binding: "a".repeat(64), fork: true as const };
		expect(await claimLease(keystore, fork, null)).toBeNull();
		expect(await keystore.find("f/")).toEqual([]);
		expect(await claimLease(keystore, { id: "f", binding: fork.binding }, null)).toBe(1);
		expect(await leaseOf(keystore, fork)).toEqual({ epoch: 1, mine: false });
		expect(await claimLease(keystore, fork, 1)).toBeNull();
		const area = await tempHome();
		expect(await isFork(area)).toBe(false);
		await writeFile(join(area, FORK_MARKER), "{}");
		await expect(isFork(area)).rejects.toThrow("not a fork's marker");
	});

	it("tells a test's home by its marker, which tempHome writes, so its signer never opens the keychain (H-031)", async () => {
		const area = await tempHome();
		expect(await isTestHome(area)).toBe(true);
		const home = join(area, "home");
		await mkdir(join(home, "restored"), { recursive: true });
		expect(await isTestHome(home)).toBe(true);
		await installationId(home);
		expect((await signerHome(home)).test).toBe(true);
		expect(await isTestHome(join(home, "restored"))).toBe(true);
		const unmarked = await mkdtemp(join(tmpdir(), "banda-unmarked-"));
		try {
			expect(await isTestHome(unmarked)).toBe(false);
			await installationId(unmarked);
			expect((await signerHome(unmarked)).test).toBeUndefined();
		} finally {
			await rm(unmarked, { recursive: true, force: true });
		}
		await writeFile(join(home, TEST_HOME_MARKER), "{}");
		await expect(isTestHome(home)).rejects.toThrow("not a test home's marker");
	});

	it("refuses a test keystore for a home that is not a test's, which would lose its keys", async () => {
		const area = await tempHome();
		const home = join(area, "plain");
		const elsewhere = join(area, "elsewhere");
		await mkdir(home);
		await mkdir(elsewhere);
		await rm(join(area, TEST_HOME_MARKER));
		for (const keystore of ["1", join(area, "keys.json")])
			await expect(signerHome(home, { BANDA_TEST_KEYSTORE: keystore }, elsewhere)).rejects.toThrow(
				"BANDA_TEST_KEYSTORE is for a test's home",
			);
		await installationId(home);
		expect((await signerHome(home, {}, elsewhere)).test).toBeUndefined();
		expect((await signerHome(home, { BANDA_TEST_KEYSTORE: "1" })).test).toBeUndefined();
		await writeFile(join(home, TEST_HOME_MARKER), JSON.stringify({ test: true }));
		expect((await signerHome(home, { BANDA_TEST_KEYSTORE: "1" }, elsewhere)).test).toBe(true);
	});

	it("refuses a malformed marker on a folder above the home, and reads the nearest marker first", async () => {
		const area = await tempHome();
		await writeFile(join(area, TEST_HOME_MARKER), "{}");
		const home = join(area, "home");
		await mkdir(home);
		await expect(isTestHome(home)).rejects.toThrow("not a test home's marker");
		await expect(signerHome(home)).rejects.toThrow("not a test home's marker");
		await writeFile(join(home, TEST_HOME_MARKER), JSON.stringify({ test: true }));
		expect(await isTestHome(home)).toBe(true);
	});

	it("reads no marker above its upper bound, only the home's own", async () => {
		const area = await tempHome();
		const outside = join(area, "outside");
		const bound = join(area, "bound");
		await mkdir(outside);
		await mkdir(bound);
		await writeFile(join(outside, TEST_HOME_MARKER), JSON.stringify({ test: true }));
		const home = join(outside, "home");
		await mkdir(home);
		expect(await isTestHome(home, bound)).toBe(false);
		expect(await isTestHome(outside, bound)).toBe(true);
		expect(await isTestHome(home, area)).toBe(true);
	});

	it("keeps two homes over one keystore apart", async () => {
		const keystore = new MemoryKeystore();
		const one = { id: "one", binding: "a".repeat(64) };
		const two = { id: "two", binding: "b".repeat(64) };
		expect(await claimLease(keystore, one, null)).toBe(1);
		expect(await claimLease(keystore, two, null)).toBe(1);
		expect(await leaseMine(keystore, one, 1)).toBe(true);
		expect(await leaseMine(keystore, two, 1)).toBe(true);
		expect(await claimLease(keystore, one, 1)).toBe(2);
		expect(await leaseMine(keystore, two, 1)).toBe(true);
	});

	it("never adopts or rewrites an item no banda wrote", async () => {
		const keystore = new MemoryKeystore();
		const home = { id: "h", binding: "a".repeat(64) };
		await keystore.write(leaseAccount("h"), "planted");
		await expect(claimLease(keystore, home, null)).rejects.toBeInstanceOf(Unreadable);
		await expect(leaseMine(keystore, home, 1)).rejects.toBeInstanceOf(Unreadable);
		expect(await keystore.read(leaseAccount("h"))).toBe("planted");
		await keystore.remove(leaseAccount("h"));
		await keystore.write(homeSecretAccount("h"), JSON.stringify({ secret: "x", binding: "a".repeat(64) }));
		await expect(claimLease(keystore, home, null)).rejects.toBeInstanceOf(Unreadable);
		expect(await keystore.read(leaseAccount("h"))).toBeNull();
	});
});

describe("backups, restores and forks (C16)", () => {
	it("carry no home secret, and none of them holds the lease", async () => {
		const area = await tempHome();
		const home = join(area, "home");
		await seed(home);
		await installationId(home);
		const keystore = new FileKeystore(join(area, "keychain.json"));
		const original = await signerHome(home);
		expect(await claimLease(keystore, original, null)).toBe(1);
		const secret = JSON.parse((await keystore.read(homeSecretAccount(original.id))) ?? "{}") as {
			secret: string;
			binding: string;
		};
		const needles = [secret.secret, secret.binding];

		const backup = join(area, "backups", "one");
		await backupHome(home, backup);
		const restored = join(area, "restored");
		await restoreHome(backup, restored, { format: HOME_FORMAT });
		const forked = join(area, "forked");
		await forkHome(home, forked);
		const copy = join(area, "copy");
		execFileSync("cp", ["-Rp", home, copy]);

		for (const output of [backup, restored, forked, copy]) {
			expect((await stat(output)).isDirectory()).toBe(true);
			expect(await holding(output, needles)).toEqual([]);
		}
		expect(await holding(home, needles)).toEqual([]);

		// a restore is marked as one, with a mark of its own each time
		const again = join(area, "again");
		await restoreHome(backup, again, { format: HOME_FORMAT });
		expect(await restoredOf(restored)).toMatch(/^[0-9a-f]{64}$/);
		expect(await restoredOf(again)).not.toBe(await restoredOf(restored));
		expect(await restoredOf(home)).toBeUndefined();
		for (const other of [restored, copy]) {
			const at = await signerHome(other);
			expect(at.id).toBe(original.id);
			expect(await leaseOf(keystore, at)).toEqual({ epoch: 1, mine: false });
			expect(await claimLease(keystore, at, 1)).toBeNull();
		}
		// a fork's id is its own, made at its first use: here, as a daemon on a fork with no wallet would make it
		await installationId(forked);
		const fork = await signerHome(forked);
		expect(fork.id).not.toBe(original.id);
		expect(fork.fork).toBe(true);
		expect(await leaseOf(keystore, fork)).toBeNull();
		expect(await leaseMine(keystore, fork, 1)).toBe(false);
		expect(await claimLease(keystore, fork, null)).toBeNull();
		expect(await keystore.find(`${fork.id}/`)).toEqual([]);
		const copyOfFork = join(area, "copy-of-fork");
		execFileSync("cp", ["-Rp", forked, copyOfFork]);
		expect((await signerHome(copyOfFork)).fork).toBe(true);
		expect(original.fork).toBeUndefined();
		expect(await leaseMine(keystore, original, 1)).toBe(true);
	});
});
