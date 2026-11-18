/**
 * The corresponding sources and third-party notices of a release, assembled from its own built downloads:
 *
 *   node scripts/release-sources.ts --collect --assets <downloads> --out <folder>
 *   node scripts/release-sources.ts --verify <folder> [<folder with more downloads>...] [--deep]
 *
 * `--collect` reads each supported target's command-line archive, checks its computer against the installed manifest,
 * lists what its images contain, and fetches the matching sources: Microsandbox and the firmware at their pinned
 * commits, the kernel the firmware builds, the registry packages of the pinned Cargo.lock, the Debian source package of
 * every installed package, and the source archive of every Python distribution. Every download is checked against a
 * hash: one pinned in this repository, one the pinned Cargo.lock gives, or one the distribution's own index gives. It
 * writes the sources as tar shards, the notices as one tar, RELEASE-SOURCES.md and release-materials.json, which binds
 * them to the downloads by SHA-256. A source it cannot fetch or check stops it.
 *
 * `--verify` is what the publish job runs over the files it is about to attach: scripts/release-materials.ts decides.
 * `--deep` also reads every shard and checks each member.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
	fileSha256,
	MICROVM_PLATFORMS,
	MICROVM_SOURCE,
	MicrovmManifest,
	readMicrovmAssets,
} from "../src/box/microvm-assets.ts";
import {
	chromiumFfmpeg,
	debianFolder,
	downloadKind,
	dpkgPackages,
	dscFiles,
	ELECTRON_SOURCE,
	electronChromium,
	FFMPEG_MATERIAL,
	FIRMWARE_SOURCE,
	type FileIdentity,
	type ImageInventory,
	INDEX_FILE,
	INSTRUCTIONS_FILE,
	LIMITS,
	lockCrates,
	type MaterialSource,
	noticeFile,
	noticesName,
	PYTHON_UPSTREAM_SOURCES,
	planShards,
	pythonDistribution,
	RELEASE_TARGETS,
	ReleaseMaterials,
	shardName,
	tarEntries,
	tarHeader,
	tarPadding,
	treeSha256,
	verifyReleaseMaterials,
} from "./release-materials.ts";

type Expected = { sha256: string; bytes?: number } | { sha1: string; bytes: number } | { tree: string };
type Member = { path: string; bytes: number; sha256: string; file: string };

async function identity(path: string): Promise<FileIdentity & { sha1: string }> {
	const sha256 = createHash("sha256");
	const sha1 = createHash("sha1");
	let bytes = 0;
	for await (const chunk of createReadStream(path)) {
		sha256.update(chunk);
		sha1.update(chunk);
		bytes += chunk.length;
	}
	return { bytes, sha256: sha256.digest("hex"), sha1: sha1.digest("hex") };
}

/** Whether a file is the expected one: by its bytes, or, for a gzipped tar no host serves twice alike, by its members. */
async function matches(path: string, expected: Expected): Promise<boolean> {
	if ("tree" in expected)
		return (await treeSha256(createReadStream(path).pipe(createGunzip())).catch(() => "")) === expected.tree;
	const actual = await identity(path);
	if (expected.bytes !== undefined && actual.bytes !== expected.bytes) return false;
	return "sha256" in expected ? actual.sha256 === expected.sha256 : actual.sha1 === expected.sha1;
}

/** A file under `cache`, fetched from the first address that serves the expected bytes; never an unchecked file. */
export async function fetched(
	cache: string,
	key: string,
	urls: readonly string[],
	expected: Expected,
	decode?: (served: Buffer) => Buffer,
): Promise<string> {
	const path = join(cache, key);
	if (await stat(path).catch(() => undefined)) {
		if (await matches(path, expected)) return path;
		await rm(path);
	}
	await mkdir(dirname(path), { recursive: true });
	const partial = `${path}.partial`;
	const failures: string[] = [];
	for (let attempt = 0; attempt < 4; attempt++) {
		for (const url of urls) {
			try {
				const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
				if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
				if (decode === undefined) await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
				else await writeFile(partial, decode(Buffer.from(await response.arrayBuffer())));
				if (!(await matches(partial, expected))) throw new Error("the bytes differ from the expected hash");
				await rename(partial, path);
				return path;
			} catch (error) {
				failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
				await rm(partial, { force: true });
			}
		}
		await new Promise((done) => setTimeout(done, 2000 * 2 ** attempt));
	}
	throw new Error(`No source served ${key}.\n${failures.join("\n")}`);
}

async function upstreamIndex<T extends TSchema>(url: string, schema: T): Promise<Static<T>> {
	let failure = "";
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
			if (response.status === 404) throw Object.assign(new Error("HTTP 404"), { final: true });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const value: unknown = await response.json();
			if (!Value.Check(schema, value)) throw Object.assign(new Error("an unexpected answer"), { final: true });
			return value;
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			if (error instanceof Error && "final" in error) break;
			await new Promise((done) => setTimeout(done, 2000 * 2 ** attempt));
		}
	}
	throw new Error(`${url}: ${failure}`);
}

export async function each<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		for (let item = items[next++]; item !== undefined; item = items[next++]) await work(item);
	};
	await Promise.all(Array.from({ length: limit }, worker));
}

