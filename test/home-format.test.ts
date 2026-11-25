/**
 * A home is marked with the format of what it stores. A build brings an earlier home to its own format step by step
 * before the store opens, and refuses one from before the floor or from a newer build. No build has a real step yet,
 * so the steps here are the test-only ones of `fault/format-scenario.ts`; `home-format.faults.test.ts` kills the same
 * runs, and `home-upgrade.test.ts` opens homes that released builds made.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readManifest } from "../src/core/backup.ts";
import {
	backupBeforeUpgrade,
	FORMAT_FLOOR,
	HOME_FORMAT,
	INSTALLATION_ID,
	MIGRATIONS,
	migrateHome,
	NewerHome,
	OldHome,
} from "../src/core/format.ts";
import { context, openStore } from "../src/core/store.ts";
import { installationId } from "../src/home.ts";
import { type Fault, Faults, InjectedFault } from "./fault/faults.ts";
import { checkBuildSettled, migrateBuild, seedKept } from "./fault/format-build.ts";
import {
	backUp,
	checkSettled,
	checkStopped,
	FORMAT_POINTS,
	migrate,
	STEP_POINTS,
	seed,
	steps,
} from "./fault/format-scenario.ts";
import { echoModels } from "./fixtures/models.ts";
import { tempHome } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const open = (home: string, format?: Parameters<typeof openStore>[1]["format"]) =>
	openStore(home, { registry: createRegistry(), models: echoModels().models, format });
const markOf = (home: string) => readFile(join(home, "format"), "utf8");
const seeded = async () => {
	const home = await tempHome();
	await seed(home);
	return home;
};

describe("home format", () => {
	it("is the floor's plus one for each of the build's steps", () => {
		expect(HOME_FORMAT).toBe(FORMAT_FLOOR + MIGRATIONS.length);
	});

	it("marks a new home and opens it again", async () => {
		const home = await tempHome();
		await (await open(home)).close(context);
		expect(await markOf(home)).toBe(`${HOME_FORMAT}\n`);
		await (await open(home)).close(context);
	});

	it("refuses a home from before the floor, or an old one with no mark, plainly, and leaves it as it was", async () => {
		const other = await tempHome();
		await writeFile(join(other, "format"), `${FORMAT_FLOOR - 1}\n`);
		await expect(open(other)).rejects.toThrow(OldHome);
		await expect(open(other, { migrations: steps(2, () => {}) })).rejects.toThrow(/before 0\.1\.0-alpha\.14/);
		expect(await markOf(other)).toBe(`${FORMAT_FLOOR - 1}\n`);
		expect(existsSync(join(other, "durable.db"))).toBe(false);
		const unmarked = await tempHome();
		await writeFile(join(unmarked, "durable.db"), "");
		await expect(open(unmarked)).rejects.toThrow(OldHome);
		expect(existsSync(join(unmarked, "format"))).toBe(false);
	});

	it("refuses a home a newer build made, or began migrating, and leaves it as it was", async () => {
		const newer = await tempHome();
		await writeFile(join(newer, "format"), `${HOME_FORMAT + 1}\n`);
		await expect(open(newer)).rejects.toThrow(NewerHome);
		await expect(open(newer)).rejects.toThrow(`reads up to format ${HOME_FORMAT}`);
		expect(await markOf(newer)).toBe(`${HOME_FORMAT + 1}\n`);
		expect(existsSync(join(newer, "durable.db"))).toBe(false);
		// a build with one step, and a home on its way to a format two steps on
		const begun = await seeded();
		await writeFile(join(begun, "format"), `${FORMAT_FLOOR} to ${FORMAT_FLOOR + 2}\n`);
		const ran: string[] = [];
		await expect(migrateHome(begun, { migrations: steps(1, (point) => ran.push(point)) })).rejects.toThrow(NewerHome);
		expect(ran).toEqual([]);
		expect(await markOf(begun)).toBe(`${FORMAT_FLOOR} to ${FORMAT_FLOOR + 2}\n`);
	});

	it("refuses a mark that names no format", async () => {
		const home = await tempHome();
		await writeFile(join(home, "format"), "");
		await expect(open(home)).rejects.toThrow(/does not name a format/);
	});

	it("runs the pending steps in order before the store opens, after one backup", async () => {
		const home = await seeded();
		const seen: string[] = [];
		const store = await open(home, {
			migrations: steps(2, (point) => seen.push(`${point} db:${existsSync(join(home, "durable.db"))}`)),
			before: async (from, to) => {
				seen.push(`before ${from} ${to}`);
				await backUp(home)(from, to);
			},
			hit: (point) => seen.push(point),
		});
		await store.close(context);
		const step = ["format:step:before db:false", "format:step:written db:false", "format:step:renamed db:false"];
		expect(seen).toEqual([
			`before ${FORMAT_FLOOR} ${FORMAT_FLOOR + 2}`,
			"format:before",
			"format:marked",
			...step,
			"format:migrated",
			"format:marked",
			...step,
			"format:migrated",
			"format:settled",
		]);
		await checkSettled(home, 2);
		// settled: the next start runs nothing and asks for no backup
		seen.length = 0;
		const again = await open(home, {
			migrations: steps(2, (point) => seen.push(point)),
			before: async () => void seen.push("before"),
			hit: (point) => seen.push(point),
		});
		await again.close(context);
		expect(seen).toEqual([]);
		await checkSettled(home, 2);
	});

	it("goes on from where a home is, with the steps it has not had", async () => {
		const home = await seeded();
		await migrate(home, 1, () => {});
		await checkSettled(home, 1);
		const befores: number[][] = [];
		await migrateHome(home, {
			migrations: steps(3, () => {}),
			before: async (from, to) => void befores.push([from, to]),
		});
		expect(befores).toEqual([[FORMAT_FLOOR + 1, FORMAT_FLOOR + 3]]);
		expect(await markOf(home)).toBe(`${FORMAT_FLOOR + 3}\n`);
		expect(JSON.parse(await readFile(join(home, "ledger.json"), "utf8"))).toEqual({
			format: FORMAT_FLOOR + 3,
			applied: [FORMAT_FLOOR, FORMAT_FLOOR + 1, FORMAT_FLOOR + 2],
		});
	});

	it("touches nothing when the backup fails, and says which step failed when one does", async () => {
		const home = await seeded();
		const ran: string[] = [];
		const failing = migrateHome(home, {
			migrations: steps(2, (point) => ran.push(point)),
			before: async () => {
				throw new Error("the disk is full");
			},
		});
		await expect(failing).rejects.toThrow("the disk is full");
		expect(ran).toEqual([]);
		expect(await markOf(home)).toBe(`${FORMAT_FLOOR}\n`);
		const broken = [{ what: "the ledger", run: () => Promise.reject(new Error("no such ledger")) }];
		await expect(open(home, { migrations: broken })).rejects.toThrow(
			`from format ${FORMAT_FLOOR} to ${FORMAT_FLOOR + 1} (the ledger): no such ledger`,
		);
		expect(existsSync(join(home, "durable.db"))).toBe(false);
	});

	const points = [...FORMAT_POINTS, ...STEP_POINTS];
	/** One start after another, start `i` under `schedules[i]` and the last under none: every stop checked, then the end. */
	const runs = async (count: number, schedules: readonly (readonly Fault[])[]) => {
		const home = await seeded();
		for (const schedule of [...schedules, []]) {
			const faults = new Faults(schedule);
			const stopped = await migrate(home, count, (point) => faults.hit(point)).then(
				() => false,
				(error: unknown) => {
					if (error instanceof InjectedFault || (error as Error).cause instanceof InjectedFault) return true;
					throw error;
				},
			);
			if (!stopped) break;
			await checkStopped(home, count);
		}
		await checkSettled(home, count);
	};

	it("settles after a fault thrown at any one boundary of the runner or of a step", async () => {
		for (const point of points)
			for (const hit of [1, 2]) {
				if (hit === 2 && (point === "format:before" || point === "format:settled")) continue;
				await runs(2, [[{ point, hit, kind: "error" }]]);
			}
	});

	it("settles across generated thrown faults and restarts, whatever the number of steps", async () => {
		const fault = fc.record({
			point: fc.constantFrom(...points),
			hit: fc.integer({ min: 1, max: 3 }),
			kind: fc.constant("error" as const),
		});
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 3 }),
				fc.array(fc.array(fault, { minLength: 1, maxLength: 2 }), { maxLength: 6 }),
				(count, schedules) => runs(count, schedules),
			),
			{ numRuns: pbtRuns(50) },
		);
	});

	it("an upgrade keeps the home as it was beside it, taken before the first step and once", async () => {
		const home = await seeded();
		await (await open(home, { migrations: [] })).close(context);
		const said: string[] = [];
		const before = async (from: number) => void (await backupBeforeUpgrade(home, from, (line) => said.push(line)));
		await migrateHome(home, { migrations: steps(2, () => {}), before });
		const kept = `${home}-backups/before-format-${FORMAT_FLOOR + 1}`;
		// the backup is the home in the format it had: a restore of it opens in the earlier build
		expect((await readManifest(kept)).format).toBe(FORMAT_FLOOR);
		expect(await markOf(home)).toBe(`${FORMAT_FLOOR + 2}\n`);
		expect(said).toEqual([`home: backed up to ${kept} before its upgrade`]);
		// a start killed after the backup and before the first mark asks again: the whole backup there is kept
		const manifest = await readFile(join(kept, "manifest.json"), "utf8");
		await backupBeforeUpgrade(home, FORMAT_FLOOR);
		expect(await readFile(join(kept, "manifest.json"), "utf8")).toBe(manifest);
		await rm(`${home}-backups`, { recursive: true, force: true });
	});

	it("replaces an installation id an earlier build left damaged on its way to wallets, and keeps a whole one", async () => {
		// a format-4 build wrote the id with no flush, and read anything else as none: a power cut could empty it
		for (const [kept, replaced] of [
			["", true],
			["not an id\n", true],
			[`${randomUUID()}\n`, false],
		] as const) {
			const home = await seedKept(await tempHome());
			await mkdir(join(home, "auth"), { recursive: true });
			await writeFile(join(home, "auth", "device-id"), kept);
			await migrateBuild(home, () => {});
			expect(await markOf(home)).toBe(`${HOME_FORMAT}\n`);
			const id = await installationId(home);
			if (replaced) expect(id).toMatch(INSTALLATION_ID);
			else expect(id).toBe(kept.trim());
			await checkBuildSettled(home);
		}
		// a home of the build's format refuses one: its wallet keys may be named by the id it lost
		const home = await tempHome();
		await migrateHome(home);
		await mkdir(join(home, "auth"), { recursive: true });
		await writeFile(join(home, "auth", "device-id"), "");
		await expect(installationId(home)).rejects.toThrow(/makes no new one/);
	});
});
