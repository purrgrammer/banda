/**
 * `node scripts/registry-signatures.ts [lockfile...]`: checks every package the lockfiles name, on every platform (the
 * keychain's darwin and win32 packages too, which a Linux `npm ci` never installs), against the npm registry:
 * - the registry serves the integrity hash the lockfile pins;
 * - that hash carries a valid registry signature (ECDSA P-256 over `name@version:integrity`, by a key from
 *   https://registry.npmjs.org/-/npm/v1/keys that was current when the version was published);
 * - when the registry advertises a provenance attestation, it can be fetched and its statements name this version and
 *   this tarball's sha512 digest. The sigstore chain of the attestation is not verified here;
 * - every package of the signing path (the signer's and the keychain's closure in the root tree) advertises one, so a
 *   release published without provenance, as by a phished token, is refused there (H-301).
 * A package the registry cannot vouch for is named in UNVERIFIABLE with the fault, and reported, never skipped silently;
 * the signing path takes no exception.
 * test/supply-chain.test.ts runs these checks against a registry of its own.
 */
import { createPublicKey, verify } from "node:crypto";
import { ids, readLockfile, signingPath } from "./lockfile.ts";
import { getJson } from "./registry-fetch.ts";

const CONCURRENCY = 16;

/** Registry faults seen on a locked version, each checked again on every run and reported while it lasts. */
export const UNVERIFIABLE: Record<string, { attestations: string }> = {
	"openai@7.19.0": {
		attestations: "the attestations endpoint answers a cached text/plain `OK` instead of the attestation bundle",
	},
};

export interface RegistryKey {
	keyid: string;
	key: string;
	expires: string | null;
}

/** The registry asked, at `url`, and the signing keys it published. */
export interface Registry {
	url: string;
	keys: RegistryKey[];
}

export interface Pinned {
	name: string;
	version: string;
	integrity: string;
	/** On the signing path, so it must carry a provenance attestation and no exception excuses a fault in it. */
	attested?: boolean;
}

interface VersionDoc {
	dist?: {
		integrity?: string;
		signatures?: { keyid: string; sig: string }[];
		attestations?: { url: string };
	};
}

interface Statement {
	subject?: { name?: string; digest?: { sha512?: string } }[];
}

const encode = (name: string) => (name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : name);

export async function registryKeys(url: string): Promise<RegistryKey[]> {
	return (await getJson<{ keys: RegistryKey[] }>(`${url}/-/npm/v1/keys`)).keys;
}

/** The packages the lockfiles pin, by `name@version`, and what is wrong with the pins themselves. */
export function pinnedPackages(files: string[]): {
	packages: Map<string, Pinned & { from: string }>;
	failures: string[];
} {
	const packages = new Map<string, Pinned & { from: string }>();
	const failures: string[] = [];
	for (const file of files) {
		for (const p of readLockfile(file)) {
			if (p.bundled) continue;
			const id = `${p.name}@${p.version}`;
			if (!p.integrity) {
				failures.push(`${id} (${file}): no integrity hash in the lockfile`);
				continue;
			}
			const known = packages.get(id);
			if (known && known.integrity !== p.integrity) {
				failures.push(`${id}: ${known.from} and ${file} pin different integrity hashes`);
				continue;
			}
			packages.set(id, { name: p.name, version: p.version, integrity: p.integrity, from: file });
		}
	}
	return { packages, failures };
}

async function publishedAt(registry: Registry, name: string, version: string): Promise<Date> {
	const doc = await getJson<{ time?: Record<string, string> }>(`${registry.url}/${encode(name)}`);
	const time = doc.time?.[version];
	if (!time) throw new Error(`${name}@${version}: the registry has no publish time`);
	return new Date(time);
}

function digestOf(integrity: string): string {
	return Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
}

/** What is wrong with the provenance attestation at `url` for `id`, or undefined when its statements name this tarball. */
export async function checkAttestations(id: string, url: string, integrity: string): Promise<string | undefined> {
	const body = await getJson<{ attestations?: { bundle?: { dsseEnvelope?: { payload?: string } } }[] }>(url);
	const statements = (body.attestations ?? []).map((a) => a.bundle?.dsseEnvelope?.payload);
	if (statements.length === 0) return "the attestation bundle holds no statements";
	const digest = digestOf(integrity);
	const purl = `pkg:npm/${id.replace(/^@/, "%40")}`;
	for (const payload of statements) {
		if (!payload) return "an attestation has no DSSE payload";
		const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Statement;
		const subject = statement.subject?.find((s) => s.name === purl);
		if (!subject) return "an attestation does not name this version";
		if (subject.digest?.sha512 !== digest) return "an attestation names another tarball";
	}
	return undefined;
}

