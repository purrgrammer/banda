/**
 * A home's backup and its restore (src/core/backup.ts): the round trip of a real store and what lives beside it, a
 * backup taken while the store is written, a damaged backup refused before any home appears, and a failure or a kill
 * at each boundary leaving nothing a later run reads as whole. The kill at every boundary is the fault suite's
 * (test/backup.faults.test.ts); here one kill falls in the middle of each direction.
 */
import { execFile } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	BackupRefused,
	backupHome,
	daemonRuns,
	MANIFEST,
	type Manifest,
	readManifest,
	restoreHome,
} from "../src/core/backup.ts";
import { HOME_FORMAT } from "../src/core/format.ts";
import { Control } from "../src/core/routines.ts";
import { context } from "../src/core/store.ts";
import {
	BACKUP_POINTS,
	CARRIED,
	chatOf,
	LEFT,
	open,
	RESTORE_POINTS,
	reading,
	seed,
	stages,
	whole,
} from "./fault/backup-scenario.ts";
import { InjectedFault } from "./fault/faults.ts";
import { runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

const run = promisify(execFile);
const format = HOME_FORMAT;

/** A seeded home, and where its backup and its restore go: all in one temporary folder, removed after the test. */
async function places(chat = 7) {
	const area = await tempHome();
	const home = join(area, "home");
	await seed(home, chat);
	return { area, home, to: join(area, "backups", "one"), restored: join(area, "restored") };
}

const edit = (path: string, change: (manifest: Manifest) => unknown) =>
	writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, "utf8")) as Manifest)));

