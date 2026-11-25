/**
 * `node scripts/keychain-binaries.ts <dir> [lockfile]`: fetches the tarball of every keychain platform package the
 * lockfile pins (all platforms, not only this machine's), checks it against the lockfile's sha512, unpacks it under
 * `<dir>` and prints the path of each native module, one per line, for `cargo audit bin` (the modules are built with
 * cargo-auditable, so each carries its Rust dependency list). test/supply-chain.test.ts runs the tarball check.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LockedPackage, readLockfile } from "./lockfile.ts";
import { getBytes } from "./registry-fetch.ts";

/** The keychain's platform packages a lockfile pins. */
export function keychainPlatforms(list: LockedPackage[]): LockedPackage[] {
	return list.filter((p) => p.name.startsWith("@napi-rs/keyring-"));
}

/** The tarball the lockfile pins for `p`, fetched from where it was resolved and refused unless its sha512 matches. */
export async function pinnedTarball(p: LockedPackage): Promise<Buffer> {
	if (!p.resolved || !p.integrity?.startsWith("sha512-")) throw new Error(`${p.path}: no registry tarball or sha512`);
	const tarball = await getBytes(p.resolved);
	const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
	if (integrity !== p.integrity)
		throw new Error(`${p.name}@${p.version}: the tarball is not the one the lockfile pins`);
	return tarball;
}

/** The one native module an unpacked platform package holds, refused when it holds none or several. */
export function nativeModule(p: LockedPackage, files: string[]): string {
	const found = files.filter((name) => name.endsWith(".node"));
	if (found.length !== 1) throw new Error(`${p.name}@${p.version} holds ${found.length} native modules, not one`);
	return found[0];
}

if (import.meta.main) {
	const [dir, file = "package-lock.json"] = process.argv.slice(2);
	if (!dir) throw new Error("usage: node scripts/keychain-binaries.ts <dir> [lockfile]");
	const platforms = keychainPlatforms(readLockfile(file));
	if (platforms.length === 0) throw new Error(`${file} pins no keychain platform package`);
	const modules: string[] = [];
	for (const p of platforms) {
		const tarball = await pinnedTarball(p);
		const into = join(dir, p.name.slice("@napi-rs/".length));
		mkdirSync(into, { recursive: true });
		writeFileSync(`${into}.tgz`, tarball);
		execFileSync("tar", ["-xzf", `${into}.tgz`, "-C", into]);
		modules.push(join(into, "package", nativeModule(p, readdirSync(join(into, "package")))));
	}
	console.log(modules.join("\n"));
}
