/**
 * What a home keeps on disk, as the wallets' tests read it: every byte of its store, the files that hold a key in any
 * form (H-005, H-010, H-011), and its store as a power cut would leave it (C21).
 */
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { context, openStore, syncNow } from "../../src/core/store.ts";
import { echoModels, tempHome } from "../helpers.ts";

/** A home's store, opened. */
export type Store = Awaited<ReturnType<typeof openStore>>;

/** Every durable byte of the home's store, the write-ahead log's included, to look for a key in. */
export function storeText(home: string): string {
	return readdirSync(home)
		.filter((name) => name.startsWith("durable.db"))
		.map((name) => join(home, name))
		.filter((path) => statSync(path).isFile())
		.map((path) => readFileSync(path).toString("latin1"))
		.join("\n");
}

/**
 * Every file under `dir` that holds `key` (`0x` and 64 hex digits) in any form: its hex in either case, its base64, or
 * its raw bytes.
 */
export function holdingKey(dir: string, key: string): string[] {
	const bare = key.replace(/^0x/i, "").toLowerCase();
	const bytes = Buffer.from(bare, "hex");
	const forms = [bare, bare.toUpperCase(), bytes.toString("base64")];
	const found: string[] = [];
	const walk = (at: string) => {
		for (const name of readdirSync(at)) {
			const path = join(at, name);
			const stat = statSync(path, { throwIfNoEntry: false });
			if (stat === undefined) continue;
			if (stat.isDirectory()) walk(path);
			else if (stat.isFile()) {
				const read = readFileSync(path);
				const text = read.toString("latin1");
				if (forms.some((form) => text.includes(form)) || read.includes(bytes)) found.push(path);
			}
		}
	};
	walk(dir);
	return found;
}

/** The store's database and its log, byte for byte. */
type Image = { readonly database: Buffer; readonly log: Buffer };

const imageOf = (home: string): Image => ({
	database: readFileSync(join(home, "durable.db")),
	log: readFileSync(join(home, "durable.db-wal")),
});

/**
 * The home's store as a power cut now leaves it, on one assumption: everything the OS holds of the store reaches the
 * disk. The copy reads the database and its log as the page cache holds them, so it counts every committed frame as
 * on disk; it shows what the store's own order of commits leaves, never whether a flush reached the platter. Read it
 * only after a barrier (`syncNow`, src/core/store.ts), which is what makes the assumption true: `synchronous=FULL`
 * hands every commit to the OS, and on macOS only the barrier's `F_FULLFSYNC` empties the drive's cache (each
 * commit's own sync stops there); `barriered` is the cut that does not take it on trust. A cut keeps the database and
 * its log as they are now, a commit's frames written but not yet committed ignored at the next open; the shared-memory
 * index is lost. Synchronous up to the copy, so a keychain fault point (a call's `hit`) can take it at the very
 * moment of its effect; `read` runs when the result is awaited.
 */
export function powerCut(home: string): <T>(read: (store: Store) => Promise<T>) => Promise<T> {
	return restoring(home, imageOf(home));
}

/**
 * A store's barrier and the power cut that keeps only what a barrier flushed: `sync` is `syncNow` and takes the store's
 * image the moment it is past (`store:sync:after`), and `cut` (synchronous, as `powerCut`) leaves the store as the last
 * barrier did, every commit after it lost, as on a drive whose cache a cut empties. A commit is read back from it only
 * when a barrier came between it and the cut, so a test of it proves the barrier, not only the commit, precedes the
 * effect.
 */
export function barriered(
	home: string,
	harness: Store,
): {
	readonly sync: () => Promise<void>;
	readonly cut: () => <T>(read: (store: Store) => Promise<T>) => Promise<T>;
} {
	let last: Image | undefined;
	return {
		sync: () =>
			syncNow(harness, (point) => {
				if (point === "store:sync:after") last = imageOf(home);
			}),
		cut: () => {
			if (last === undefined) throw new Error("no barrier was passed: a power cut keeps nothing of the store");
			return restoring(home, last);
		},
	};
}

/** Opens a copy of `home` whose store is `image`, for `read`. */
function restoring(home: string, image: Image): <T>(read: (store: Store) => Promise<T>) => Promise<T> {
	return async (read) => {
		const cut = await tempHome();
		cpSync(home, cut, { recursive: true, filter: (from) => !/durable\.db(-wal|-shm)?$/.test(from) });
		writeFileSync(join(cut, "durable.db"), image.database);
		writeFileSync(join(cut, "durable.db-wal"), image.log);
		const store = await openStore(cut, { models: echoModels().models, registry: createRegistry() });
		try {
			return await read(store);
		} finally {
			await store.close(context);
		}
	};
}