describe("a home's backup", () => {
	it("round trips the store and what lives beside it, and leaves what a home rebuilds or a daemon owns", async () => {
		const { home, to, restored } = await places();
		const { path, manifest } = await backupHome(home, to);
		expect(path).toBe(to);
		expect(await readManifest(to)).toEqual(manifest);
		expect(manifest).toMatchObject({ format, excluded: [] });
		expect(manifest.banda).toMatch(/^\d+\.\d+\.\d+/);
		expect(Date.parse(manifest.created)).not.toBeNaN();
		expect(Object.keys(manifest.files)).toEqual(["durable.db", "format", "config.json"]);
		expect(manifest.files["durable.db"]?.bytes).toBe(lstatSync(join(to, "durable.db")).size);
		expect(manifest.trees).toMatchObject({
			auth: { files: 3, sha256: expect.any(String) },
			blobs: { files: 1, bytes: 10, sha256: expect.any(String) },
			// a link is a file of no bytes
			"computer/workspace": { files: 3, bytes: 18, sha256: expect.any(String) },
			"computer/work": { files: 1, bytes: 4096 },
			"computer/tools": { files: 1 },
			"computer/browser": { files: 1 },
			"computer/proxy": { files: 1, sha256: expect.any(String) },
		});
		expect(manifest.trees["computer/work"]?.sha256).toBeUndefined();
		for (const name of LEFT) expect(existsSync(join(to, name)), name).toBe(false);
		expect(lstatSync(to).mode & 0o777).toBe(0o700);
		expect(stages(to)).toEqual([]);

		expect(await restoreHome(to, restored, { format })).toEqual(manifest);
		expect(reading(restored)).toEqual(reading(home));
		expect(reading(restored)).toMatchObject({
			"auth/": "700",
			"auth/token": expect.stringMatching(/^600 /),
			"computer/tools/bin/tool": expect.stringMatching(/^755 /),
			"computer/workspace/lead.md": "link agents/sancho.md",
		});
		for (const name of LEFT) expect(existsSync(join(restored, name)), name).toBe(false);
		expect(await chatOf(restored)).toBe(7);
		// the backup is only read, and restores again
		expect(reading(to, [MANIFEST, ...CARRIED])).toEqual({
			...reading(home),
			[MANIFEST]: expect.any(String),
		});
		expect(stages(restored)).toEqual([]);
	});

	it("is taken whole while the store is open and written, and holds what was committed before it", async () => {
		const { home, to, restored } = await places(1);
		const harness = await open(home);
		// as a daemon holds its home (src/daemon.ts)
		const lock = new DatabaseSync(join(home, "daemon.lock"));
		lock.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
		try {
			expect(daemonRuns(home)).toBe(true);
			const write = (chat: number) =>
				harness.commit(async (tx) => {
					(await tx.doc(Control)).chat = chat;
				}, context);
			await write(2);
			// the store goes on being written while its backup is taken
			let chat = 2;
			let writing = true;
			const writer = (async () => {
				while (writing) {
					await write(++chat);
					// commits resolve without leaving the turn: let the backup's own work in
					await new Promise((resolve) => setImmediate(resolve));
				}
			})();
			let taken: number;
			try {
				await backupHome(home, to, {
					hit: (point) => {
						if (point === "backup:store") taken = chat;
					},
				});
			} finally {
				writing = false;
				await writer;
			}
			await write(1000);
			await restoreHome(to, restored, { format });
			const kept = await chatOf(restored);
			expect(kept).toBeGreaterThanOrEqual(2);
			expect(kept).toBeLessThanOrEqual(taken! + 1);
			expect((await harness.snapshot(Control, context))?.chat).toBe(1000);
		} finally {
			lock.close();
			await harness.close(context);
		}
		expect(daemonRuns(home)).toBe(false);
	});

	it("keeps a blob the sweep deletes after the store was copied, and one written just before it", async () => {
		const { home, to } = await places();
		const late = "cd".repeat(32);
		const early = "ab".repeat(32);
		const { manifest } = await backupHome(home, to, {
			hit: (point) => {
				// between the first pass over the blobs and the store's copy
				if (point !== "backup:blobs") return;
				mkdirSync(join(home, "blobs/cd"));
				writeFileSync(join(home, "blobs/cd", late), "late");
				rmSync(join(home, "blobs/ab", early));
			},
		});
		expect(manifest.trees.blobs?.files).toBe(2);
		expect(readFileSync(join(to, "blobs/cd", late), "utf8")).toBe("late");
		expect(readFileSync(join(to, "blobs/ab", early), "utf8")).toBe("blob bytes");
	});

	it("leaves out the browser's profile, or the whole computer, when told to, and says so", async () => {
		const { area, home } = await places();
		const noBrowser = await backupHome(home, join(area, "no-browser"), { browser: false });
		expect(noBrowser.manifest.excluded).toEqual(["computer/browser"]);
		expect(Object.keys(noBrowser.manifest.trees)).toEqual(
			expect.arrayContaining(["computer/workspace", "computer/work", "computer/tools", "computer/proxy"]),
		);
		expect(existsSync(join(noBrowser.path, "computer/browser"))).toBe(false);
		const noComputer = await backupHome(home, join(area, "no-computer"), { computer: false });
		expect(noComputer.manifest.excluded).toHaveLength(5);
		expect(Object.keys(noComputer.manifest.trees)).toEqual(["auth", "blobs"]);
		expect(existsSync(join(noComputer.path, "computer"))).toBe(false);
		const restored = join(area, "restored");
		await restoreHome(noComputer.path, restored, { format });
		expect(readdirSync(restored).sort()).toEqual([
			"auth",
			"blobs",
			"config.json",
			"durable.db",
			"format",
			"restored.json",
		]);
		expect(await chatOf(restored)).toBe(7);
	});

	it("carries folders the source made read-only", async () => {
		const { home, to, restored } = await places();
		const cache = "computer/tools/mod/cache";
		mkdirSync(join(home, cache), { recursive: true });
		writeFileSync(join(home, cache, "module"), "read-only");
		const roots = [home, to, restored];
		chmodSync(join(home, cache), 0o555);
		try {
			await backupHome(home, to);
			await restoreHome(to, restored, { format });
			expect(reading(restored)).toEqual(reading(home));
			expect(reading(restored)[`${cache}/`]).toBe("555");
		} finally {
			for (const root of roots) if (existsSync(join(root, cache))) chmodSync(join(root, cache), 0o755);
		}
	});

	it("refuses a home with no store, a folder that is taken, and a place inside the home", async () => {
		const { area, home, to } = await places();
		await expect(backupHome(join(area, "nothing"), to)).rejects.toThrow(/not a home banda can back up/);
		await expect(backupHome(home, join(home, "backup"))).rejects.toThrow(/beside the home/);
		await expect(backupHome(home, area)).rejects.toThrow(/beside the home/);
		await backupHome(home, to);
		await expect(backupHome(home, to)).rejects.toThrow(/is not empty/);
		expect(existsSync(join(area, "nothing"))).toBe(false);
		// an empty folder is taken over
		mkdirSync(join(area, "empty"));
		await backupHome(home, join(area, "empty"));
		expect(existsSync(join(area, "empty", MANIFEST))).toBe(true);
	});
});

