/**
 * `syncNow` (C21): the store syncs every commit as it is made (`synchronous = FULL`), so a reader's snapshot (a backup
 * reading the store) never holds a sync back nor the daemon's event loop with it; `syncNow` is the one barrier that
 * flushes the log and the database past the drive's cache (`FileHandle.sync()`, `F_FULLFSYNC` on macOS) between its
 * points, passed in order; a commit followed by it survives a power cut; and a store that syncs less is refused.
 */
import { execFileSync } from "node:child_process";
import { fstatSync, statSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityLog, log } from "../src/core/activity.ts";
import { context, databaseOf, NEEDS_FULLFSYNC, type SyncPoint, syncNow } from "../src/core/store.ts";
import { type Connected as Opened, openConnected } from "./fixtures/connected.ts";
import { barriered } from "./helpers/home-files.ts";
import { tempHome } from "./helpers.ts";

const opened: Opened[] = [];
const readers: DatabaseSync[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const reader of readers.splice(0)) reader.close();
	for (const s of opened.splice(0)) await s.close();
});

describe("syncing the store to disk (C21)", () => {
	it("syncs while a reader holds a snapshot, without holding the event loop, and passes its points in order", async () => {
		const home = await tempHome();
		const s = await openConnected({ home, respond: () => fauxAssistantMessage("Done.") });
		opened.push(s);
		const commit = (what: string) => s.harness.commit((tx) => log(tx, { at: Date.now(), what }), context);
		await commit("before the reader");
		const passed: SyncPoint[] = [];
		await syncNow(s.harness, (point) => passed.push(point));
		expect(passed).toEqual(["store:sync:before", "store:sync:after"]);
		// a reader's snapshot, as a backup's, taken before the next commit: a full checkpoint could not pass it
		const reader = new DatabaseSync(join(home, "durable.db"), { readOnly: true, timeout: 0 });
		readers.push(reader);
		reader.exec("BEGIN");
		reader.prepare("SELECT count(*) FROM sqlite_master").get();
		await commit("after the reader");
		passed.length = 0;
		let worst = 0;
		let last = performance.now();
		const ticks = setInterval(() => {
			const now = performance.now();
			worst = Math.max(worst, now - last);
			last = now;
		}, 5);
		const started = performance.now();
		for (let i = 0; i < 3; i++) await syncNow(s.harness, (point) => passed.push(point));
		const took = performance.now() - started;
		// let the timer run once after, so a loop held through the syncs shows as a gap
		await new Promise((resolve) => setTimeout(resolve, 20));
		clearInterval(ticks);
		expect(passed).toEqual(Array(3).fill(["store:sync:before", "store:sync:after"]).flat());
		expect(took).toBeLessThan(250);
		expect(worst).toBeLessThan(250);
		reader.exec("COMMIT");
	}, 30_000);

	it("flushes the log and then the database past the drive's cache, between its points", async () => {
		const home = await tempHome();
		const s = await openConnected({ home, respond: () => fauxAssistantMessage("Done.") });
		opened.push(s);
		const inode = (name: string) => statSync(join(home, name)).ino;
		const events: string[] = [];
		// every flush a FileHandle makes, by the file it is on: `sync()` is fsync(2), and F_FULLFSYNC on macOS (libuv)
		const probe = await open(join(home, "durable.db"), "r");
		const prototype = Object.getPrototypeOf(probe) as FileHandle;
		await probe.close();
		const sync = prototype.sync;
		vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
			const at = fstatSync(this.fd).ino;
			events.push(at === inode("durable.db-wal") ? "wal" : at === inode("durable.db") ? "db" : "other");
			return sync.call(this);
		});
		await s.harness.commit((tx) => log(tx, { at: Date.now(), what: "a commit" }), context);
		await syncNow(s.harness, (point) => events.push(point));
		expect(events).toEqual(["store:sync:before", "wal", "db", "store:sync:after"]);
	});

	it("keeps a commit followed by the barrier through a power cut, and loses one made after it", async () => {
		const home = await tempHome();
		const s = await openConnected({ home, respond: () => fauxAssistantMessage("Done.") });
		opened.push(s);
		const barrier = barriered(home, s.harness);
		const commit = (what: string) => s.harness.commit((tx) => log(tx, { at: Date.now(), what }), context);
		await commit("acknowledged");
		await barrier.sync();
		await commit("not yet");
		const seen = await barrier.cut()(async (store) =>
			((await store.snapshot(ActivityLog, context))?.events ?? []).map((event) => event.what),
		);
		expect(seen).toContain("acknowledged");
		expect(seen).not.toContain("not yet");
	});

	it("keeps the store locked to every other process through its barriers", async () => {
		const home = await tempHome();
		const s = await openConnected({ home, respond: () => fauxAssistantMessage("Done.") });
		opened.push(s);
		const commit = (what: string) => s.harness.commit((tx) => log(tx, { at: Date.now(), what }), context);
		// another process that takes the store for itself and writes: refused while the daemon's connection holds its
		// locks; a barrier that closed a descriptor of the store's files would have dropped them (POSIX locks are per
		// process and per file, and any close drops them all)
		const intrude = () =>
			execFileSync(
				process.execPath,
				[
					"--no-warnings",
					"--input-type=module",
					"-e",
					`import { DatabaseSync } from "node:sqlite";
					const db = new DatabaseSync(process.argv[1], { timeout: 0 });
					try {
						db.exec("PRAGMA locking_mode = EXCLUSIVE");
						db.exec("CREATE TABLE intruder (x)");
						process.stdout.write("wrote");
					} catch (error) {
						process.stdout.write(String(error.message));
					}`,
					join(home, "durable.db"),
				],
				{ encoding: "utf8" },
			);
		await commit("before the barrier");
		expect(intrude()).toMatch(/locked/);
		for (let i = 0; i < 3; i++) {
			await syncNow(s.harness);
			expect(intrude()).toMatch(/locked/);
			await commit(`after barrier ${i}`);
		}
		const seen = ((await s.harness.snapshot(ActivityLog, context))?.events ?? []).map((event) => event.what);
		expect(seen).toEqual(expect.arrayContaining(["before the barrier", "after barrier 0", "after barrier 2"]));
	}, 30_000);

	it("syncs every commit, a checkpoint through to the disk on macOS but no commit, and refuses to vouch for one when it does not", async () => {
		const s = await openConnected({ home: await tempHome(), respond: () => fauxAssistantMessage("Done.") });
		opened.push(s);
		const database = databaseOf(s.harness);
		if (database === undefined) throw new Error("the store is not open");
		expect(NEEDS_FULLFSYNC).toBe(process.platform === "darwin");
		expect(await database.get("PRAGMA synchronous")).toEqual({ synchronous: 2 });
		// the drive-level flush is the barrier's, never every commit's: it made every turn far slower on macOS
		expect(await database.get("PRAGMA fullfsync")).toEqual({ fullfsync: 0 });
		expect(await database.get("PRAGMA checkpoint_fullfsync")).toEqual({
			checkpoint_fullfsync: NEEDS_FULLFSYNC ? 1 : 0,
		});
		await syncNow(s.harness);
		// a commit not handed to the OS as it is made, or a checkpoint left in the drive's cache, is not one to vouch for
		await database.exec("PRAGMA synchronous = NORMAL");
		await expect(syncNow(s.harness)).rejects.toThrow(/could not be synced/);
		await database.exec("PRAGMA synchronous = FULL");
		if (NEEDS_FULLFSYNC) {
			await database.exec("PRAGMA checkpoint_fullfsync = OFF");
			await expect(syncNow(s.harness)).rejects.toThrow(/could not be synced/);
			await database.exec("PRAGMA checkpoint_fullfsync = ON");
		}
		await syncNow(s.harness);
	});
});
