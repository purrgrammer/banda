/**
 * The supply-chain scripts of docs/wallets/stack.md section 5 refuse what they should: the registry signature check,
 * the provenance subjects, OSV's advisories, the release-age cooldown and the keychain tarballs, each against a server
 * of the test's own (a registry signing with a P-256 key made here), so a verifier that always passes fails here.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { nativeModule, pinnedTarball } from "../scripts/keychain-binaries.ts";
import type { LockedPackage } from "../scripts/lockfile.ts";
import { ACCEPTED, advisories, auditedPackages, classify, shippedNames } from "../scripts/osv-audit.ts";
import { check, type Pinned, pinnedPackages, type Registry, verifyAll } from "../scripts/registry-signatures.ts";
import { cooldown, excluded, heldPins, tooYoung } from "../scripts/release-age.ts";

interface Answer {
	status?: number;
	type?: string;
	body: string | Buffer;
}

const routes = new Map<string, Answer | ((body: string) => Answer)>();
const posted: unknown[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			if (request.method === "POST") posted.push(JSON.parse(body));
			const route = routes.get(request.url ?? "");
			const answer = typeof route === "function" ? route(body) : (route ?? { status: 404, body: "{}" });
			response.writeHead(answer.status ?? 200, { "content-type": answer.type ?? "application/json" });
			response.end(answer.body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.close();
});

/** Writes lockfiles of the given packages, each `path: entry`, into a temp folder, and hands their paths to `use`. */
function withLockfiles<T>(trees: Record<string, unknown>[], use: (files: string[]) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "banda-lockfiles-"));
	try {
		const files = trees.map((packages, i) => {
			const file = join(dir, `lock-${i}.json`);
			writeFileSync(file, JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } }));
			return file;
		});
		return use(files);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const json = (value: unknown): Answer => ({ body: JSON.stringify(value) });
const integrityOf = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const hexOf = (integrity: string) => Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");