describe("a restore", () => {
	const damage: Record<string, (to: string) => void> = {
		"a store with a changed byte": (to) => {
			const bytes = readFileSync(join(to, "durable.db"));
			bytes[bytes.length - 1]! ^= 1;
			writeFileSync(join(to, "durable.db"), bytes);
		},
		"a store that is gone": (to) => rmSync(join(to, "durable.db")),
		"a changed token": (to) => writeFileSync(join(to, "auth/token"), "other-token\n"),
		"a file added to auth": (to) => writeFileSync(join(to, "auth/planted.json"), "{}"),
		"a blob that is gone": (to) => rmSync(join(to, "blobs/ab"), { recursive: true }),
		"a changed definition": (to) => writeFileSync(join(to, "computer/workspace/agents/sancho.md"), "# Pancho\n"),
		"a link that points elsewhere": (to) => {
			rmSync(join(to, "computer/workspace/lead.md"));
			writeFileSync(join(to, "computer/workspace/lead.md"), "");
		},
		"a work file cut short": (to) => writeFileSync(join(to, "computer/work/repo/build.log"), "x"),
		"a work file that is gone": (to) => rmSync(join(to, "computer/work/repo/build.log")),
		"a folder that is gone": (to) => rmSync(join(to, "computer/browser"), { recursive: true }),
		"a changed config": (to) => appendFileSync(join(to, "config.json"), " "),
		"no manifest": (to) => rmSync(join(to, MANIFEST)),
		"a manifest that is not JSON": (to) => writeFileSync(join(to, MANIFEST), "{"),
		"a manifest of another shape": (to) => edit(join(to, MANIFEST), ({ format: _, ...rest }) => rest),
		"a manifest with a field it does not know": (to) => edit(join(to, MANIFEST), (m) => ({ ...m, run: "rm -rf" })),
		"a manifest that names no store": (to) =>
			edit(join(to, MANIFEST), (m) => ({ ...m, files: { format: m.files.format } })),
		"a manifest of another format than its home": (to) => edit(join(to, MANIFEST), (m) => ({ ...m, format: 1 })),
	};
	for (const [name, change] of Object.entries(damage)) {
		it(`refuses a backup with ${name}, and makes no home`, async () => {
			const { to, restored } = await places();
			await backupHome(to.replace(/backups\/one$/, "home"), to);
			change(to);
			await expect(restoreHome(to, restored, { format })).rejects.toThrow(BackupRefused);
			expect(existsSync(restored)).toBe(false);
			expect(stages(restored)).toEqual([]);
		});
	}

	it("refuses a home that holds anything, or whose daemon runs, and leaves it as it was", async () => {
		const { area, home, to } = await places();
		await backupHome(home, to);
		const before = reading(home, [...CARRIED, ...LEFT]);
		await expect(restoreHome(to, home, { format })).rejects.toThrow(/is not empty/);
		const lock = new DatabaseSync(join(home, "daemon.lock"));
		lock.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
		try {
			await expect(restoreHome(to, home, { format })).rejects.toThrow(/a banda daemon runs on/);
		} finally {
			lock.close();
		}
		rmSync(join(home, "daemon.lock"));
		expect(reading(home, [...CARRIED, ...LEFT])).toEqual(before);
		const other = join(area, "other");
		mkdirSync(other);
		writeFileSync(join(other, "note"), "mine");
		await expect(restoreHome(to, other, { format })).rejects.toThrow(/is not empty/);
		expect(readdirSync(other)).toEqual(["note"]);
		await expect(restoreHome(to, join(to, "home"), { format })).rejects.toThrow(/beside its backup/);
		// an empty folder is a home to restore into
		const empty = join(area, "empty");
		mkdirSync(empty);
		await restoreHome(to, empty, { format });
		expect(await chatOf(empty)).toBe(7);
	});

	it("refuses a backup of a newer format than this build reads, and takes an older one", async () => {
		const { home, to, restored } = await places();
		await backupHome(home, to);
		await expect(restoreHome(to, restored, { format: format - 1 })).rejects.toThrow(
			new RegExp(`is in format ${format}, and this build of banda reads format ${format - 1}`),
		);
		expect(existsSync(restored)).toBe(false);
		// what migrates it is the store's business; the bytes come back as they were
		await restoreHome(to, restored, { format: format + 1 });
		expect(readFileSync(join(restored, "format"), "utf8").trim()).toBe(String(format));
	});
});

