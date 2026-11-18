/**
 * What a release's corresponding-source and notice set is: its pinned native inputs, the parsers that read what a
 * built computer contains, deterministic tar bytes, and the index that binds the set to the release's downloads by
 * SHA-256. Nothing here fetches or writes; scripts/release-sources.ts collects, and both it and the publish job verify
 * through `verifyReleaseMaterials`.
 */
import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { MICROVM_SOURCE } from "../src/box/microvm-assets.ts";

/** The firmware Microsandbox 0.7.14 pins as `vendor/libkrunfw`, and the kernel that commit's Makefile builds. */
export const FIRMWARE_SOURCE = {
	repository: "superradcompany/libkrunfw",
	commit: "223f11693774646eaa8ba892e3a6ebd07653154b",
	archiveSha256: "a31ad9ccaeb6504bc62b6f1e95408c155aec26e74dd255ab38bbc84b108bf3b3",
	kernel: {
		version: "linux-6.12.115",
		url: "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.115.tar.gz",
		sha256: "2ec6ffc2120e6892ec6cb94142aafe218054eee5ebc6b5283deda2e74bae22df",
	},
} as const;

/**
 * The Electron the desktop app is built on (desktop/package.json pins the same version), and the FFmpeg inside it.
 * Electron ships FFmpeg as a shared library of its own, under the LGPL, so its source is part of a release's set:
 * Chromium's fork at the commit the DEPS file of Electron's Chromium names, with the patches in Electron's own tree
 * (`patches/ffmpeg`). Chromium's host serves no archive with stable bytes, so that one is pinned by a digest of its
 * members (`treeSha256`).
 */
export const ELECTRON_SOURCE = {
	version: "45.2.3",
	commit: "d0a18d02058b21ff292e25d5f53f00bd120f2f61",
	archiveSha256: "ad1d01af65c3596f8751091bb7a02c03c90a379cb4106229ef2c0003921dfdb1",
	chromium: {
		version: "156.0.8078.80",
		depsUrl: "https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.80/DEPS?format=TEXT",
		depsSha256: "c4d60cae7b46d4ae476e3409226d89bf72c1fd61e1d97d64027ebae4356f23ae",
	},
	ffmpeg: {
		commit: "9db86ce5b5b454dfc96c435f9f0723012980c37f",
		url: "https://chromium.googlesource.com/chromium/third_party/ffmpeg/+archive/9db86ce5b5b454dfc96c435f9f0723012980c37f.tar.gz",
		treeSha256: "cb648af4bc1ee57bc26a60016d8f9ff7a8c1a3ad26e25b7a71b166165bea2d46",
	},
} as const;

/** Python distributions PyPI publishes without a source archive: their upstream tag, pinned by hash. */
export const PYTHON_UPSTREAM_SOURCES: Readonly<Record<string, { url: string; file: string; sha256: string }>> = {
	"mitmproxy 12.2.3": {
		url: "https://codeload.github.com/mitmproxy/mitmproxy/tar.gz/refs/tags/v12.2.3",
		file: "mitmproxy-12.2.3.tar.gz",
		sha256: "39073f414cdb9a0bf438b875da0e79bb306bcb7d1331b580763886f509f78c1b",
	},
};

export const SHARD_LIMIT = 1_900_000_000;
export const RELEASE_TARGETS = ["darwin-arm64", "linux-x64"] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

