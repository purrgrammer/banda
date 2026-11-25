/**
 * The packages a package-lock.json installs, read for the supply-chain checks: test/wallet-deps.test.ts holds the
 * production tree to its rules, scripts/osv-audit.ts asks OSV about every package and scripts/registry-signatures.ts
 * checks each one's registry signature.
 */
import { readFileSync } from "node:fs";

export interface LockedPackage {
	/** Where npm installs it, `node_modules/a/node_modules/b`. */
	path: string;
	name: string;
	version: string;
	/** Installed by `npm ci --omit=dev` too. */
	production: boolean;
	optional: boolean;
	/** Shipped inside its parent's tarball, so neither fetched nor signed on its own. */
	bundled: boolean;
	resolved?: string;
	integrity?: string;
	dependencies: Record<string, string>;
	optionalDependencies: Record<string, string>;
	/** The peers npm must install beside it, optional ones left out. */
	peerDependencies: Record<string, string>;
}

interface LockEntry {
	name?: string;
	version?: string;
	dev?: boolean;
	optional?: boolean;
	link?: boolean;
	inBundle?: boolean;
	resolved?: string;
	integrity?: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export function readLockfile(file: string): LockedPackage[] {
	return parseLockfile(readFileSync(file, "utf8"), file);
}

export function parseLockfile(text: string, file = "lockfile"): LockedPackage[] {
	const lock = JSON.parse(text) as { lockfileVersion: number; packages: Record<string, LockEntry> };
	if (lock.lockfileVersion < 2) throw new Error(`${file}: lockfileVersion ${lock.lockfileVersion} has no packages map`);
	const out: LockedPackage[] = [];
	for (const [path, entry] of Object.entries(lock.packages)) {
		const at = path.lastIndexOf("node_modules/");
		if (at < 0 || entry.link || entry.version === undefined) continue;
		out.push({
			path,
			name: entry.name ?? path.slice(at + "node_modules/".length),
			version: entry.version,
			production: entry.dev !== true,
			optional: entry.optional === true,
			bundled: entry.inBundle === true,
			resolved: entry.resolved,
			integrity: entry.integrity,
			dependencies: entry.dependencies ?? {},
			optionalDependencies: entry.optionalDependencies ?? {},
			peerDependencies: Object.fromEntries(
				Object.entries(entry.peerDependencies ?? {}).filter(
					([peer]) => entry.peerDependenciesMeta?.[peer]?.optional !== true,
				),
			),
		});
	}
	return out;
}

/** The entry node would load for `name` when required from the package at `from` (node_modules lookup upwards). */
export function resolveFrom(
	packages: Map<string, LockedPackage>,
	from: string,
	name: string,
): LockedPackage | undefined {
	let base = from;
	for (;;) {
		const found = packages.get(`${base === "" ? "" : `${base}/`}node_modules/${name}`);
		if (found) return found;
		if (base === "") return undefined;
		const at = base.lastIndexOf("/node_modules/");
		base = at < 0 ? "" : base.slice(0, at);
	}
}

/**
 * Every package `roots` pull in, themselves included, following dependencies, optional dependencies and required peers
 * (a peer npm did not install is left out, as node would fail to load it).
 */
export function closure(all: LockedPackage[], roots: string[]): LockedPackage[] {
	const byPath = new Map(all.map((p) => [p.path, p]));
	const seen = new Map<string, LockedPackage>();
	const visit = (from: string, name: string, optional: boolean) => {
		const found = resolveFrom(byPath, from, name);
		if (!found) {
			if (optional) return;
			throw new Error(`${name}, required from ${from === "" ? "the root" : from}, is not in the lockfile`);
		}
		if (seen.has(found.path)) return;
		seen.set(found.path, found);
		for (const dep of Object.keys(found.dependencies)) visit(found.path, dep, false);
		for (const dep of Object.keys(found.optionalDependencies)) visit(found.path, dep, true);
		for (const dep of Object.keys(found.peerDependencies)) visit(found.path, dep, true);
	};
	for (const root of roots) visit("", root, false);
	return [...seen.values()];
}

/** The signer's packages, pinned exactly in the daemon's production tree. */
export const SIGNING = { "@noble/curves": "2.4.0", "@noble/hashes": "2.4.0", "micro-eth-signer": "0.20.1" };

/** The keychain module, pinned exactly in the daemon's production tree; its platform packages come with it. */
export const KEYCHAIN = { "@napi-rs/keyring": "2.1.2" };

/** The packages that hold or touch the key, every one of which must carry a provenance attestation (H-301). */
export const signingPath = (all: LockedPackage[]) => closure(all, [...Object.keys(SIGNING), ...Object.keys(KEYCHAIN)]);

/**
 * Names the payer path never ships: the x402 SDKs (v1 and v2), viem, ox, ethers (v5's `@ethersproject/*` too) and
 * keytar, unscoped look-alikes and the same names under any scope included.
 */
export const FORBIDDEN_IN_PRODUCTION =
	/^(@x402\/.*|x402(-.*)?|viem|ox|ethers(-.*)?|keytar|@ethersproject\/.*|@[^/]+\/(viem|ox|ethers|keytar))$/;

export const ids = (list: LockedPackage[]) => list.map((p) => `${p.name}@${p.version}`).sort();

/** Every locked copy of `name`, as `name@version`. */
export const copies = (list: LockedPackage[], name: string) => ids(list.filter((p) => p.name === name));

/** What `npm ci --omit=dev` installs. */
export const production = (list: LockedPackage[]) => list.filter((p) => p.production);

/** The forbidden names in a shipped set: a production tree, or a bundle's closure (whose packages may be dev). */
export const forbidden = (shipped: LockedPackage[]) => ids(shipped.filter((p) => FORBIDDEN_IN_PRODUCTION.test(p.name)));

/** Shipped packages not fetched from the npm registry or not locked by a sha512 integrity hash, by path. */
export const unverified = (shipped: LockedPackage[]) =>
	shipped
		.filter((p) => !p.resolved?.startsWith("https://registry.npmjs.org/") || !p.integrity?.startsWith("sha512-"))
		.map((p) => p.path);

/**
 * The copies of `name` in any shipped set that are not `version`, as `set: name@version`: the one curve library and the
 * one hash library may ship only at the version the signer pins, whichever set carries them (H-308).
 */
export const strayCopies = (shipped: Record<string, LockedPackage[]>, name: string, version: string) =>
	Object.entries(shipped).flatMap(([set, list]) =>
		copies(list, name)
			.filter((id) => id !== `${name}@${version}`)
			.map((id) => `${set}: ${id}`),
	);

/** The distinct names a shipped set holds. */
export const names = (shipped: LockedPackage[]) => [...new Set(shipped.map((p) => p.name))].sort();