describe("a backup and a restore under faults", () => {
	it("a failure at any boundary of a backup leaves no backup and no stage, until the rename made it whole", async () => {
		const { area, home } = await places();
		for (const point of BACKUP_POINTS) {
			const to = join(area, "backups", point.replace(":", "-"));
			const failed = backupHome(home, to, {
				hit: (at) => {
					if (at === point) throw new InjectedFault(point);
				},
			});
			await expect(failed, point).rejects.toThrow(InjectedFault);
			expect(stages(to), point).toEqual([]);
			if (point === "backup:renamed") expect(await readManifest(to)).toMatchObject({ format });
			else expect(existsSync(to), point).toBe(false);
		}
	});

	it("a failure at any boundary of a restore leaves no home and no stage, until the rename made it whole", async () => {
		const { area, home, to } = await places();
		await backupHome(home, to);
		for (const point of RESTORE_POINTS) {
			const restored = join(area, point.replace(":", "-"));
			const failed = restoreHome(to, restored, {
				format,
				hit: (at) => {
					if (at === point) throw new InjectedFault(point);
				},
			});
			await expect(failed, point).rejects.toThrow(InjectedFault);
			expect(stages(restored), point).toEqual([]);
			if (point === "restore:renamed") expect(reading(restored)).toEqual(reading(home));
			else expect(existsSync(restored), point).toBe(false);
		}
	});

	for (const point of ["backup:store", "restore:copied"] as const) {
		it(`a kill at ${point} leaves a stage nothing reads as whole, and the next run finishes and removes it`, async () => {
			const { home, to, restored } = await places();
			// the killed process alone: what it leaves is a stage, and neither a backup nor a home it did not finish
			const killed = await run(
				process.execPath,
				["test/fault/backup-worker.ts", home, to, restored, JSON.stringify([{ point, hit: 1, kind: "kill" }])],
				{ timeout: 60_000 },
			).catch((error: { signal?: string }) => error);
			expect(killed).toMatchObject({ signal: "SIGKILL" });
			expect(whole(to, restored)).toEqual({ backup: point === "restore:copied", home: false });
			expect([...stages(to), ...stages(restored)]).toHaveLength(1);

			const { kills } = await runWorker("test/fault/backup-worker.ts", [home, to, restored], []);
			expect(kills).toBe(0);
			expect(whole(to, restored)).toEqual({ backup: true, home: true });
			expect([...stages(to), ...stages(restored)]).toEqual([]);
			expect(reading(restored)).toEqual(reading(home));
			expect(await chatOf(restored)).toBe(7);
		});
	}
});

describe("banda backup and banda restore", () => {
	it("back a home up beside it under a time, and restore it as another home", async () => {
		const { area, home } = await places();
		const cli = (...args: string[]) => run(process.execPath, ["src/cli/index.ts", ...args]);
		const backed = await cli("backup", "--home", home, "--no-browser");
		const [name, ...others] = readdirSync(`${home}-backups`);
		expect(others).toEqual([]);
		expect(name).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ$/);
		const to = join(`${home}-backups`, name!);
		expect(backed.stdout).toContain(`backed up ${home} into ${to}`);
		expect(backed.stdout).toContain("computer/browser/  left out");

		const restored = join(area, "restored");
		const done = await cli("restore", to, "--home", restored);
		expect(done.stdout).toContain(`as ${restored}`);
		expect(await chatOf(restored)).toBe(7);
		expect(existsSync(join(restored, "computer/browser"))).toBe(false);

		const again = await cli("restore", to, "--home", restored).catch(
			(error: { code: number; stderr: string }) => error,
		);
		expect(again).toMatchObject({ code: 1, stderr: expect.stringContaining("is not empty") });
		const named = await cli("backup", "--home", home, "--to", join(area, "named"), "--no-computer");
		expect(named.stdout).toContain(`into ${join(area, "named")}`);
		expect((await readManifest(join(area, "named"))).excluded).toHaveLength(5);
	});
});
