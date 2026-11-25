/**
 * A backup of a home, and its restore (docs/recovery.md).
 *
 * A backup is a folder that describes itself: the store as SQLite's online backup wrote it (whole and consistent
 * although a daemon writes on), the blobs, `format`, `config.json`, `auth/` and the native computer's folders, and a
 * manifest of what is there. What a home rebuilds (`search.db`, `cache/`) and what belongs to a running daemon
 * (`daemon.json`, `daemon.lock`, `daemon.log`) are not in it.
 *
 * Both directions stage beside their destination and rename into place, so a backup or a home is whole or absent,
 * whatever kills the process: a backup folder with a manifest is a finished one, and a restore never leaves half a
 * home. A restore copies into its stage, describes the stage as the backup was described and activates it only when
 * that equals the manifest; the backup is only read.
 *
 * The blobs are copied before the store and again after it: the sweep deletes a blob only after the commit that lets
 * go of it, and a blob is written before the commit that refers to it, so the two passes together hold every blob the
 * store's snapshot refers to.
 *
 * The manifest guards against a damaged or incomplete backup, not against someone who can rewrite it: it is not
 * signed, and a backup holds the home's secrets in the clear, in folders only the owner reads.
 *
 * No import of the daemon or the store: what calls this before it opens a store stays light.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream, readFileSync } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { markRestored, RESTORED_MARKER } from "./restored.ts";

export const MANIFEST = "manifest.json";
const STORE = "durable.db";
/** Single files, each hashed. */
const FILES = [STORE, "format", "config.json"] as const;
/** The native computer's folders (src/box/microvm.ts), by what a backup may leave out. */
const COMPUTER = ["workspace", "work", "tools", "proxy", "browser"] as const;
/** Where the computer's files are when there is no box (src/box/host.ts): folders of the home itself. */
const HOST = ["workspace", "work"] as const;
/** Folders, each counted; the ones whose bytes are cheap to read are hashed too. */
const TREES = ["auth", "blobs", ...COMPUTER.map((name) => `computer/${name}`), ...HOST] as const;
/** A build tree, a tool cache and a browser's profile are many gigabytes: counted, not hashed. */
const UNHASHED: ReadonlySet<string> = new Set(["computer/work", "computer/tools", "computer/browser"]);

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Count = Type.Integer({ minimum: 0 });

/** `manifest.json` in a backup: what it holds, checked on every read and against the bytes before a restore. */
export const Manifest = Type.Object(
	{
		banda: Type.String({ description: "The version of banda that wrote the backup" }),
		format: Type.Integer({ minimum: 1, description: "The home's format (its `format` file)" }),
		created: Type.String({ description: "When the backup was taken, ISO 8601" }),
		files: Type.Record(Type.String(), Type.Object({ bytes: Count, sha256: Sha256 }, { additionalProperties: false }), {
			description: "Single files by their path in the home; durable.db is the store",
		}),
		trees: Type.Record(
			Type.String(),
			Type.Object({ files: Count, bytes: Count, sha256: Type.Optional(Sha256) }, { additionalProperties: false }),
			{ description: "Folders by their path in the home: how many files, their bytes, and a digest where hashed" },
		),
		excluded: Type.Array(Type.String(), { description: "Folders left out by choice" }),
	},
	{ additionalProperties: false },
);
export type Manifest = Static<typeof Manifest>;

/** The effect boundaries a kill or a failure may fall on (test/backup.test.ts). */
export type BackupPoint =
	| "backup:staged"
	| "backup:blobs"
	| "backup:store"
	| "backup:files"
	| "backup:computer"
	| "backup:manifest"
	| "backup:renamed"
	| "restore:staged"
	| "restore:copied"
	| "restore:verified"
	| "restore:renamed"
	/** A restore made ready from the app (backups.ts): its copy checked, then its note written. */
	| "restore:ready"
	/** The ready restore taking the home's place at a start: the home moved aside, the copy in its place, the note gone. */
	| "restore:aside"
	| "restore:placed"
	| "restore:settled"
	/** A backup deleted: it left its name, before its bytes go. */
	| "backup:deleting";