/** What is wrong with one pinned package by the registry's account; empty when it vouches for the pin. */
export async function check(registry: Registry, p: Pinned): Promise<string[]> {
	const id = `${p.name}@${p.version}`;
	const keyById = new Map(registry.keys.map((k) => [k.keyid, k]));
	const problems: string[] = [];
	const doc = await getJson<VersionDoc>(`${registry.url}/${encode(p.name)}/${encodeURIComponent(p.version)}`);
	const dist = doc.dist ?? {};
	if (dist.integrity !== p.integrity)
		return [`the registry serves ${dist.integrity}, the lockfile pins ${p.integrity}`];
	const signatures = dist.signatures ?? [];
	if (signatures.length === 0) problems.push("no registry signature");
	for (const signature of signatures) {
		const key = keyById.get(signature.keyid);
		if (!key) {
			problems.push(`signed by an unknown key ${signature.keyid}`);
			continue;
		}
		if (key.expires !== null && (await publishedAt(registry, p.name, p.version)) >= new Date(key.expires)) {
			problems.push(`signed by ${signature.keyid}, which expired before this version was published`);
			continue;
		}
		const publicKey = createPublicKey({ key: Buffer.from(key.key, "base64"), format: "der", type: "spki" });
		const message = Buffer.from(`${id}:${p.integrity}`);
		if (!verify("sha256", message, publicKey, Buffer.from(signature.sig, "base64"))) {
			problems.push(`an invalid registry signature by ${signature.keyid}`);
		}
	}
	if (dist.attestations?.url) {
		const fault = await checkAttestations(id, dist.attestations.url, p.integrity).catch((e: Error) => e.message);
		if (fault) problems.push(`provenance: ${fault}`);
	} else if (p.attested) {
		problems.push("no provenance attestation, which every package of the signing path must carry");
	}
	return problems;
}

export interface Verdict {
	failures: string[];
	/** Exceptions whose fault is still there, with why. */
	known: string[];
	/** Exceptions that verify now, so their entry can go. */
	cleared: string[];
}

/** Checks every package, an exception excusing only the provenance fault it names, and none on the signing path. */
export async function verifyAll(
	registry: Registry,
	packages: Map<string, Pinned>,
	unverifiable: Record<string, { attestations: string }> = UNVERIFIABLE,
): Promise<Verdict> {
	const queue = [...packages.entries()];
	const verdict: Verdict = { failures: [], known: [], cleared: [] };
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				const [id, p] = next;
				const problems = await check(registry, p).catch((e: Error) => [e.message]);
				const exception = p.attested ? undefined : unverifiable[id];
				const unexplained = problems.filter((problem) => !(exception && problem.startsWith("provenance:")));
				for (const problem of unexplained) verdict.failures.push(`${id}: ${problem}`);
				if (exception && problems.length > unexplained.length) verdict.known.push(`${id}: ${exception.attestations}`);
				else if (exception && problems.length === 0) verdict.cleared.push(id);
			}
		}),
	);
	for (const list of Object.values(verdict)) list.sort();
	return verdict;
}

if (import.meta.main) {
	const url = "https://registry.npmjs.org";
	const files = process.argv.length > 2 ? process.argv.slice(2) : ["package-lock.json"];
	const { packages, failures } = pinnedPackages(files);
	for (const id of ids(signingPath(readLockfile("package-lock.json")))) {
		const p = packages.get(id);
		if (p) p.attested = true;
		else failures.push(`${id}: on the signing path but in none of ${files.join(", ")}`);
	}
	const verdict = await verifyAll({ url, keys: await registryKeys(url) }, packages);
	const all = [...failures, ...verdict.failures].sort();
	console.log(`Registry signatures: ${packages.size} packages from ${files.join(", ")}, ${all.length} failures.`);
	for (const k of verdict.known) console.log(`::warning::provenance not verifiable for ${k}`);
	for (const id of verdict.cleared) console.log(`::notice::${id} verifies now: remove it from UNVERIFIABLE`);
	for (const f of all) console.log(`::error::${f}`);
	if (all.length > 0) process.exit(1);
}