function keyPair() {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	return { privateKey, spki: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}
const current = keyPair();
const expired = keyPair();
const stranger = keyPair();

const registry = (): Registry => ({
	url: base,
	keys: [
		{ keyid: "SHA256:current", key: current.spki, expires: null },
		{ keyid: "SHA256:expired", key: expired.spki, expires: "2024-01-01T00:00:00.000Z" },
	],
});

const signed = (id: string, integrity: string, key: KeyObject) =>
	sign("sha256", Buffer.from(`${id}:${integrity}`), key).toString("base64");

interface Publish {
	served?: string;
	signatures?: { keyid: string; sig: string }[];
	publishedAt?: string;
	attestation?: Answer;
}

/** Publishes `name@version` on the test's registry, signed by the current key unless told otherwise. */
function publish(name: string, version: string, options: Publish = {}): Pinned {
	const integrity = integrityOf(Buffer.from(`${name}@${version}`));
	const id = `${name}@${version}`;
	const path = name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : name;
	const attestations = options.attestation ? { url: `${base}/-/npm/v1/attestations/${path}@${version}` } : undefined;
	if (options.attestation && attestations) routes.set(new URL(attestations.url).pathname, options.attestation);
	routes.set(
		`/${path}/${version}`,
		json({
			dist: {
				integrity: options.served ?? integrity,
				signatures: options.signatures ?? [{ keyid: "SHA256:current", sig: signed(id, integrity, current.privateKey) }],
				...(attestations ? { attestations } : {}),
			},
		}),
	);
	routes.set(`/${path}`, json({ time: { [version]: options.publishedAt ?? "2025-06-01T00:00:00.000Z" } }));
	return { name, version, integrity };
}

const statement = (subject: unknown) => ({
	bundle: {
		dsseEnvelope: { payload: Buffer.from(JSON.stringify({ subject: [subject] })).toString("base64") },
	},
});

describe("the registry signature check (scripts/registry-signatures.ts)", () => {
	test("a version signed by a current key, with an attestation naming its tarball, passes", async () => {
		const integrity = integrityOf(Buffer.from("@scope/good@1.0.0"));
		const p = publish("@scope/good", "1.0.0", {
			attestation: json({
				attestations: [statement({ name: "pkg:npm/%40scope/good@1.0.0", digest: { sha512: hexOf(integrity) } })],
			}),
		});
		expect(await check(registry(), p)).toEqual([]);
	});

	test("an integrity the registry does not serve is refused", async () => {
		const p = publish("swapped", "1.0.0", { served: integrityOf(Buffer.from("other")) });
		expect((await check(registry(), p))[0]).toMatch(/^the registry serves sha512-.*, the lockfile pins sha512-/);
	});

	test("a version without a signature is refused", async () => {
		expect(await check(registry(), publish("unsigned", "1.0.0", { signatures: [] }))).toEqual([
			"no registry signature",
		]);
	});

	test("a signature by a key the registry never published is refused", async () => {
		const p = publish("unknown-key", "1.0.0", { signatures: [{ keyid: "SHA256:nobody", sig: "AA==" }] });
		expect(await check(registry(), p)).toEqual(["signed by an unknown key SHA256:nobody"]);
	});

	test("a signature by a key that expired before the version was published is refused, one before is not", async () => {
		const sig = (id: string) => [
			{ keyid: "SHA256:expired", sig: signed(id, integrityOf(Buffer.from(id)), expired.privateKey) },
		];
		const late = publish("late", "1.0.0", { signatures: sig("late@1.0.0"), publishedAt: "2025-01-01T00:00:00Z" });
		const early = publish("early", "1.0.0", { signatures: sig("early@1.0.0"), publishedAt: "2023-01-01T00:00:00Z" });
		expect(await check(registry(), late)).toEqual([
			"signed by SHA256:expired, which expired before this version was published",
		]);
		expect(await check(registry(), early)).toEqual([]);
	});

	test("a signature that does not verify, by another key or over another integrity, is refused", async () => {
		const forged = publish("forged", "1.0.0", {
			signatures: [{ keyid: "SHA256:current", sig: signed("forged@1.0.0", "sha512-x", stranger.privateKey) }],
		});
		const tampered = publish("tampered", "1.0.0", {
			signatures: [
				{ keyid: "SHA256:current", sig: signed("tampered@1.0.0", integrityOf(Buffer.from("x")), current.privateKey) },
			],
		});
		expect(await check(registry(), forged)).toEqual(["an invalid registry signature by SHA256:current"]);
		expect(await check(registry(), tampered)).toEqual(["an invalid registry signature by SHA256:current"]);
	});

	test.each([
		["names another version", { name: "pkg:npm/attested@2.0.0" }, "an attestation does not name this version"],
		["names another tarball", { name: "pkg:npm/attested@1.0.0", digest: { sha512: "00" } }, "names another tarball"],
	])("an attestation that %s is refused", async (_, subject, fault) => {
		const p = publish("attested", "1.0.0", { attestation: json({ attestations: [statement(subject)] }) });
		expect(await check(registry(), p)).toEqual([expect.stringContaining(fault)]);
	});

	test.each([
		["holds no statements", json({ attestations: [] }), "provenance: the attestation bundle holds no statements"],
		["has no payload", json({ attestations: [{ bundle: {} }] }), "provenance: an attestation has no DSSE payload"],
		["is not JSON", { type: "text/plain", body: "OK" }, "provenance: "],
		["is missing", { status: 404, body: "{}" }, "provenance: "],
	])("an attestation that %s is refused", async (_, answer, fault) => {
		const p = publish("bare-attestation", "1.0.0", { attestation: answer });
		const problems = await check(registry(), p);
		expect(problems).toHaveLength(1);
		expect(problems[0].startsWith(fault)).toBe(true);
	});

	test("a signing-path package without a provenance attestation is refused, one elsewhere is not", async () => {
		const bare = publish("@noble/bare", "1.0.0");
		expect(await check(registry(), { ...bare, attested: true })).toEqual([
			"no provenance attestation, which every package of the signing path must carry",
		]);
		expect(await check(registry(), bare)).toEqual([]);
	});

	test("no exception excuses a provenance fault on the signing path", async () => {
		const p = publish("signer-cached", "1.0.0", { attestation: { type: "text/plain", body: "OK" } });
		const verdict = await verifyAll(registry(), new Map([["signer-cached@1.0.0", { ...p, attested: true }]]), {
			"signer-cached@1.0.0": { attestations: "a cached OK" },
		});
		expect(verdict.failures).toEqual([expect.stringMatching(/^signer-cached@1\.0\.0: provenance: /)]);
		expect(verdict.known).toEqual([]);
	});

	test("an exception excuses only its provenance fault, and one that verifies now is named to remove", async () => {
		const packages = new Map(
			[
				publish("excused", "1.0.0", { attestation: { type: "text/plain", body: "OK" } }),
				publish("fixed", "1.0.0"),
				publish("excused-unsigned", "1.0.0", { signatures: [], attestation: { type: "text/plain", body: "OK" } }),
				publish("plain-unsigned", "1.0.0", { signatures: [] }),
			].map((p) => [`${p.name}@${p.version}`, p]),
		);
		const why = { attestations: "a cached OK" };
		const verdict = await verifyAll(registry(), packages, {
			"excused@1.0.0": why,
			"fixed@1.0.0": why,
			"excused-unsigned@1.0.0": why,
		});
		expect(verdict).toEqual({
			failures: ["excused-unsigned@1.0.0: no registry signature", "plain-unsigned@1.0.0: no registry signature"],
			known: ["excused-unsigned@1.0.0: a cached OK", "excused@1.0.0: a cached OK"],
			cleared: ["fixed@1.0.0"],
		});
	});
});

describe("the pins the registry check reads (scripts/registry-signatures.ts)", () => {
	test("two lockfiles pinning one version to different hashes, and a pin without a hash, are failures", () => {
		const entry = (version: string, integrity?: string) => ({
			version,
			resolved: `https://registry.npmjs.org/a/-/a-${version}.tgz`,
			...(integrity ? { integrity } : {}),
		});
		const one = integrityOf(Buffer.from("one"));
		const two = integrityOf(Buffer.from("two"));
		withLockfiles(
			[
				{ "node_modules/a": entry("1.0.0", one), "node_modules/b": entry("1.0.0", one) },
				{
					"node_modules/a": entry("1.0.0", two),
					"node_modules/b": entry("1.0.0", one),
					"node_modules/c": entry("1.0.0"),
				},
			],
			([first, second]) => {
				const { packages, failures } = pinnedPackages([first, second]);
				expect(failures).toEqual([
					`a@1.0.0: ${first} and ${second} pin different integrity hashes`,
					`c@1.0.0 (${second}): no integrity hash in the lockfile`,
				]);
				expect([...packages.keys()].sort()).toEqual(["a@1.0.0", "b@1.0.0"]);
				expect(packages.get("a@1.0.0")?.integrity).toBe(one);
			},
		);
	});
});

describe("the OSV audit (scripts/osv-audit.ts)", () => {
	test("a package is audited once, as production when any lockfile ships it", () => {
		withLockfiles(
			[
				{ "node_modules/a": { version: "1.0.0", dev: true }, "node_modules/b": { version: "1.0.0", dev: true } },
				{ "node_modules/a": { version: "1.0.0" }, "node_modules/b": { version: "1.0.0", dev: true } },
				{ "node_modules/a": { version: "1.0.0", dev: true } },
			],
			(files) => {
				expect(auditedPackages(files)).toEqual([
					{ name: "a", version: "1.0.0", production: true },
					{ name: "b", version: "1.0.0", production: false },
				]);
			},
		);
	});

	test("a package dev to npm is audited as production when a shipped set of the snapshot names it", () => {
		withLockfiles(
			[
				{
					"node_modules/bundled": { version: "1.0.0", dev: true },
					"node_modules/tool": { version: "1.0.0", dev: true },
				},
			],
			([file]) => {
				const snapshot = join(file, "..", "production-packages.json");
				writeFileSync(snapshot, JSON.stringify({ "web/src (bundled)": ["bundled"], "package-lock.json": [] }));
				expect(auditedPackages([file], shippedNames(snapshot))).toEqual([
					{ name: "bundled", version: "1.0.0", production: true },
					{ name: "tool", version: "1.0.0", production: false },
				]);
				writeFileSync(snapshot, JSON.stringify({ web: "bundled" }));
				expect(() => shippedNames(snapshot)).toThrow("not a record of package-name lists");
			},
		);
	});

	test("every page of every query is read, and accepted, open and stale advisories are told apart", async () => {
		posted.length = 0;
		routes.set("/v1/querybatch", (body) => {
			const { queries } = JSON.parse(body) as { queries: { package: { name: string }; page_token?: string }[] };
			return json({
				results: queries.map((q) =>
					q.package.name !== "busy"
						? {}
						: q.page_token === undefined
							? { vulns: [{ id: "GHSA-1" }], next_page_token: "2" }
							: { vulns: [{ id: "GHSA-2" }] },
				),
			});
		});
		const list = [
			{ name: "busy", version: "1.0.0", production: true },
			{ name: "quiet", version: "1.0.0", production: false },
		];
		const found = await advisories(`${base}/v1/querybatch`, list);
		expect(found.map((f) => `${f.id} ${f.name}@${f.version}`)).toEqual(["GHSA-1 busy@1.0.0", "GHSA-2 busy@1.0.0"]);
		expect(posted).toHaveLength(2);
		expect(posted[1]).toEqual({
			queries: [{ package: { name: "busy", ecosystem: "npm" }, version: "1.0.0", page_token: "2" }],
		});
		const verdict = classify(found, {
			"GHSA-1 busy@1.0.0": { why: "build tooling", production: true },
			"GHSA-9 gone@1.0.0": { why: "fixed upstream", production: false },
		});
		expect(verdict.open.map((f) => f.id)).toEqual(["GHSA-2"]);
		expect(verdict.accepted.map((f) => [f.id, f.why])).toEqual([["GHSA-1", "build tooling"]]);
		expect(verdict.stale).toEqual(["GHSA-9 gone@1.0.0"]);
	});

	test("an advisory accepted for dev only is open once a production tree installs the package", () => {
		const found = [
			{ id: "GHSA-1", name: "tool", version: "1.0.0", production: false },
			{ id: "GHSA-2", name: "shipped", version: "1.0.0", production: true },
			{ id: "GHSA-3", name: "shipped", version: "2.0.0", production: true },
		];
		const verdict = classify(found, {
			"GHSA-1 tool@1.0.0": { why: "build tooling, never shipped", production: false },
			"GHSA-2 shipped@1.0.0": { why: "build tooling, never shipped", production: false },
			"GHSA-3 shipped@2.0.0": { why: "banda never calls the affected function", production: true },
		});
		expect(verdict.accepted.map((f) => f.id)).toEqual(["GHSA-1", "GHSA-3"]);
		expect(verdict.open.map((f) => f.id)).toEqual(["GHSA-2"]);
		expect(verdict.stale).toEqual([]);
	});

	test("every acceptance shipped today is for dev only, and names why", () => {
		for (const [key, entry] of Object.entries(ACCEPTED)) {
			expect(entry.production, key).toBe(false);
			expect(entry.why, key).not.toBe("");
		}
	});

	test("an answer that does not cover every query fails the audit", async () => {
		routes.set("/v1/short", json({ results: [] }));
		await expect(advisories(`${base}/v1/short`, [{ name: "a", version: "1.0.0", production: true }])).rejects.toThrow(
			"OSV answered 0 of 1",
		);
	});
});

describe("the release-age check (scripts/release-age.ts)", () => {
	const now = new Date("2026-06-15T00:00:00.000Z");
	const daysBefore = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

	/** Writes each tree's `.npmrc` and lockfile into a folder of its own, and hands the lockfiles' paths to `use`. */
	async function withTrees<T>(
		trees: { npmrc: string; packages: Record<string, unknown> }[],
		use: (files: string[]) => Promise<T>,
	) {
		const dir = mkdtempSync(join(tmpdir(), "banda-release-age-"));
		try {
			const files = trees.map((tree, i) => {
				mkdirSync(join(dir, `${i}`));
				writeFileSync(join(dir, `${i}`, ".npmrc"), tree.npmrc);
				const file = join(dir, `${i}`, "package-lock.json");
				writeFileSync(file, JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...tree.packages } }));
				return file;
			});
			return await use(files);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("an .npmrc's cooldown and exclusions are read, and one without a cooldown is refused", () => {
		expect(cooldown("# note\nmin-release-age=14\nmin-release-age-exclude[]=@lockstep/*\n")).toEqual({
			days: 14,
			exclude: ["@lockstep/*"],
		});
		expect(() => cooldown("strict-allow-scripts=true\n", "tree/.npmrc")).toThrow("tree/.npmrc: no min-release-age");
		expect(excluded("@lockstep/core", ["@lockstep/*"])).toBe(true);
		expect(excluded("@lockstep/core/x", ["@lockstep/*"])).toBe(false);
		expect(excluded("@lockstep-evil/core", ["@lockstep/*"])).toBe(false);
	});

	test("a pin younger than its tree's cooldown fails, an old one and an excluded young one pass", async () => {
		publish("@scope/fresh", "1.0.1", { publishedAt: daysBefore(3) });
		publish("aged", "2.0.0", { publishedAt: daysBefore(30) });
		publish("edge", "1.0.0", { publishedAt: daysBefore(14) });
		publish("@lockstep/core", "1.0.0", { publishedAt: daysBefore(0.1) });
		publish("slow", "1.0.0", { publishedAt: daysBefore(20) });
		routes.set("/untimed", json({ time: {} }));
		await withTrees(
			[
				{
					npmrc: "min-release-age=14\nmin-release-age-exclude[]=@lockstep/*\n",
					packages: {
						"node_modules/@scope/fresh": { version: "1.0.1", dev: true },
						"node_modules/aged": { version: "2.0.0" },
						"node_modules/edge": { version: "1.0.0" },
						"node_modules/@lockstep/core": { version: "1.0.0" },
						"node_modules/untimed": { version: "1.0.0" },
						"node_modules/aged/node_modules/inner": { version: "1.0.0", inBundle: true },
					},
				},
				{ npmrc: "min-release-age=30\n", packages: { "node_modules/slow": { version: "1.0.0" } } },
			],
			async (files) => {
				const held = heldPins(files);
				expect([...held.keys()].sort()).toEqual([
					"@scope/fresh@1.0.1",
					"aged@2.0.0",
					"edge@1.0.0",
					"slow@1.0.0",
					"untimed@1.0.0",
				]);
				const failures = await tooYoung(base, held, now);
				expect(failures.map((f) => f.split(" ")[0])).toEqual(["@scope/fresh@1.0.1", "slow@1.0.0", "untimed@1.0.0"]);
				expect(failures[0]).toContain("3.0 days ago; the cooldown is 14");
				expect(failures[1]).toContain("the cooldown is 30");
				expect(failures[2]).toContain("the registry has no publish time");
			},
		);
	});

	test("a version two trees pin is held to the longer cooldown", async () => {
		publish("shared", "1.0.0", { publishedAt: daysBefore(20) });
		await withTrees(
			[
				{ npmrc: "min-release-age=14\n", packages: { "node_modules/shared": { version: "1.0.0" } } },
				{ npmrc: "min-release-age=21\n", packages: { "node_modules/shared": { version: "1.0.0" } } },
			],
			async (files) => {
				expect(await tooYoung(base, heldPins(files), now)).toHaveLength(1);
			},
		);
	});
});