export type BackupOptions = {
	/** Leave out the native computer's folders altogether: the workspace, with its definitions and memory, among them. */
	readonly computer?: false;
	/** Leave out the browser's profile: the sites the owner signed in to. */
	readonly browser?: false;
	/** Stops the backup where it is, with nothing left of it: a daemon that closes does not wait for gigabytes. */
	readonly signal?: AbortSignal | undefined;
	readonly hit?: (point: BackupPoint) => void;
};

export type RestoreOptions = {
	/** The home format this build reads (`HOME_FORMAT`): a backup of a newer one is refused. */
	readonly format: number;
	/** Stops the restore where it is, with no home made. */
	readonly signal?: AbortSignal | undefined;
	readonly hit?: (point: BackupPoint) => void;
};

/** Where a home's backups go unless the owner names another place: beside it. */
export const backupsOf = (home: string) => `${resolve(home)}-backups`;

/** The folder name of a backup taken at `at`: its time in UTC, as a file name takes it. */
export const backupName = (at: Date = new Date()) =>
	at
		.toISOString()
		.replace(/\.\d+Z$/, "Z")
		.replaceAll(":", "-");

export class BackupRefused extends Error {
	override name = "BackupRefused";
}

const version = () =>
	(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * Back home `home` up into the new folder `to` (absent, or empty), while its daemon runs or not. Resolves once `to` is
 * whole; until then it does not exist. The home is only read.
 */
export async function backupHome(
	home: string,
	to: string,
	options: BackupOptions = {},
): Promise<{ readonly path: string; readonly manifest: Manifest }> {
	const hit = options.hit ?? (() => {});
	const { signal } = options;
	home = resolve(home);
	to = resolve(to);
	const format = Number((await readFile(join(home, "format"), "utf8").catch(() => "")).trim());
	if (!(await exists(join(home, STORE))) || !Number.isSafeInteger(format) || format < 1)
		throw new BackupRefused(`${home} is not a home banda can back up: it has no store, or no format`);
	if (within(home, to) || within(to, home))
		throw new BackupRefused("a backup goes beside the home, not inside it or around it");
	await mkdir(dirname(to), { recursive: true, mode: 0o700 });
	await refuseTaken(to, "a backup needs a new folder");

	const stage = await staging(to, "partial");
	try {
		hit("backup:staged");
		await copyTree(join(home, "blobs"), join(stage, "blobs"), { live: true, signal });
		hit("backup:blobs");
		const source = new DatabaseSync(join(home, STORE), { readOnly: true });
		try {
			// every page in one step, under one read snapshot: a daemon that keeps writing cannot make it start over.
			// The largest count of pages a step takes: the Node.js a release bundles refuses SQLite's -1 for "all"
			await backup(source, join(stage, STORE), { rate: 0x7fffffff });
		} finally {
			source.close();
		}
		await copyTree(join(home, "blobs"), join(stage, "blobs"), { live: true, missing: true, signal });
		hit("backup:store");
		for (const name of ["format", "config.json"])
			if (await exists(join(home, name))) await copyFile(join(home, name), join(stage, name));
		await copyTree(join(home, "auth"), join(stage, "auth"), { live: true, signal });
		hit("backup:files");
		const excluded: string[] = [];
		for (const name of COMPUTER) {
			if (options.computer === false || (name === "browser" && options.browser === false)) {
				excluded.push(`computer/${name}`);
				continue;
			}
			await copyTree(join(home, "computer", name), join(stage, "computer", name), { live: true, signal });
		}
		for (const name of HOST) {
			if (!(await exists(join(home, name)))) continue;
			if (options.computer === false) excluded.push(name);
			else await copyTree(join(home, name), join(stage, name), { live: true, signal });
		}
		hit("backup:computer");
		const manifest: Manifest = {
			banda: version(),
			format,
			created: new Date().toISOString(),
			...(await describe(stage, (tree) => !UNHASHED.has(tree), signal)),
			excluded,
		};
		if (Number((await readFile(join(stage, "format"), "utf8")).trim()) !== format)
			throw new Error(`${home} changed its format while it was backed up`);
		await writeFile(join(stage, MANIFEST), `${JSON.stringify(manifest, null, "\t")}\n`, { mode: 0o600 });
		for (const path of [join(stage, STORE), join(stage, MANIFEST), stage]) await sync(path);
		hit("backup:manifest");
		await rename(stage, to);
		await sync(dirname(to));
		hit("backup:renamed");
		return { path: to, manifest };
	} catch (error) {
		await remove(stage);
		throw error;
	}
}

/** A backup's manifest, checked against its schema; the backup's bytes are checked by `restoreHome`. */
export async function readManifest(from: string): Promise<Manifest> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(join(from, MANIFEST), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new BackupRefused(`${from} is not a backup: it has no ${MANIFEST}`);
		throw new BackupRefused(`${from}: ${MANIFEST} cannot be read: ${(error as Error).message}`);
	}
	if (!Value.Check(Manifest, value)) {
		const [first] = Value.Errors(Manifest, value);
		throw new BackupRefused(`${from}: ${MANIFEST} is not a manifest: ${first?.message ?? "wrong shape"}`);
	}
	return value;
}