export type ImageFile = { kind: "file"; data: Buffer } | { kind: "link"; target: string; hard: boolean };

function noticePath(path: string): boolean {
	if (path === "var/lib/dpkg/status" || path.startsWith("usr/share/common-licenses/")) return true;
	if (path.startsWith("usr/share/doc/")) return true; // narrowed by member type below
	if (!path.includes(".dist-info/")) return false;
	return (
		path.endsWith("/METADATA") ||
		path.includes("/licenses/") ||
		/LICEN[CS]E|NOTICE|COPYING|AUTHORS/i.test(basename(path))
	);
}

/**
 * The package database and license files of an exported image's final filesystem, read layer by layer, with the
 * digest of the image configuration the archive really holds for `ref`.
 */
export async function imageNotices(
	archive: string,
	ref: string,
	arch: "arm64" | "x64",
): Promise<{ digest: string; files: Map<string, ImageFile> }> {
	const blobs = new Map<string, { offset: number; size: number }>();
	let manifest: unknown;
	for await (const entry of tarEntries(createReadStream(archive))) {
		if (entry.type !== "file") continue;
		if (entry.path === "manifest.json") manifest = JSON.parse((await entry.bytes()).toString("utf8"));
		else blobs.set(entry.path, { offset: entry.offset, size: entry.size });
	}
	const Exported = Type.Array(
		Type.Object({ Config: Type.String(), RepoTags: Type.Array(Type.String()), Layers: Type.Array(Type.String()) }),
	);
	if (!Value.Check(Exported, manifest)) throw new Error(`${archive} has no image export manifest.`);
	const exported = manifest.find((entry) => entry.RepoTags.includes(ref));
	const configuration = blobs.get(exported?.Config ?? "");
	if (exported === undefined || configuration === undefined || configuration.size > 1 << 20)
		throw new Error(`${archive} does not contain ${ref}.`);
	const layers = exported.Layers;
	let files = new Map<string, ImageFile>();
	const handle = await open(archive, "r");
	let digest: string;
	try {
		const config = Buffer.alloc(configuration.size);
		await handle.read(config, 0, config.length, configuration.offset);
		const Config = Type.Object({
			architecture: Type.Literal(arch === "arm64" ? "arm64" : "amd64"),
			os: Type.Literal("linux"),
		});
		if (!Value.Check(Config, JSON.parse(config.toString("utf8"))))
			throw new Error(`${archive} is not a Linux ${arch} image.`);
		digest = `sha256:${createHash("sha256").update(config).digest("hex")}`;
		for (const layer of layers) {
			const blob = blobs.get(layer);
			if (blob === undefined) throw new Error(`${archive} lacks its layer ${layer}.`);
			if (blob.size === 0) continue;
			const magic = Buffer.alloc(2);
			await handle.read(magic, 0, 2, blob.offset);
			const raw = createReadStream(archive, { start: blob.offset, end: blob.offset + blob.size - 1 });
			const stream = magic[0] === 0x1f && magic[1] === 0x8b ? raw.pipe(createGunzip()) : raw;
			const added = new Map<string, ImageFile>();
			const removed: string[] = [];
			for await (const entry of tarEntries(stream)) {
				const path = entry.path.replace(/^\.\//, "").replace(/\/+$/, "");
				if (path.startsWith("/") || path.split("/").includes(".."))
					throw new Error("An image layer has an unsafe path.");
				const name = posix.basename(path);
				if (name === ".wh..wh..opq") removed.push(`${posix.dirname(path)}/`);
				else if (name.startsWith(".wh.")) removed.push(posix.join(posix.dirname(path), name.slice(4)));
				else if (!noticePath(path)) continue;
				else if (entry.type === "symlink" || entry.type === "link")
					added.set(path, { kind: "link", target: entry.linkname.replace(/^\.\//, ""), hard: entry.type === "link" });
				else if (entry.type === "file" && (!path.startsWith("usr/share/doc/") || name === "copyright")) {
					if (entry.size > 64 << 20) throw new Error(`${path} is too large for a notice.`);
					added.set(path, { kind: "file", data: Buffer.from(await entry.bytes()) });
				}
			}
			const kept = new Map<string, ImageFile>();
			for (const [path, file] of files)
				if (
					!removed.some((gone) =>
						gone.endsWith("/") ? path.startsWith(gone) : path === gone || path.startsWith(`${gone}/`),
					)
				)
					kept.set(path, file);
			files = new Map([...kept, ...added]);
		}
	} finally {
		await handle.close();
	}
	return { digest, files };
}

/** Follows the image's own links from a path to the regular file it names, if the notices hold one. */
export function resolved(files: ReadonlyMap<string, ImageFile>, start: string): string | undefined {
	let path = start;
	for (let hop = 0; hop < 20; hop++) {
		const entry = files.get(path);
		if (entry?.kind === "file") return path;
		const parts = path.split("/");
		let replaced = false;
		for (let end = parts.length; end > 0 && !replaced; end--) {
			const prefix = parts.slice(0, end).join("/");
			const link = files.get(prefix);
			if (link?.kind !== "link") continue;
			const base = link.hard || link.target.startsWith("/") ? "" : posix.dirname(prefix);
			path = posix.normalize(posix.join(base, link.target.replace(/^\/+/, ""), ...parts.slice(end)));
			if (path.startsWith("../")) return undefined;
			replaced = true;
		}
		if (!replaced) return undefined;
	}
	return undefined;
}

type Notice = { path: string; data: Buffer };

function inventory(
	role: ImageInventory["role"],
	image: { sha256: string; digest: string },
	files: ReadonlyMap<string, ImageFile>,
): { image: ImageInventory; notices: Notice[] } {
	const status = files.get("var/lib/dpkg/status");
	if (status?.kind !== "file") throw new Error(`The ${role} image has no package database.`);
	const packages = dpkgPackages(status.data.toString("utf8"));
	const python: { name: string; version: string }[] = [];
	const notices: Notice[] = [];
	const links: { path: string; target: string }[] = [];
	for (const [path, file] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (file.kind === "link") links.push({ path, target: file.target });
		else notices.push({ path: `root/${path}`, data: file.data });
		if (file.kind === "file" && path.endsWith(".dist-info/METADATA")) {
			const { name, version } = pythonDistribution(file.data.toString("utf8"));
			if (!python.some((entry) => entry.name === name && entry.version === version)) python.push({ name, version });
		}
	}
	const copyright = packages.map((entry) => ({
		...entry,
		copyright: resolved(files, `usr/share/doc/${entry.name.split(":")[0]}/copyright`) ?? null,
	}));
	const listing = { role, ...image, packages: copyright, python, links };
	notices.push({ path: "packages.json", data: Buffer.from(`${JSON.stringify(listing, null, "\t")}\n`) });
	return { image: { role, ...image, packages, python }, notices };
}

async function gzipMember(archive: string, wanted: (path: string) => boolean): Promise<Map<string, Buffer>> {
	const found = new Map<string, Buffer>();
	for await (const entry of tarEntries(createReadStream(archive).pipe(createGunzip())))
		if (entry.type === "file" && wanted(entry.path) && entry.size <= 8 << 20)
			found.set(entry.path, Buffer.from(await entry.bytes()));
	return found;
}

async function writeTar(path: string, members: readonly (Member | Notice)[], consume = false): Promise<void> {
	const handle = await open(path, "wx");
	try {
		for (const member of members) {
			const size = "data" in member ? member.data.length : member.bytes;
			await handle.write(tarHeader(member.path, size));
			if ("data" in member) await handle.write(member.data);
			else {
				let written = 0;
				for await (const chunk of createReadStream(member.file)) {
					await handle.write(chunk);
					written += chunk.length;
				}
				if (written !== size) throw new Error(`${member.file} changed while it was packed.`);
				if (consume) await rm(member.file);
			}
			await handle.write(Buffer.alloc(tarPadding(size)));
		}
		await handle.write(Buffer.alloc(1024));
	} finally {
		await handle.close();
	}
}

const SourceFiles = Type.Object({
	result: Type.Array(Type.Object({ hash: Type.String({ pattern: "^[a-f0-9]{40}$" }) })),
	fileinfo: Type.Record(
		Type.String({ pattern: "^[a-f0-9]{40}$" }),
		Type.Array(
			Type.Object({ archive_name: Type.String(), name: Type.String(), path: Type.String(), size: Type.Integer() }),
		),
	),
});
const PythonRelease = Type.Object({
	urls: Type.Array(
		Type.Object({
			packagetype: Type.String(),
			filename: Type.String(),
			url: Type.String({ pattern: "^https://files\\.pythonhosted\\.org/" }),
			size: Type.Integer(),
			digests: Type.Object({ sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
		}),
	),
});
const MIRRORS: Readonly<Record<string, string>> = {
	debian: "https://deb.debian.org/debian",
	"debian-security": "https://security.debian.org/debian-security",
};
const plainFile = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/;

/** One Debian source package: its control file by the hash Debian's snapshot index gives, its files by the control file. */
async function debianSource(cache: string, source: string, version: string): Promise<{ key: string; file: string }[]> {
	if (!plainFile.test(source) || !/^[A-Za-z0-9.+~:-]+$/.test(version))
		throw new Error(`Debian source ${source} ${version} is not plainly named.`);
	const listing = await upstreamIndex(
		`https://snapshot.debian.org/mr/package/${encodeURIComponent(source)}/${encodeURIComponent(version)}/srcfiles?fileinfo=1`,
		SourceFiles,
	);
	const candidates = (name: string) =>
		Object.entries(listing.fileinfo).flatMap(([sha1, records]) => {
			const named = records.filter((record) => record.name === name);
			const [first] = named;
			if (first === undefined) return [];
			const urls = named.flatMap((record) => {
				const mirror = MIRRORS[record.archive_name];
				return mirror === undefined || !/^\/pool\/[A-Za-z0-9._+~/-]+$/.test(record.path)
					? []
					: [`${mirror}${record.path}/${name}`];
			});
			return [{ sha1, bytes: first.size, urls: [...new Set(urls), `https://snapshot.debian.org/file/${sha1}`] }];
		});
	const folder = `debian/${debianFolder(source, version)}`;
	const control = `${source}_${version.replace(/^\d+:/, "")}.dsc`;
	const [dsc, ...others] = candidates(control);
	if (dsc === undefined || others.length > 0) throw new Error(`Debian's snapshot does not name one ${control}.`);
	const files = [
		{
			key: `${folder}/${control}`,
			file: await fetched(cache, `${folder}/${control}`, dsc.urls, { sha1: dsc.sha1, bytes: dsc.bytes }),
		},
	];
	for (const entry of dscFiles(await readFile(files[0]?.file ?? "", "utf8"))) {
		const urls = candidates(entry.name).flatMap((candidate) => (candidate.bytes === entry.bytes ? candidate.urls : []));
		if (urls.length === 0) throw new Error(`Debian's snapshot does not hold ${entry.name} of ${source} ${version}.`);
		const key = `${folder}/${entry.name}`;
		files.push({ key, file: await fetched(cache, key, urls, { sha256: entry.sha256, bytes: entry.bytes }) });
	}
	return files;
}

async function pythonSource(cache: string, name: string, version: string): Promise<{ key: string; file: string }> {
	const pinned = PYTHON_UPSTREAM_SOURCES[`${name} ${version}`];
	if (pinned !== undefined)
		return {
			key: `python/${pinned.file}`,
			file: await fetched(cache, `python/${pinned.file}`, [pinned.url], { sha256: pinned.sha256 }),
		};
	const release = await upstreamIndex(
		`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
		PythonRelease,
	);
	const sdist = release.urls.find((entry) => entry.packagetype === "sdist");
	if (sdist === undefined)
		throw new Error(
			`Python ${name} ${version} has no source archive on PyPI and no pinned upstream source (PYTHON_UPSTREAM_SOURCES).`,
		);
	if (!plainFile.test(sdist.filename)) throw new Error(`Python ${name} ${version} has an unusable source file name.`);
	const key = `python/${sdist.filename}`;
	return { key, file: await fetched(cache, key, [sdist.url], { sha256: sdist.digests.sha256, bytes: sdist.size }) };
}

function instructions(value: ReleaseMaterials): string {
	const shards = value.assets.filter((asset) => asset.kind === "source-shard").map((asset) => `\`${asset.file}\``);
	return `# Sources and notices for banda ${value.version}

The Mac and Linux downloads of this release carry a small virtual machine: Microsandbox's \`msb\`, the libkrunfw
firmware with its Linux kernel, and guest images built on Debian. The files beside this one are the source code and
license notices for what those downloads contain, published in the same place as the downloads themselves.

- \`${INDEX_FILE}\` names every download, every source archive and every installed guest package, each by SHA-256.
- ${shards.join(", ")}: ordinary tar archives. Unpack them all into one folder; everything lands under \`materials/\`.
- \`${noticesName(value.version)}\`: the license and copyright files of the guest images' packages, of the Rust
  crates, of Electron and of FFmpeg, with each image's package list. Each download also carries its notices inside
  itself, in its \`licenses\` folder (\`banda/app/licenses\` in the command-line archive); \`README.txt\` there is the index.
- \`SHA256SUMS\` covers every file of the release, this one and the index included.

## What is inside

- \`materials/application/\`: banda at commit \`${value.sourceCommit}\` (AGPL-3.0), with the Dockerfiles and scripts
  that build the guest images and the recipe that builds \`msb\`.
- \`materials/native/\`: Microsandbox at \`${MICROVM_SOURCE.commit}\` and banda's patch to it; libkrunfw at
  \`${FIRMWARE_SOURCE.commit}\` with its kernel patches and configuration; the ${FIRMWARE_SOURCE.kernel.version} source it builds.
  For the desktop packages: FFmpeg, which Electron ${ELECTRON_SOURCE.version} ships as the shared library \`libffmpeg\` under the
  LGPL, version 2.1 or later, as Chromium's fork at \`${ELECTRON_SOURCE.ffmpeg.commit}\`; the DEPS file of Chromium
  ${ELECTRON_SOURCE.chromium.version} that names that commit; and Electron's own source at \`${ELECTRON_SOURCE.commit}\`, whose
  \`patches/ffmpeg\` it applies to FFmpeg and whose \`build/args\` configure the build.
- \`materials/crates/\`: the ${value.cargo.registryPackages} registry packages of Microsandbox's Cargo.lock.
- \`materials/debian/\`: the Debian source package of every package installed in the box, proxy and browser images.
- \`materials/python/\`: the source archive of every Python distribution in the proxy image.

## Check it

\`\`\`sh
sha256sum --check SHA256SUMS
git clone https://github.com/purrgrammer/banda && cd banda && git checkout ${value.sourceCommit}
npm ci --ignore-scripts
node scripts/release-sources.ts --verify <the folder with the release's files> --deep
\`\`\`

The check reads every shard, compares each member with the index, and confirms that every installed package named in
the index has its source in the set.

## What this is not

${value.limits.map((line) => `- ${line}`).join("\n")}
`;
}

async function listFiles(folder: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(folder, { withFileTypes: true, recursive: true }))
		if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
	return found.sort();
}

export async function collectReleaseSources(options: {
	root: string;
	assets: string;
	out: string;
	cache: string;
	consume?: boolean;
}): Promise<ReleaseMaterials> {
	const { root, out, cache } = options;
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
	const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const patch = join(root, "scripts", "microvm-runtime.patch");
	const patchSha256 = await fileSha256(patch);
	const recipeSha256 = await fileSha256(join(root, "scripts", "microvm-runtime.ts"));
	await mkdir(out, { recursive: true });
	await mkdir(cache, { recursive: true });
	const work = await mkdtemp(join(tmpdir(), "banda-release-sources-"));
	try {
		const downloads = (await listFiles(options.assets)).filter((path) => downloadKind(basename(path)) !== undefined);
		const members = new Map<string, Member>();
		const sources: MaterialSource[] = [];
		const add = async (
			kind: MaterialSource["kind"],
			name: string,
			version: string,
			files: readonly { key: string; file: string }[],
		) => {
			const paths: string[] = [];
			for (const { key, file } of files) {
				const path = `materials/${key}`;
				if (!members.has(path)) members.set(path, { path, file, ...(await identity(file)) });
				paths.push(path);
			}
			sources.push({ kind, name, version, files: paths });
		};
		const notices: Notice[] = [];
		const targets: ReleaseMaterials["targets"] = [];
		const debian = new Map<string, { source: string; version: string }>();
		const python = new Map<string, { name: string; version: string }>();

		for (const target of RELEASE_TARGETS) {
			const mine = downloads.filter((path) => downloadKind(basename(path))?.target === target);
			const cli = mine.filter((path) => downloadKind(basename(path))?.kind === "cli");
			const [archive] = cli;
			if (archive === undefined || cli.length !== 1)
				throw new Error(`${target} needs exactly one command-line archive.`);
			if (!mine.some((path) => downloadKind(basename(path))?.kind === "desktop"))
				throw new Error(`${target} has no desktop download to bind.`);
			for (const path of mine)
				if (!basename(path).includes(`-${pkg.version}-`))
					throw new Error(`${basename(path)} is not version ${pkg.version}.`);
			const unpacked = join(work, target);
			await mkdir(unpacked);
			execFileSync("tar", ["-xzf", archive, "-C", unpacked, "banda/app/computer"]);
			const bundle = join(unpacked, "banda", "app", "computer");
			await readMicrovmAssets(bundle, target);
			const manifestBytes = await readFile(join(bundle, "manifest.json"));
			const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
			if (!Value.Check(MicrovmManifest, manifest)) throw new Error(`${target}'s manifest is invalid.`);
			if (manifest.runtimeBuild.patchSha256 !== patchSha256 || manifest.runtimeBuild.recipeSha256 !== recipeSha256)
				throw new Error(`${target} was built with a different runtime patch or recipe than this checkout's.`);
			if (
				manifest.browser.url !==
				`https://github.com/purrgrammer/banda/releases/download/v${pkg.version}/banda-browser-${manifest.browser.sha256}.tar`
			)
				throw new Error(`${target}'s browser is not a download of this release.`);
			const browser = downloads.find((path) => basename(path) === `banda-browser-${manifest.browser.sha256}.tar`);
			if (browser === undefined) throw new Error(`${target}'s browser archive is not among the downloads.`);
			const browserIdentity = await identity(browser);
			if (browserIdentity.sha256 !== manifest.browser.sha256 || browserIdentity.bytes !== manifest.browser.bytes)
				throw new Error(`${target}'s browser archive differs from its manifest.`);
			const arch = MICROVM_PLATFORMS[target].arch;
			const images: ImageInventory[] = [];
			for (const role of ["box", "proxy", "browser"] as const) {
				const tar = role === "browser" ? browser : join(bundle, manifest[role].archive);
				const { sha256, digest, ref } = manifest[role];
				const contents = await imageNotices(tar, ref, arch);
				if (contents.digest !== digest) throw new Error(`${target}'s ${role} image differs from its manifest.`);
				const result = inventory(role, { sha256, digest }, contents.files);
				images.push(result.image);
				for (const notice of result.notices)
					notices.push({ path: `notices/${target}/${role}/${notice.path}`, data: notice.data });
				for (const entry of result.image.packages)
					debian.set(`${entry.source} ${entry.sourceVersion}`, { source: entry.source, version: entry.sourceVersion });
				for (const entry of result.image.python) python.set(`${entry.name} ${entry.version}`, entry);
			}
			for (const name of ["manifest.json", ...Object.values(manifest.notices).map((notice) => notice.path)])
				notices.push({
					path: `notices/${target}/computer/${basename(name)}`,
					data: await readFile(join(bundle, name)),
				});
			targets.push({
				target,
				manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
				msbSha256: manifest.msb.sha256,
				firmwareSha256: manifest.firmware.sha256,
				patchSha256: manifest.runtimeBuild.patchSha256,
				downloads: await Promise.all(
					[...mine, browser].sort().map(async (path) => {
						const { bytes, sha256 } = path === browser ? browserIdentity : await identity(path);
						return { file: basename(path), kind: downloadKind(basename(path))?.kind ?? "desktop", bytes, sha256 };
					}),
				),
				images,
			});
			await rm(unpacked, { recursive: true, force: true });
		}

		const application = join(work, `banda-${sourceCommit}.tar`);
		execFileSync(
			"git",
			["archive", "--format=tar", `--prefix=banda-${sourceCommit}/`, `--output=${application}`, sourceCommit],
			{ cwd: root },
		);
		await add("application", "banda", pkg.version, [
			{ key: `application/${basename(application)}`, file: application },
		]);
		const copiedPatch = join(work, "microvm-runtime.patch");
		await copyFile(patch, copiedPatch);
		await add("runtime-patch", "microvm-runtime.patch", patchSha256.slice(0, 12), [
			{ key: "native/microvm-runtime.patch", file: copiedPatch },
		]);

		const microsandbox = `native/microsandbox-${MICROVM_SOURCE.commit}.tar.gz`;
		const microsandboxFile = await fetched(
			cache,
			microsandbox,
			[`https://codeload.github.com/superradcompany/microsandbox/tar.gz/${MICROVM_SOURCE.commit}`],
			{ sha256: MICROVM_SOURCE.archiveSha256 },
		);
		await add("microsandbox", "microsandbox", MICROVM_SOURCE.commit, [{ key: microsandbox, file: microsandboxFile }]);
		const top = `microsandbox-${MICROVM_SOURCE.commit}`;
		const pinFile = `${top}/.github/actions/cache-libkrunfw-kernel/action.yml`;
		const upstream = await gzipMember(microsandboxFile, (path) => path === `${top}/Cargo.lock` || path === pinFile);
		const lock = upstream.get(`${top}/Cargo.lock`);
		if (lock === undefined || createHash("sha256").update(lock).digest("hex") !== MICROVM_SOURCE.lockSha256)
			throw new Error("The Microsandbox source's Cargo.lock differs from its pin.");
		if (!upstream.get(pinFile)?.toString("utf8").includes(`kernel_sha256=${FIRMWARE_SOURCE.kernel.sha256}`))
			throw new Error("Microsandbox's source names a different kernel archive than the pinned one.");

		const firmware = `native/libkrunfw-${FIRMWARE_SOURCE.commit}.tar.gz`;
		const firmwareFile = await fetched(
			cache,
			firmware,
			[`https://codeload.github.com/${FIRMWARE_SOURCE.repository}/tar.gz/${FIRMWARE_SOURCE.commit}`],
			{ sha256: FIRMWARE_SOURCE.archiveSha256 },
		);
		await add("firmware", "libkrunfw", FIRMWARE_SOURCE.commit, [{ key: firmware, file: firmwareFile }]);
		const makefile = (await gzipMember(firmwareFile, (path) => path === `libkrunfw-${FIRMWARE_SOURCE.commit}/Makefile`))
			.values()
			.next()
			.value?.toString("utf8");
		const kernelVersion = /^KERNEL_VERSION = (\S+)$/m.exec(makefile ?? "")?.[1];
		const kernelRemote = /^KERNEL_REMOTE = (\S+)$/m.exec(makefile ?? "")?.[1];
		if (
			kernelVersion !== FIRMWARE_SOURCE.kernel.version ||
			kernelRemote?.replace("$(KERNEL_VERSION)", kernelVersion) !== FIRMWARE_SOURCE.kernel.url
		)
			throw new Error("The firmware source builds a different kernel than the pinned one.");
		const kernel = `native/${basename(FIRMWARE_SOURCE.kernel.url)}`;
		await add("kernel", "linux", FIRMWARE_SOURCE.kernel.version, [
			{
				key: kernel,
				file: await fetched(cache, kernel, [FIRMWARE_SOURCE.kernel.url], { sha256: FIRMWARE_SOURCE.kernel.sha256 }),
			},
		]);

		const desktop = JSON.parse(await readFile(join(root, "desktop", "package.json"), "utf8")) as {
			devDependencies?: Record<string, string>;
		};
		if (desktop.devDependencies?.electron !== ELECTRON_SOURCE.version)
			throw new Error("The desktop app is built on a different Electron than the one whose FFmpeg source is pinned.");
		const electron = `native/electron-${ELECTRON_SOURCE.commit}.tar.gz`;
		const electronFile = await fetched(
			cache,
			electron,
			[`https://codeload.github.com/electron/electron/tar.gz/${ELECTRON_SOURCE.commit}`],
			{ sha256: ELECTRON_SOURCE.archiveSha256 },
		);
		await add("electron", "electron", ELECTRON_SOURCE.version, [{ key: electron, file: electronFile }]);
		const electronTop = `electron-${ELECTRON_SOURCE.commit}`;
		const electronTexts = await gzipMember(electronFile, (path) =>
			[`${electronTop}/DEPS`, `${electronTop}/LICENSE`, `${electronTop}/patches/ffmpeg/.patches`].includes(path),
		);
		if (
			electronChromium(electronTexts.get(`${electronTop}/DEPS`)?.toString("utf8") ?? "") !==
			ELECTRON_SOURCE.chromium.version
		)
			throw new Error("Electron's source builds on a different Chromium than the pinned one.");
		const patches = electronTexts.get(`${electronTop}/patches/ffmpeg/.patches`);
		const license = electronTexts.get(`${electronTop}/LICENSE`);
		if (patches === undefined || license === undefined)
			throw new Error("Electron's source lacks its license or its list of FFmpeg patches.");
		notices.push({ path: "notices/electron/LICENSE", data: license });
		const deps = `native/chromium-${ELECTRON_SOURCE.chromium.version}-DEPS`;
		const depsFile = await fetched(
			cache,
			deps,
			[ELECTRON_SOURCE.chromium.depsUrl],
			{ sha256: ELECTRON_SOURCE.chromium.depsSha256 },
			(served) => Buffer.from(served.toString("ascii"), "base64"),
		);
		if (chromiumFfmpeg(await readFile(depsFile, "utf8")) !== ELECTRON_SOURCE.ffmpeg.commit)
			throw new Error("Electron's Chromium checks out a different FFmpeg than the pinned one.");
		const ffmpeg = FFMPEG_MATERIAL.slice("materials/".length);
		const ffmpegFile = await fetched(cache, ffmpeg, [ELECTRON_SOURCE.ffmpeg.url], {
			tree: ELECTRON_SOURCE.ffmpeg.treeSha256,
		});
		await add("ffmpeg", "ffmpeg", ELECTRON_SOURCE.ffmpeg.commit, [
			{ key: ffmpeg, file: ffmpegFile },
			{ key: deps, file: depsFile },
		]);
		const ffmpegTexts = await gzipMember(ffmpegFile, (path) =>
			["COPYING.LGPLv2.1", "LICENSE.md", "CREDITS.chromium"].includes(path),
		);
		if (ffmpegTexts.size !== 3) throw new Error("The FFmpeg source lacks its license files.");
		for (const [path, data] of ffmpegTexts) notices.push({ path: `notices/ffmpeg/${path}`, data });

		const crates = lockCrates(lock.toString("utf8"));
		const crateFiles = new Map<string, string>();
		await each(crates, 8, async (crate) => {
			const name = `${crate.name}-${crate.version}`;
			crateFiles.set(
				name,
				await fetched(cache, `crates/${name}.crate`, [`https://static.crates.io/crates/${crate.name}/${name}.crate`], {
					sha256: crate.sha256,
				}),
			);
		});
		const crateListing: { name: string; version: string; license: string; files: string[] }[] = [];
		for (const crate of crates) {
			const name = `${crate.name}-${crate.version}`;
			const file = crateFiles.get(name) ?? "";
			await add("crate", crate.name, crate.version, [{ key: `crates/${name}.crate`, file }]);
			const texts = await gzipMember(file, (path) => {
				const [top, member, ...deeper] = path.split("/");
				return (
					top === name && member !== undefined && deeper.length === 0 && (member === "Cargo.toml" || noticeFile(member))
				);
			});
			const manifest = texts.get(`${name}/Cargo.toml`)?.toString("utf8") ?? "";
			texts.delete(`${name}/Cargo.toml`);
			for (const [path, data] of texts) notices.push({ path: `notices/crates/${path}`, data });
			crateListing.push({
				name: crate.name,
				version: crate.version,
				license:
					/^license = "([^"\n]*)"$/m.exec(manifest)?.[1] ?? /^license-file = "([^"\n]*)"$/m.exec(manifest)?.[1] ?? "",
				files: [...texts.keys()].sort(),
			});
		}
		notices.push({
			path: "notices/crates/crates.json",
			data: Buffer.from(`${JSON.stringify(crateListing, null, "\t")}\n`),
		});

		const debianFiles = new Map<string, { key: string; file: string }[]>();
		await each([...debian.values()], 4, async ({ source, version }) => {
			debianFiles.set(`${source} ${version}`, await debianSource(cache, source, version));
			console.log(`debian ${source} ${version}`);
		});
		for (const [key, { source, version }] of [...debian].sort(([a], [b]) => (a < b ? -1 : 1)))
			await add("debian", source, version, debianFiles.get(key) ?? []);
		const pythonFiles = new Map<string, { key: string; file: string }>();
		await each([...python.values()], 4, async ({ name, version }) => {
			pythonFiles.set(`${name} ${version}`, await pythonSource(cache, name, version));
		});
		for (const [key, { name, version }] of [...python].sort(([a], [b]) => (a < b ? -1 : 1))) {
			const file = pythonFiles.get(key);
			if (file === undefined) throw new Error(`Python ${key} was not collected.`);
			await add("python", name, version, [file]);
		}

		const assets: ReleaseMaterials["assets"] = [];
		const asset = async (file: string, kind: ReleaseMaterials["assets"][number]["kind"]) => {
			const { bytes, sha256 } = await identity(join(out, file));
			assets.push({ file, kind, bytes, sha256 });
		};
		const materials: ReleaseMaterials["materials"] = [];
		for (const [number, shard] of planShards([...members.values()]).entries()) {
			const file = shardName(pkg.version, number);
			await rm(join(out, file), { force: true });
			await writeTar(join(out, file), shard, options.consume);
			await asset(file, "source-shard");
			for (const member of shard)
				materials.push({ path: member.path, bytes: member.bytes, sha256: member.sha256, asset: file });
			console.log(`packed ${file}`);
		}
		await rm(join(out, noticesName(pkg.version)), { force: true });
		await writeTar(
			join(out, noticesName(pkg.version)),
			[...notices].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
		);
		await asset(noticesName(pkg.version), "notices");
		const value: ReleaseMaterials = {
			schemaVersion: 1,
			version: pkg.version,
			sourceCommit,
			review: { status: "unreviewed", statement: LIMITS[0] },
			cargo: { lockSha256: MICROVM_SOURCE.lockSha256, registryPackages: crates.length },
			targets,
			sources,
			materials,
			assets,
			limits: [...LIMITS],
		};
		await writeFile(join(out, INSTRUCTIONS_FILE), instructions(value));
		await asset(INSTRUCTIONS_FILE, "instructions");
		await writeFile(join(out, INDEX_FILE), `${JSON.stringify(value, null, "\t")}\n`);
		return value;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

/**
 * Checks release files against the index in the first folder; with `deep`, every member of every shard too. More
 * folders hold downloads that are not yet beside the index, as a build's artifacts are before the release gathers them.
 */
export async function verifyReleaseFolder(folders: readonly string[], deep = false): Promise<string[]> {
	const [folder] = folders;
	if (folder === undefined) throw new Error("No folder holds the release's files.");
	const value: unknown = JSON.parse(await readFile(join(folder, INDEX_FILE), "utf8").catch(() => "null"));
	const files = new Map<string, FileIdentity>();
	const problems: string[] = [];
	for (const path of (await Promise.all(folders.map(listFiles))).flat()) {
		const found = await identity(path);
		const earlier = files.get(basename(path));
		if (earlier !== undefined && earlier.sha256 !== found.sha256)
			problems.push(`${basename(path)} exists twice with different bytes.`);
		files.set(basename(path), found);
	}
	problems.push(...verifyReleaseMaterials(value, files));
	if (problems.length > 0 || !deep || !Value.Check(ReleaseMaterials, value)) return problems;
	const expected = new Map(value.materials.map((material) => [material.path, material]));
	for (const shard of value.assets.filter((asset) => asset.kind === "source-shard")) {
		const members: { path: string; offset: number; size: number }[] = [];
		for await (const entry of tarEntries(createReadStream(join(folder, shard.file))))
			members.push({ path: entry.path, offset: entry.offset, size: entry.size });
		for (const member of members) {
			const material = expected.get(member.path);
			expected.delete(member.path);
			const digest = createHash("sha256");
			if (member.size > 0)
				for await (const chunk of createReadStream(join(folder, shard.file), {
					start: member.offset,
					end: member.offset + member.size - 1,
				}))
					digest.update(chunk);
			if (
				material === undefined ||
				material.asset !== shard.file ||
				material.bytes !== member.size ||
				material.sha256 !== digest.digest("hex")
			)
				problems.push(`${shard.file}: ${member.path} differs from the index.`);
			// the one source no hash of its bytes pins: read it and compare its members' digest
			if (member.path === FFMPEG_MATERIAL) {
				const packed = createReadStream(join(folder, shard.file), {
					start: member.offset,
					end: member.offset + member.size - 1,
				});
				if ((await treeSha256(packed.pipe(createGunzip())).catch(() => "")) !== ELECTRON_SOURCE.ffmpeg.treeSha256)
					problems.push(`${shard.file}: ${member.path} is not the pinned FFmpeg source.`);
			}
		}
	}
	for (const path of expected.keys()) problems.push(`${path} is in no shard.`);
	return problems;
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			collect: { type: "boolean" },
			verify: { type: "boolean" },
			deep: { type: "boolean" },
			consume: { type: "boolean" },
			assets: { type: "string" },
			out: { type: "string" },
			cache: { type: "string" },
		},
	});
	const root = resolve(import.meta.dirname, "..");
	if (values.collect) {
		if (values.assets === undefined || values.out === undefined) throw new Error("--collect needs --assets and --out.");
		const out = resolve(values.out);
		const value = await collectReleaseSources({
			root,
			assets: resolve(values.assets),
			out,
			cache: resolve(values.cache ?? join(root, "release", "cache", "sources")),
			consume: values.consume ?? false,
		});
		console.log(
			`${value.sources.length} sources, ${value.materials.length} files, ${value.assets.length} release assets in ${out}`,
		);
	} else if (values.verify) {
		if (positionals.length === 0) throw new Error("--verify needs the folder that holds the release's files.");
		const problems = await verifyReleaseFolder(
			positionals.map((folder) => resolve(folder)),
			values.deep ?? false,
		);
		for (const problem of problems) console.error(problem);
		if (problems.length > 0) throw new Error("The release's sources and notices are not a whole, bound set.");
		console.log("The release's downloads, sources and notices are bound and complete.");
	} else throw new Error("Use --collect to assemble a release's sources and notices, or --verify to check them.");
}