describe("the keychain tarballs (scripts/keychain-binaries.ts)", () => {
	const tarball = Buffer.from("a native module");
	const locked = (integrity: string | undefined, resolved = `${base}/keyring.tgz`): LockedPackage => ({
		path: "node_modules/@napi-rs/keyring-linux-x64-gnu",
		name: "@napi-rs/keyring-linux-x64-gnu",
		version: "2.1.2",
		production: true,
		optional: true,
		bundled: false,
		resolved,
		integrity,
		dependencies: {},
		optionalDependencies: {},
		peerDependencies: {},
	});

	test("the pinned tarball is returned, another is refused", async () => {
		routes.set("/keyring.tgz", { type: "application/octet-stream", body: tarball });
		expect(await pinnedTarball(locked(integrityOf(tarball)))).toEqual(tarball);
		await expect(pinnedTarball(locked(integrityOf(Buffer.from("another"))))).rejects.toThrow(
			"@napi-rs/keyring-linux-x64-gnu@2.1.2: the tarball is not the one the lockfile pins",
		);
	});

	test("a platform package holding no native module, or several, is refused", () => {
		const p = locked(undefined);
		expect(nativeModule(p, ["package.json", "keyring.darwin-arm64.node"])).toBe("keyring.darwin-arm64.node");
		expect(() => nativeModule(p, ["package.json"])).toThrow("holds 0 native modules, not one");
		expect(() => nativeModule(p, ["a.node", "b.node"])).toThrow(
			"@napi-rs/keyring-linux-x64-gnu@2.1.2 holds 2 native modules, not one",
		);
	});

	test("a package without a sha512 pin is refused before anything is fetched", async () => {
		await expect(pinnedTarball(locked("sha1-abc"))).rejects.toThrow("no registry tarball or sha512");
		await expect(pinnedTarball(locked(undefined))).rejects.toThrow("no registry tarball or sha512");
	});
});