/**
 * Restore backup `from` as home `home` (absent, or empty, with no daemon). The backup is checked against its manifest
 * first, in a copy beside the home, and the home appears whole in one rename; a backup that fails the check, or a
 * process killed on the way, leaves no home. The backup is only read.
 */
export async function restoreHome(from: string, home: string, options: RestoreOptions): Promise<Manifest> {
	const hit = options.hit ?? (() => {});
	const { signal } = options;
	from = resolve(from);
	home = resolve(home);
	const manifest = await readManifest(from);
	if (manifest.format > options.format)
		throw new BackupRefused(
			`${from} is in format ${manifest.format}, and this build of banda reads format ${options.format}: restore it with the build that made it (banda ${manifest.banda}) or a newer one`,
		);
	if (manifest.files[STORE] === undefined || manifest.files.format === undefined)
		throw new BackupRefused(`${from}: its manifest names no store, so it is not a home's backup`);
	if (within(home, from) || within(from, home))
		throw new BackupRefused("a home is restored beside its backup, not inside it or around it");
	if (daemonRuns(home))
		throw new BackupRefused(`a banda daemon runs on ${home}: stop it, and restore into an empty home`);
	await mkdir(dirname(home), { recursive: true });
	await refuseTaken(home, "a restore needs an empty home, and never writes over one");

	const stage = await staging(home, "restoring");
	try {
		hit("restore:staged");
		for (const name of FILES)
			if (manifest.files[name] !== undefined) await copyFile(join(from, name), join(stage, name), CLONE);
		for (const tree of TREES) {
			if (manifest.trees[tree] === undefined) continue;
			await mkdir(dirname(join(stage, tree)), { recursive: true, mode: 0o700 });
			await copyTree(join(from, tree), join(stage, tree), { signal });
		}
		hit("restore:copied");
		// what is activated is what was checked: the stage itself, described as the backup was
		const found = await describe(stage, (tree) => manifest.trees[tree]?.sha256 !== undefined, signal);
		const wrong = differences(manifest, found);
		if (wrong.length > 0)
			throw new BackupRefused(
				`${from} does not match its manifest (${wrong.slice(0, 5).join(", ")}${wrong.length > 5 ? ", …" : ""}): it is damaged or incomplete, and nothing was restored`,
			);
		if (Number((await readFile(join(stage, "format"), "utf8")).trim()) !== manifest.format)
			throw new BackupRefused(`${from}: its format file and its manifest disagree, and nothing was restored`);
		// never the home it came from, wherever it lands: its wallets sign again only once the owner moves signing here
		await markRestored(stage);
		await sync(join(stage, RESTORED_MARKER));
		await sync(join(stage, STORE));
		await sync(stage);
		hit("restore:verified");
		await rename(stage, home);
		await sync(dirname(home));
		hit("restore:renamed");
		return manifest;
	} catch (error) {
		await remove(stage);
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !(error instanceof BackupRefused))
			throw new BackupRefused(`${from} is incomplete (${(error as Error).message}), and nothing was restored`);
		throw error;
	}
}