/** Why the set is what it is, and what it leaves out. The index carries these lines, so a reader never has to infer. */
export const LIMITS = [
	"This set was assembled by the release workflow. No person reviewed it before publication.",
	"Debian source packages come from snapshot.debian.org by source name and version. Each file is checked against the SHA-256 and size its .dsc records; the .dsc is checked against the hash snapshot.debian.org's index gives. The .dsc's OpenPGP signature is not verified.",
	"Python source archives are checked against the SHA-256 PyPI's index gives. PyPI's attestations are not verified.",
	"Rust crates are the registry packages of the pinned Cargo.lock, checked against its checksums. The lock names more packages than the build compiles.",
	"The firmware binary comes from Microsandbox's release archive, pinned by hash. Its source, patches, configuration and the kernel it names are included; building them is not shown to reproduce the binary.",
	"Not included: source for CPython in the proxy image, for pi-env and for the guest agent's C library; the Rust toolchain and the manylinux build image, which the installed manifest identifies by hash; source for Node.js and Chromium, whose license files ship inside the application.",
	"The FFmpeg library in the desktop packages is Electron's own build. Its source here is Chromium's fork at the commit the DEPS file of Electron's Chromium names, beside Electron's source, whose patches/ffmpeg Electron applies to it. Building it needs Chromium's build system, which is not included, and is not shown to reproduce the library. Chromium's host serves no archive with stable bytes, so this one is checked by a digest of its members.",
	"Packages statically linked into a Debian binary package are covered only when the image's package database names their source.",
	"Each computer's manifest is read from its command-line archive. The desktop packages are built in the same job from the same staged files and are bound here by their own SHA-256; their contents are not opened.",
] as const;

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const bytes = Type.Integer({ minimum: 0 });
const fileName = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._+~-]*$", maxLength: 200 });
const memberPath = Type.String({ pattern: "^materials/[A-Za-z0-9._+~-]+(?:/[A-Za-z0-9._+~-]+)+$", maxLength: 255 });
const text = Type.String({ minLength: 1, maxLength: 300 });

