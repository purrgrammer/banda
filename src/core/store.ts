/** The one store: pi-durable over `<home>/durable.db`. Only the daemon opens it. */
import { type FileHandle, mkdir, open as openFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type HarnessOptions, type Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { type NodeSqliteDatabase, openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type MigrateOptions, migrateHome } from "./format.ts";
import { isGroupTools } from "./toolsets.ts";

/** Chord's never-cancelling context, for every call that has no narrower one. */
export const context: Context = BACKGROUND_CONTEXT;

export type StoreOptions = HarnessOptions & {
	/** Wraps the storage the Harness commits through; fault injection in tests crashes around its commits. */
	readonly wrapStorage?: (storage: Storage) => Storage;
	/** How the home is brought to the build's format before the store opens; default the build's own steps. */
	readonly format?: MigrateOptions;
};

/**
 * Each open store's database and the handles `syncNow` flushes its files through. They are opened once and closed only
 * after the store's connection is: SQLite holds its locks on `durable.db` as POSIX advisory locks, which the closing of
 * any descriptor this process holds on that file drops, so a handle opened and closed per barrier would leave the live
 * store unlocked to every other process (SQLite's "Posix advisory locks canceled by a separate thread doing close()").
 */
type Open = {
	readonly database: NodeSqliteDatabase;
	readonly path: string;
	readonly file: FileHandle;
	/** The log's handle, opened at the first barrier that finds the log (it is made at the first write). */
	log: Promise<FileHandle | undefined> | undefined;
};
const databases = new WeakMap<Harness, Open>();

/** SQLite's number for `synchronous = FULL`. */
const FULL = 2;

/**
 * Whether this platform's fsync(2) stops short of the disk: on macOS it hands the data to the drive's write cache,
 * which a power cut loses, and only `F_FULLFSYNC` reaches the platter or the flash. Node's `FileHandle.sync()` issues
 * it there (libuv), as `writeDurably` and `syncNow` use it; SQLite does only under `PRAGMA fullfsync` (each commit's
 * sync of the log) and `PRAGMA checkpoint_fullfsync` (a checkpoint's), both off by default.
 */
export const NEEDS_FULLFSYNC = process.platform === "darwin";

/**
 * The barrier that makes every commit made so far survive power loss (C21), the one call what leaves the daemon after
 * a commit (a wallet's effect, an acknowledgement to the owner) goes through. The store runs WAL with
 * `synchronous=FULL` (`openStore`), so SQLite syncs the log at every commit and a commit is in the OS's hands once it
 * returned; no reader (a backup, `banda backup`, `npm run home:fork`) can hold that back, and nothing waits on one. On
 * macOS that per-commit sync reaches only the drive's cache, and paying `F_FULLFSYNC` at every commit made every turn
 * an order of magnitude slower; so the drive-level flush is paid here, where C21 needs it: this flushes the log and
 * the database with `FileHandle.sync()`, which is `F_FULLFSYNC` on macOS and empties the drive's cache of every
 * commit before it. It checks first that the store still syncs every commit (`synchronous=FULL`, and a checkpoint
 * through to the disk where that is needed), and throws when it does not or a flush fails, so the caller
 * acknowledges nothing; and it has its boundaries for the fault suites.
 */
export async function syncNow(harness: Harness, fault: (point: SyncPoint) => void = () => {}): Promise<void> {
	const open = databases.get(harness);
	if (open === undefined) throw new Error("the store is not open");
	fault("store:sync:before");
	if (!(await syncsEveryCommit(open.database))) throw new Error("the store could not be synced: try again");
	// the log first: it holds every commit not yet checkpointed; then the database, which holds the rest
	await (await logOf(open))?.sync();
	await open.file.sync();
	fault("store:sync:after");
}

/**
 * How `syncNow`'s handles are opened. They write nothing, so read-only where that can be flushed; on Windows a flush
 * (`FlushFileBuffers`) needs a handle with write access and fails on a read-only one, so there they are opened for
 * reading and writing: Windows gets the same drive-level flush as every other platform.
 */
const FLUSHABLE = process.platform === "win32" ? "r+" : "r";

/** The log's kept handle, opened once it exists; a log not made yet holds no commit to flush. */
function logOf(open: Open): Promise<FileHandle | undefined> {
	if (open.log === undefined) {
		const opening = openFile(`${open.path}-wal`, FLUSHABLE).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		open.log = opening;
		// not there yet (or the open failed): the next barrier looks again
		void opening.then(
			(handle) => {
				if (handle === undefined && open.log === opening) open.log = undefined;
			},
			() => {
				if (open.log === opening) open.log = undefined;
			},
		);
	}
	return open.log;
}

/** Closes the handles `syncNow` kept, once the store's connection has closed and released its locks. */
async function closeHandles(open: Open): Promise<void> {
	const log = await open.log?.catch(() => undefined);
	open.log = undefined;
	await Promise.allSettled([open.file.close(), log?.close()]);
}

/**
 * Whether `database` syncs every commit as it is made (`synchronous=FULL`) and, where fsync stops at the drive's
 * cache, every checkpoint through to the disk (`checkpoint_fullfsync`): a checkpoint moves commits into the database
 * and lets the log be written over, so one left in the drive's cache could take with it a commit a barrier flushed.
 */
async function syncsEveryCommit(database: NodeSqliteDatabase): Promise<boolean> {
	const mode = await database.get<{ synchronous: number }>("PRAGMA synchronous");
	if (mode?.synchronous !== FULL) return false;
	if (!NEEDS_FULLFSYNC) return true;
	const checkpoint = await database.get<{ checkpoint_fullfsync: number }>("PRAGMA checkpoint_fullfsync");
	return checkpoint?.checkpoint_fullfsync === 1;
}

/** The store's database as `openStore` opened it, for a test to read its settings; undefined once it is not open. */
export const databaseOf = (harness: Harness): NodeSqliteDatabase | undefined => databases.get(harness)?.database;

/** A sync's boundaries, where the fault suites kill and throw: before the check, and once it is known on disk. */
export type SyncPoint = "store:sync:before" | "store:sync:after";

export async function openStore(
	home: string,
	{ wrapStorage, format, ...options }: StoreOptions,
	ctx: Context = context,
): Promise<Harness> {
	await mkdir(home, { recursive: true });
	// refused, or brought to this build's format, before the store is read (the daemon has done it by now: a check)
	await migrateHome(home, format);
	const path = join(home, "durable.db");
	const database = await openNodeSqliteDatabase(path);
	// every commit synced as it is made (C21): pi-durable opens with NORMAL, which a power cut can undo, and a full
	// checkpoint taken later instead waits on every reader's snapshot with the event loop held
	await database.exec("PRAGMA synchronous = FULL");
	// on macOS a commit's sync stops at the drive's cache, and `syncNow` empties it before anything leaves the daemon;
	// a checkpoint goes through to the disk itself, since it lets the log a barrier flushed be written over. Not
	// `fullfsync`: a drive-level flush at every commit costs every turn far more than C21 needs
	if (NEEDS_FULLFSYNC) await database.exec("PRAGMA checkpoint_fullfsync = ON");
	const opened = await SqliteStorage.open(database);
	const wrapped = wrapStorage === undefined ? opened : wrapStorage(opened);
	// kept for the store's life, and closed only after its connection (`Open`)
	const handles: Open = { database, path, file: await openFile(path, FLUSHABLE), log: undefined };
	const storage = closingAfter(wrapped, () => closeHandles(handles));
	try {
		const harness = await Harness.open(
			storage,
			{
				...options,
				// read at every use, so the default selection follows what is installed
				settings: () => {
					const given = typeof options.settings === "function" ? options.settings() : options.settings;
					return {
						// Every queued input joins at the next boundary; a failed run does not strand the inputs behind it.
						steeringMode: "all",
						followUpMode: "all",
						afterFailedRun: "continue",
						// a group's extensions only in its members' chats, which select them by name (`asMember`)
						extensions: options.registry
							.snapshot()
							.installed()
							.filter((extension) => !isGroupTools(extension.name)),
						...given,
					};
				},
			},
			ctx,
		);
		databases.set(harness, handles);
		return harness;
	} catch (error) {
		await storage.close(ctx).catch(() => undefined);
		throw error;
	}
}

/** `storage`, whose close runs `after` once the storage itself has closed (or failed to). */
function closingAfter(storage: Storage, after: () => Promise<void>): Storage {
	return new Proxy(storage, {
		get(target, key, receiver) {
			if (key === "close")
				return async (ctx: Context) => {
					try {
						await target.close(ctx);
					} finally {
						await after();
					}
				};
			const value = Reflect.get(target, key, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