/** Whether a daemon holds `home`: its lock (src/daemon.ts) is taken. A lock file nobody holds is a dead daemon's. */
export function daemonRuns(home: string): boolean {
	let lock: DatabaseSync;
	try {
		lock = new DatabaseSync(join(home, "daemon.lock"), { readOnly: true });
	} catch {
		return false;
	}
	try {
		lock.prepare("SELECT count(*) FROM sqlite_master").get();
		return false;
	} catch {
		return true;
	} finally {
		lock.close();
	}
}

type Described = Pick<Manifest, "files" | "trees">;

/** What is in a backup or a stage, as a manifest says it: the same reading on both sides of a restore. */
async function describe(root: string, hashed: (tree: string) => boolean, signal?: AbortSignal): Promise<Described> {
	const files: Described["files"] = {};
	for (const name of FILES) {
		const stat = await lstat(join(root, name)).catch(() => undefined);
		if (stat?.isFile()) files[name] = { bytes: stat.size, sha256: await sha256(join(root, name)) };
	}
	const trees: Described["trees"] = {};
	for (const tree of TREES) {
		if (!(await lstat(join(root, tree)).catch(() => undefined))?.isDirectory()) continue;
		const lines: string[] = [];
		let count = 0;
		let bytes = 0;
		const hash = hashed(tree);
		await walk(join(root, tree), "", async (path, relative, entry) => {
			signal?.throwIfAborted();
			count++;
			if (entry === "link") {
				if (hash) lines.push(`${relative}\0link:${await readlink(path)}`);
				return;
			}
			bytes += (await lstat(path)).size;
			if (hash) lines.push(`${relative}\0${await sha256(path)}`);
		});
		trees[tree] = {
			files: count,
			bytes,
			...(hash ? { sha256: createHash("sha256").update(lines.sort().join("\n")).digest("hex") } : {}),
		};
	}
	return { files, trees };
}

/** Where what was found differs from the manifest, by path. */
function differences(manifest: Described, found: Described): string[] {
	const wrong: string[] = [];
	for (const kind of ["files", "trees"] as const) {
		const names = new Set([...Object.keys(manifest[kind]), ...Object.keys(found[kind])]);
		for (const name of [...names].sort()) {
			const [a, b] = [manifest[kind][name], found[kind][name]];
			if (a === undefined || b === undefined || !Value.Equal(a, b)) wrong.push(name);
		}
	}
	return wrong;
}

const CLONE = constants.COPYFILE_FICLONE;
/** Files of one folder copied side by side. */
const WIDTH = 16;

/**
 * Copy folder `from` to `to`: files as copy-on-write clones where the filesystem makes them, plain copies elsewhere;
 * links as links; sockets and pipes left behind. `live`: the source is written while it is read, so a file that went
 * is skipped. `missing`: only the files `to` does not have yet. An absent `from` copies nothing.
 */