const Package = Type.Object(
	{ name: text, version: text, source: text, sourceVersion: text },
	{ additionalProperties: false },
);
const Image = Type.Object(
	{
		role: Type.Union([Type.Literal("box"), Type.Literal("proxy"), Type.Literal("browser")]),
		sha256: hash,
		digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
		packages: Type.Array(Package, { minItems: 1 }),
		python: Type.Array(Type.Object({ name: text, version: text }, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);
const Download = Type.Object(
	{
		file: fileName,
		kind: Type.Union([Type.Literal("desktop"), Type.Literal("cli"), Type.Literal("browser")]),
		bytes,
		sha256: hash,
	},
	{ additionalProperties: false },
);
const Source = Type.Object(
	{
		kind: Type.Union([
			Type.Literal("application"),
			Type.Literal("microsandbox"),
			Type.Literal("runtime-patch"),
			Type.Literal("firmware"),
			Type.Literal("kernel"),
			Type.Literal("electron"),
			Type.Literal("ffmpeg"),
			Type.Literal("crate"),
			Type.Literal("debian"),
			Type.Literal("python"),
		]),
		name: text,
		version: text,
		files: Type.Array(memberPath, { minItems: 1 }),
	},
	{ additionalProperties: false },
);
export const ReleaseMaterials = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		version: Type.String({ pattern: "^[A-Za-z0-9._-]+$" }),
		sourceCommit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
		/** A build cannot have been reviewed before it exists, so the workflow can only ever write this value. */
		review: Type.Object({ status: Type.Literal("unreviewed"), statement: text }, { additionalProperties: false }),
		cargo: Type.Object(
			{ lockSha256: hash, registryPackages: Type.Integer({ minimum: 1 }) },
			{ additionalProperties: false },
		),
		targets: Type.Array(
			Type.Object(
				{
					target: Type.Union([Type.Literal("darwin-arm64"), Type.Literal("linux-x64")]),
					manifestSha256: hash,
					msbSha256: hash,
					firmwareSha256: hash,
					patchSha256: hash,
					downloads: Type.Array(Download, { minItems: 1 }),
					images: Type.Array(Image, { minItems: 3, maxItems: 3 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		sources: Type.Array(Source, { minItems: 1 }),
		materials: Type.Array(
			Type.Object({ path: memberPath, bytes, sha256: hash, asset: fileName }, { additionalProperties: false }),
			{ minItems: 1 },
		),
		assets: Type.Array(
			Type.Object(
				{
					file: fileName,
					kind: Type.Union([Type.Literal("source-shard"), Type.Literal("notices"), Type.Literal("instructions")]),
					bytes,
					sha256: hash,
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		limits: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	},
	{ additionalProperties: false },
);
export type ReleaseMaterials = Static<typeof ReleaseMaterials>;
export type MaterialSource = Static<typeof Source>;
export type ImageInventory = Static<typeof Image>;
export type InstalledPackage = Static<typeof Package>;

export const INDEX_FILE = "release-materials.json";
export const shardName = (version: string, index: number) =>
	`banda-${version}-sources-${String(index + 1).padStart(2, "0")}.tar`;
export const noticesName = (version: string) => `banda-${version}-notices.tar`;
export const INSTRUCTIONS_FILE = "RELEASE-SOURCES.md";
export const FFMPEG_MATERIAL = `materials/native/ffmpeg-${ELECTRON_SOURCE.ffmpeg.commit}.tar.gz`;

/** Whether a file at a package's top level is a license or notice text, by its name. */
export const noticeFile = (name: string) => /^(?:LICEN[CS]E|COPYING|COPYRIGHT|NOTICE|UNLICEN[CS]E|PATENTS)/i.test(name);

/** The Chromium version an Electron source tree's DEPS file builds on. */
export function electronChromium(deps: string): string {
	const version = /'chromium_version':\s*'([0-9]+(?:\.[0-9]+){3})'/.exec(deps)?.[1];
	if (version === undefined) throw new Error("Electron's DEPS names no Chromium version.");
	return version;
}

/** The commit of its FFmpeg fork a Chromium DEPS file checks out. */
export function chromiumFfmpeg(deps: string): string {
	const revision = /'ffmpeg_revision':\s*'([a-f0-9]{40})'/.exec(deps)?.[1];
	const checkout =
		/'src\/third_party\/ffmpeg':\s*Var\('chromium_git'\) \+ '\/chromium\/third_party\/ffmpeg\.git' \+ '@' \+ Var\('ffmpeg_revision'\)/;
	if (revision === undefined || !checkout.test(deps)) throw new Error("Chromium's DEPS names no FFmpeg revision.");
	return revision;
}

/** The downloads that carry a computer, so each needs its sources bound: by release file name. */
export function downloadKind(
	file: string,
): { kind: "desktop" | "cli" | "browser"; target?: ReleaseTarget } | undefined {
	if (/^banda-browser-[a-f0-9]{64}\.tar$/.test(file)) return { kind: "browser" };
	const cli = /^banda-cli-.+-(mac-arm64|linux-x64)\.tar\.gz$/.exec(file);
	if (cli) return { kind: "cli", target: cli[1] === "mac-arm64" ? "darwin-arm64" : "linux-x64" };
	if (/^banda-.+-mac-arm64\.(?:dmg|zip)$/.test(file)) return { kind: "desktop", target: "darwin-arm64" };
	if (/^banda-.+-linux-amd64\.deb$/.test(file)) return { kind: "desktop", target: "linux-x64" };
	return undefined;
}

export type FileIdentity = { readonly bytes: number; readonly sha256: string };

/**
 * Whether a folder of release files is one whole, bound set: every download that carries a computer is named by the
 * index with its exact bytes, every material the index names is present with its exact bytes, and each computer's
 * native inputs, crates, Debian packages and Python distributions have their sources. Returns what is wrong; an empty
 * list is the only pass.
 */
export function verifyReleaseMaterials(value: unknown, files: ReadonlyMap<string, FileIdentity>): string[] {
	if (!Value.Check(ReleaseMaterials, value)) return ["The release materials index is invalid."];
	const problems: string[] = [];
	const same = (entry: { file: string; bytes: number; sha256: string }, what: string) => {
		const actual = files.get(entry.file);
		if (actual === undefined) problems.push(`${what} ${entry.file} is missing.`);
		else if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
			problems.push(`${what} ${entry.file} differs from the index.`);
	};
	const unique = (names: readonly string[], what: string) => {
		if (new Set(names).size !== names.length) problems.push(`The index names ${what} twice.`);
	};

	for (const asset of value.assets) same(asset, "Material");
	unique(
		value.assets.map((asset) => asset.file),
		"an asset",
	);
	const listed = new Set(value.assets.map((asset) => asset.file));
	for (const kind of ["notices", "instructions"] as const)
		if (value.assets.filter((asset) => asset.kind === kind).length !== 1)
			problems.push(`The index must name exactly one ${kind} asset.`);
	for (const name of files.keys())
		if (/-sources-\d+\.tar$|-notices\.tar$/.test(name) && !listed.has(name))
			problems.push(`${name} is not named by the index.`);

	unique(
		value.targets.map((entry) => entry.target),
		"a target",
	);
	for (const target of RELEASE_TARGETS)
		if (!value.targets.some((entry) => entry.target === target)) problems.push(`The index has no ${target} target.`);
	const bound = new Set<string>();
	for (const target of value.targets) {
		for (const download of target.downloads) {
			same(download, "Download");
			bound.add(download.file);
			const kind = downloadKind(download.file);
			if (kind?.kind !== download.kind || (kind.target !== undefined && kind.target !== target.target))
				problems.push(`${download.file} is not a ${target.target} ${download.kind} download.`);
		}
		for (const kind of ["cli", "desktop"] as const)
			if (!target.downloads.some((download) => download.kind === kind))
				problems.push(`${target.target} has no ${kind} download.`);
		if (target.downloads.filter((download) => download.kind === "browser").length !== 1)
			problems.push(`${target.target} must name exactly one browser archive.`);
		unique(
			target.images.map((image) => image.role),
			`a ${target.target} image`,
		);
	}
	for (const name of files.keys())
		if (downloadKind(name) !== undefined && !bound.has(name))
			problems.push(`${name} carries a computer and no target in the index names it.`);

	const shards = new Set(value.assets.filter((asset) => asset.kind === "source-shard").map((asset) => asset.file));
	const materials = new Map(value.materials.map((material) => [material.path, material]));
	unique(
		value.materials.map((material) => material.path),
		"a material",
	);
	for (const material of value.materials)
		if (!shards.has(material.asset)) problems.push(`${material.path} is in no source shard of the index.`);
	const referenced = new Set<string>();
	for (const source of value.sources)
		for (const path of source.files) {
			referenced.add(path);
			if (!materials.has(path)) problems.push(`${source.kind} ${source.name} ${source.version} lacks ${path}.`);
		}
	for (const path of materials.keys())
		if (!referenced.has(path)) problems.push(`${path} belongs to no source in the index.`);
	unique(
		value.sources.map((source) => `${source.kind} ${source.name} ${source.version}`),
		"a source",
	);

	const pinned = (kind: MaterialSource["kind"], sha256: string) => {
		const found = value.sources.filter((source) => source.kind === kind);
		const [only] = found;
		if (found.length !== 1 || only === undefined || only.files.length !== 1)
			return problems.push(`The index must name exactly one ${kind} source file.`);
		const material = materials.get(only.files[0] ?? "");
		if (material !== undefined && material.sha256 !== sha256)
			problems.push(`The ${kind} source differs from its pinned SHA-256.`);
	};
	pinned("microsandbox", MICROVM_SOURCE.archiveSha256);
	pinned("firmware", FIRMWARE_SOURCE.archiveSha256);
	pinned("kernel", FIRMWARE_SOURCE.kernel.sha256);
	pinned("electron", ELECTRON_SOURCE.archiveSha256);
	const ffmpeg = value.sources.filter((source) => source.kind === "ffmpeg");
	if (ffmpeg.length !== 1 || ffmpeg[0]?.version !== ELECTRON_SOURCE.ffmpeg.commit)
		problems.push("The index must name exactly one ffmpeg source, at the commit Electron's Chromium pins.");
	else if (!ffmpeg[0].files.includes(FFMPEG_MATERIAL)) problems.push(`The ffmpeg source lacks ${FFMPEG_MATERIAL}.`);
	if (value.sources.filter((source) => source.kind === "application").length !== 1)
		problems.push("The index must name exactly one application source.");
	const patches = new Set(
		value.sources
			.filter((source) => source.kind === "runtime-patch")
			.flatMap((source) => source.files.map((path) => materials.get(path)?.sha256)),
	);
	for (const target of value.targets)
		if (!patches.has(target.patchSha256)) problems.push(`${target.target}'s runtime patch is not in the set.`);
	if (value.cargo.lockSha256 !== MICROVM_SOURCE.lockSha256)
		problems.push("The crates were collected for a different Cargo.lock.");
	if (value.sources.filter((source) => source.kind === "crate").length !== value.cargo.registryPackages)
		problems.push("The set does not hold every registry package of the Cargo.lock.");

	const has = (kind: "debian" | "python", name: string, version: string) =>
		value.sources.find((source) => source.kind === kind && source.name === name && source.version === version);
	for (const target of value.targets)
		for (const image of target.images) {
			for (const entry of image.packages) {
				const source = has("debian", entry.source, entry.sourceVersion);
				if (source === undefined || !source.files.some((path) => path.endsWith(".dsc")))
					problems.push(
						`${target.target} ${image.role}: ${entry.name} ${entry.version} has no Debian source ${entry.source} ${entry.sourceVersion}.`,
					);
			}
			for (const entry of image.python)
				if (has("python", entry.name, entry.version) === undefined)
					problems.push(`${target.target} ${image.role}: Python ${entry.name} ${entry.version} has no source.`);
		}
	return problems;
}

/** The registry packages a Cargo.lock pins, each with the checksum crates.io serves it under. */
export function lockCrates(lock: string): { name: string; version: string; sha256: string }[] {
	const crates: { name: string; version: string; sha256: string }[] = [];
	for (const block of lock.split(/^\[\[package\]\]$/m).slice(1)) {
		const field = (name: string) => new RegExp(`^${name} = "([^"\\n]*)"$`, "m").exec(block)?.[1];
		const name = field("name");
		const version = field("version");
		const source = field("source");
		const checksum = field("checksum");
		if (
			name === undefined ||
			version === undefined ||
			!/^[A-Za-z0-9_-]+$/.test(name) ||
			!/^[A-Za-z0-9.+-]+$/.test(version)
		)
			throw new Error("The Cargo.lock has a package without a plain name and version.");
		if (source === undefined) continue; // a workspace member: its source is the pinned tree itself
		if (source !== "registry+https://github.com/rust-lang/crates.io-index")
			throw new Error(`${name} ${version} comes from ${source}, which has no pinned checksum.`);
		if (checksum === undefined || !/^[a-f0-9]{64}$/.test(checksum))
			throw new Error(`${name} ${version} has no checksum in the Cargo.lock.`);
		crates.push({ name, version, sha256: checksum });
	}
	if (crates.length === 0) throw new Error("The Cargo.lock names no registry package.");
	return crates;
}

/** The installed packages of a dpkg status file, each with the source package and version it was built from. */
export function dpkgPackages(status: string): InstalledPackage[] {
	const packages: InstalledPackage[] = [];
	for (const paragraph of status.split(/\n\n+/)) {
		const fields = new Map<string, string>();
		for (const line of paragraph.split("\n")) {
			const match = /^([A-Za-z0-9-]+): (.*)$/.exec(line);
			if (match?.[1] !== undefined && match[2] !== undefined) fields.set(match[1], match[2]);
		}
		if (fields.get("Status") !== "install ok installed") continue;
		const name = fields.get("Package");
		const version = fields.get("Version");
		const source = /^(\S+)(?: \((\S+)\))?$/.exec(fields.get("Source") ?? name ?? "");
		if (name === undefined || version === undefined || source?.[1] === undefined)
			throw new Error("The image's package database has an entry without a name, version or source.");
		packages.push({ name, version, source: source[1], sourceVersion: source[2] ?? version });
	}
	if (packages.length === 0) throw new Error("The image's package database names no installed package.");
	return packages;
}

/** The files a Debian source control file binds, by the SHA-256 and size it records for each. */
export function dscFiles(dsc: string): { name: string; bytes: number; sha256: string }[] {
	const lines = dsc.split("\n");
	const start = lines.indexOf("Checksums-Sha256:");
	const files: { name: string; bytes: number; sha256: string }[] = [];
	for (const line of start < 0 ? [] : lines.slice(start + 1)) {
		const match = /^ ([a-f0-9]{64}) (\d+) ([A-Za-z0-9][A-Za-z0-9._+~-]*)$/.exec(line);
		if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) break;
		files.push({ name: match[3], bytes: Number(match[2]), sha256: match[1] });
	}
	if (files.length === 0) throw new Error("The Debian source control file records no SHA-256 checksums.");
	return files;
}

/** A Python distribution's name and version, as its installed METADATA states them. */
export function pythonDistribution(metadata: string): { name: string; version: string; license: string } {
	const headers = metadata.split(/\r?\n\r?\n/, 1)[0] ?? "";
	const field = (name: string) => new RegExp(`^${name}: (.+?)\\r?$`, "m").exec(headers)?.[1]?.trim();
	const name = field("Name");
	const version = field("Version");
	if (
		name === undefined ||
		version === undefined ||
		!/^[A-Za-z0-9._-]+$/.test(name) ||
		!/^[A-Za-z0-9.+!_-]+$/.test(version)
	)
		throw new Error("A Python distribution in the image has no plain name and version.");
	return { name, version, license: field("License-Expression") ?? field("License") ?? "" };
}

/** A folder name for a Debian source: the epoch's colon is not a portable file name character. */
export const debianFolder = (source: string, version: string) => `${source}_${version.replace(":", "_")}`;

function octal(value: number, length: number): string {
	const digits = value.toString(8);
	if (digits.length > length - 1) throw new Error("A tar member is too large for its header.");
	return `${digits.padStart(length - 1, "0")}\0`;
}

/** One regular file's USTAR header with fixed metadata, so the same members always make the same bytes. */
export function tarHeader(path: string, size: number): Buffer {
	let name = path;
	let prefix = "";
	if (Buffer.byteLength(path) > 100) {
		const cut = path.split("/").reduce((at, _part, index, parts) => {
			const head = parts.slice(0, index).join("/");
			const tail = parts.slice(index).join("/");
			return index > 0 && Buffer.byteLength(head) <= 155 && Buffer.byteLength(tail) <= 100 && at < 0 ? index : at;
		}, -1);
		if (cut < 0) throw new Error(`${path} is too long for a portable tar member.`);
		const parts = path.split("/");
		prefix = parts.slice(0, cut).join("/");
		name = parts.slice(cut).join("/");
	}
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write("0000644\0", 100, 8, "ascii");
	header.write("0000000\0", 108, 8, "ascii");
	header.write("0000000\0", 116, 8, "ascii");
	header.write(octal(size, 12), 124, 12, "ascii");
	header.write(octal(0, 12), 136, 12, "ascii");
	header.write("        ", 148, 8, "ascii");
	header.write("0", 156, 1, "ascii");
	header.write("ustar\x0000", 257, 8, "ascii");
	header.write(prefix, 345, 155, "utf8");
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	return header;
}

export const tarPadding = (size: number) => (512 - (size % 512)) % 512;

/** Members in path order, cut into archives that each stay under `limit` bytes, headers and end blocks included. */
export function planShards<T extends { path: string; bytes: number }>(
	members: readonly T[],
	limit = SHARD_LIMIT,
): T[][] {
	const shards: T[][] = [];
	let room = 0;
	for (const member of [...members].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		const cost = 512 + member.bytes + tarPadding(member.bytes);
		if (cost + 1024 > limit) throw new Error(`${member.path} does not fit in one release asset.`);
		if (cost > room) {
			shards.push([]);
			room = limit - 1024;
		}
		shards.at(-1)?.push(member);
		room -= cost;
	}
	return shards;
}

export type TarEntry = {
	readonly path: string;
	readonly type: "file" | "link" | "symlink" | "directory" | "other";
	readonly size: number;
	readonly linkname: string;
	/** Where the member's bytes start in the stream, so a file's member can be read again by range. */
	readonly offset: number;
	/** The member's bytes; at most once, and before the next entry is asked for. */
	bytes(): Promise<Buffer>;
};

type ByteSource = { read(length: number): Promise<Buffer>; skip(length: number): Promise<void> };

function byteSource(stream: AsyncIterable<Buffer> | Iterable<Buffer>): ByteSource {
	const iterator = Symbol.asyncIterator in stream ? stream[Symbol.asyncIterator]() : stream[Symbol.iterator]();
	let chunks: Buffer[] = [];
	let available = 0;
	const fill = async (length: number) => {
		while (available < length) {
			const next = await iterator.next();
			if (next.done) return false;
			chunks.push(next.value);
			available += next.value.length;
		}
		return true;
	};
	return {
		async read(length) {
			if (!(await fill(length))) {
				if (available === 0) return Buffer.alloc(0);
				throw new Error("The tar archive is truncated.");
			}
			const all = chunks.length === 1 && chunks[0] !== undefined ? chunks[0] : Buffer.concat(chunks);
			const rest = all.subarray(length);
			chunks = rest.length > 0 ? [rest] : [];
			available = rest.length;
			return all.subarray(0, length);
		},
		async skip(length) {
			let left = length;
			while (left > 0) {
				if (available === 0 && !(await fill(1))) throw new Error("The tar archive is truncated.");
				const head = chunks[0];
				if (head === undefined) throw new Error("The tar archive is truncated.");
				const take = Math.min(left, head.length);
				if (take === head.length) chunks.shift();
				else chunks[0] = head.subarray(take);
				available -= take;
				left -= take;
			}
		},
	};
}

function tarNumber(field: Buffer): number {
	const first = field[0] ?? 0;
	if ((first & 0x80) !== 0) {
		let value = 0n;
		for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("A tar member is too large.");
		return Number(value);
	}
	const digits = field
		.toString("ascii")
		.replace(/[\0 ]+$/, "")
		.trim();
	if (digits === "") return 0;
	if (!/^[0-7]+$/.test(digits)) throw new Error("A tar header has an invalid number.");
	return Number.parseInt(digits, 8);
}

const tarString = (field: Buffer) => {
	const end = field.indexOf(0);
	return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
};

function paxRecords(data: Buffer): Map<string, string> {
	const records = new Map<string, string>();
	let offset = 0;
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset);
		const length = space < 0 ? Number.NaN : Number(data.subarray(offset, space).toString("ascii"));
		if (!Number.isInteger(length) || length <= 0 || offset + length > data.length)
			throw new Error("A tar extended header is invalid.");
		const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
		const equals = record.indexOf("=");
		if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
		offset += length;
	}
	return records;
}

/** Reads a tar stream (USTAR, pax and GNU long names) one member at a time, without unpacking anything to disk. */
export async function* tarEntries(stream: AsyncIterable<Buffer> | Iterable<Buffer>): AsyncGenerator<TarEntry> {
	const source = byteSource(stream);
	let pending = 0;
	let position = 0;
	let next: { path?: string; linkname?: string; size?: number } = {};
	for (;;) {
		if (pending > 0) await source.skip(pending);
		pending = 0;
		const header = await source.read(512);
		if (header.length === 0 || header.every((byte) => byte === 0)) return;
		position += 512;
		let sum = 0;
		for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
		if (sum !== tarNumber(header.subarray(148, 156))) throw new Error("A tar header failed its checksum.");
		const flag = String.fromCharCode(header[156] ?? 0);
		const ownSize = tarNumber(header.subarray(124, 136));
		if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
			if (ownSize > 1 << 20) throw new Error("A tar extended header is too large.");
			const data = (await source.read(ownSize + tarPadding(ownSize))).subarray(0, ownSize);
			position += ownSize + tarPadding(ownSize);
			if (flag === "L") next.path = tarString(data);
			else if (flag === "K") next.linkname = tarString(data);
			else if (flag === "x") {
				const records = paxRecords(data);
				const size = records.get("size");
				next = {
					path: records.get("path") ?? next.path,
					linkname: records.get("linkpath") ?? next.linkname,
					size: size === undefined ? next.size : Number(size),
				};
			}
			continue;
		}
		const size = next.size ?? ownSize;
		if (!Number.isSafeInteger(size) || size < 0) throw new Error("A tar member has an invalid size.");
		const ustar = header.subarray(257, 263).toString("ascii") === "ustar\0";
		const prefix = ustar ? tarString(header.subarray(345, 500)) : "";
		const name = tarString(header.subarray(0, 100));
		const type =
			flag === "0" || flag === "\0" || flag === "7"
				? "file"
				: flag === "1"
					? "link"
					: flag === "2"
						? "symlink"
						: flag === "5"
							? "directory"
							: "other";
		const stored = type === "file" ? size + tarPadding(size) : 0;
		pending = stored;
		const offset = position;
		position += stored;
		let taken = false;
		yield {
			offset,
			path: next.path ?? (prefix === "" ? name : `${prefix}/${name}`),
			type,
			size: type === "file" ? size : 0,
			linkname: next.linkname ?? tarString(header.subarray(157, 257)),
			async bytes() {
				if (taken || type !== "file") throw new Error("A tar member can be read once, and only a regular file.");
				taken = true;
				const data = await source.read(stored);
				if (data.length !== stored) throw new Error("The tar archive is truncated.");
				pending = 0;
				return data.subarray(0, size);
			},
		};
		next = {};
	}
}

/**
 * A digest of a tar stream's regular files, by path and content, whatever the order, times and modes its host wrote.
 * A member that is neither a file nor a folder is refused, so nothing in the archive goes unread.
 */
export async function treeSha256(stream: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<string> {
	const lines: string[] = [];
	for await (const entry of tarEntries(stream)) {
		if (entry.type === "directory") continue;
		if (entry.type !== "file") throw new Error(`${entry.path} is not a regular file.`);
		const digest = createHash("sha256")
			.update(await entry.bytes())
			.digest("hex");
		lines.push(`${digest}  ${entry.path}\n`);
	}
	if (lines.length === 0) throw new Error("The archive holds no file.");
	return createHash("sha256").update(lines.sort().join("")).digest("hex");
}