async function copyTree(
	from: string,
	to: string,
	{ live = false, missing = false, signal }: { live?: boolean; missing?: boolean; signal?: AbortSignal | undefined },
): Promise<void> {
	const gone = (error: unknown) => {
		if (live && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	};
	const folder = async (source: string, target: string): Promise<void> => {
		signal?.throwIfAborted();
		const stat = await lstat(source).catch(gone);
		if (stat === undefined || !stat.isDirectory()) return;
		const entries = await readdir(source, { withFileTypes: true }).catch(gone);
		if (entries === undefined) return;
		// writable while it is filled, whatever the source's mode: a module cache's folders are read-only
		await mkdir(target, { recursive: true, mode: 0o700 });
		for (let i = 0; i < entries.length; i += WIDTH)
			await Promise.all(
				entries.slice(i, i + WIDTH).map(async (entry) => {
					const [a, b] = [join(source, entry.name), join(target, entry.name)];
					if (entry.isDirectory()) return;
					if (missing && (await exists(b))) return;
					if (entry.isSymbolicLink()) {
						const link = await readlink(a).catch(gone);
						if (link !== undefined) await symlink(link, b);
					} else if (entry.isFile()) {
						const times = await lstat(a).catch(gone);
						if (times === undefined) return;
						if ((await copyFile(a, b, CLONE).then(() => true, gone)) === undefined) return;
						await utimes(b, times.atime, times.mtime);
					}
				}),
			);
		for (const entry of entries)
			if (entry.isDirectory()) await folder(join(source, entry.name), join(target, entry.name));
		await chmod(target, stat.mode & 0o7777);
	};
	await folder(from, to);
}

/** Every file and link under `root`, folders first to last by name. */
async function walk(
	root: string,
	relative: string,
	each: (path: string, relative: string, entry: "file" | "link") => Promise<void>,
): Promise<void> {
	const entries = await readdir(join(root, relative), { withFileTypes: true });
	for (const entry of entries) {
		const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
		if (entry.isDirectory()) await walk(root, path, each);
		else if (entry.isSymbolicLink()) await each(join(root, path), path, "link");
		else if (entry.isFile()) await each(join(root, path), path, "file");
	}
}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);

/** Whether `inner` is `outer` or under it, as the paths are written. */
function within(outer: string, inner: string): boolean {
	return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/** Refuse a destination that holds anything. */
async function refuseTaken(path: string, why: string): Promise<void> {
	const stat = await lstat(path).catch(() => undefined);
	if (stat === undefined) return;
	if (!stat.isDirectory() || (await readdir(path)).length > 0) throw new BackupRefused(`${path} is not empty: ${why}`);
}

/**
 * A new, owner-only folder beside `path` to fill before it takes `path`'s name. One a killed process left is removed
 * here, known by the process in its name being gone; nothing reads a stage as the thing it was becoming.
 */
async function staging(path: string, word: string): Promise<string> {
	const parent = await realpath(dirname(path));
	const prefix = `.${basename(path)}.${word}-`;
	for (const name of await readdir(parent)) {
		if (!name.startsWith(prefix)) continue;
		const pid = Number(name.slice(prefix.length).split("-")[0]);
		if (Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) await remove(join(parent, name));
	}
	const stage = join(parent, `${prefix}${process.pid}-${randomBytes(4).toString("hex")}`);
	await mkdir(stage, { mode: 0o700 });
	return stage;
}

/**
 * Remove the stages dead processes left in `parent`: a backup that was being filled, a restore being checked, a
 * backup being deleted. Each is known by the process in its name, and one whose process lives is left alone.
 */
export async function sweepStages(parent: string): Promise<void> {
	for (const name of await readdir(parent).catch(() => [])) {
		const pid = Number(/^\..+\.(?:partial|restoring|deleting)-(\d+)-[0-9a-f]{8}$/.exec(name)?.[1]);
		if (Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) await remove(join(parent, name));
	}
}

/**
 * Delete the folder `path`: it leaves its name in one step and is removed under a stage's, so what a kill leaves is
 * the folder whole or a stage, never half of it under its own name.
 */
export async function removeWhole(path: string, hit: () => void = () => {}): Promise<void> {
	const stage = join(dirname(path), `.${basename(path)}.deleting-${process.pid}-${randomBytes(4).toString("hex")}`);
	await rename(path, stage);
	hit();
	await remove(stage);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Remove a stage, read-only folders in it too; one that will not go stays a stage, never a result. */
export async function remove(stage: string): Promise<void> {
	await rm(stage, { recursive: true, force: true }).catch(async () => {
		await walkFolders(stage, (folder) => chmod(folder, 0o700)).catch(() => undefined);
		await rm(stage, { recursive: true, force: true }).catch(() => undefined);
	});
}

async function walkFolders(root: string, each: (folder: string) => Promise<void>): Promise<void> {
	await each(root);
	for (const entry of await readdir(root, { withFileTypes: true }))
		if (entry.isDirectory()) await walkFolders(join(root, entry.name), each);
}

/** Flush a file's bytes, or a folder's entries, to the disk. */
async function sync(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
