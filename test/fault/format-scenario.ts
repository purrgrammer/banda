/**
 * Test-only migrations and what must hold around them. They prove the runner's ordering (`src/core/format.ts`) on steps
 * that write: a home in the floor's format with a ledger file, each step adding its own format to the ledger with a
 * file written whole and renamed, and a `before` that copies the ledger as a backup would. `format-build.ts` runs the
 * build's own last step on a kept home.
 */
import { open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FORMAT_FLOOR, type FormatPoint, type Migration, migrateHome, NewerHome } from "../../src/core/format.ts";

/** Inside a test step: before its write, once the new ledger is on disk beside the old, once it replaced it. */
export type StepPoint = "format:step:before" | "format:step:written" | "format:step:renamed";
export type Hit = (point: FormatPoint | StepPoint) => void;

export const FORMAT_POINTS: readonly FormatPoint[] = [
	"format:before",
	"format:marked",
	"format:migrated",
	"format:settled",
];
export const STEP_POINTS: readonly StepPoint[] = ["format:step:before", "format:step:written", "format:step:renamed"];

type Ledger = { format: number; applied: number[] };
const ledgerOf = async (home: string, name = "ledger.json") =>
	JSON.parse(await readFile(join(home, name), "utf8")) as Ledger;

/** A home as a build at the floor left it. */
export async function seed(home: string): Promise<void> {
	await writeFile(join(home, "format"), `${FORMAT_FLOOR}\n`);
	await writeFile(join(home, "ledger.json"), JSON.stringify({ format: FORMAT_FLOOR, applied: [] } satisfies Ledger));
}

/** `count` steps from the floor, each safe to run again wherever a kill left it. */
export function steps(count: number, hit: Hit): Migration[] {
	return Array.from({ length: count }, (_, i) => {
		const from = FORMAT_FLOOR + i;
		return {
			what: `the ledger, step ${i + 1}`,
			run: async (home: string) => {
				const ledger = await ledgerOf(home);
				// the runner starts a step only on a home the step before finished
				if (ledger.format < from) throw new Error(`step ${from} ran on a home in format ${ledger.format}`);
				// a run killed after its rename: done already
				if (ledger.format > from) return;
				hit("format:step:before");
				const path = join(home, "ledger.json");
				const file = await open(`${path}.tmp`, "w");
				try {
					await file.writeFile(JSON.stringify({ format: from + 1, applied: [...ledger.applied, from] }));
					await file.sync();
				} finally {
					await file.close();
				}
				hit("format:step:written");
				await rename(`${path}.tmp`, path);
				hit("format:step:renamed");
			},
		};
	});
}

/** What a backup does: a copy of the home as it is when asked, over any copy before. */
export const backUp = (home: string) => async (from: number, to: number) => {
	await writeFile(join(home, "backup.json"), JSON.stringify({ from, to, ledger: await ledgerOf(home) }));
};

export const migrate = (home: string, count: number, hit: Hit) =>
	migrateHome(home, { migrations: steps(count, hit), before: backUp(home), hit });

/**
 * Wherever a run stopped: the mark never names more than was done, the backup holds the home as it was before any
 * step, and a build of the floor's format refuses a home a step may have touched.
 */
export async function checkStopped(home: string, count: number): Promise<void> {
	const mark = (await readFile(join(home, "format"), "utf8")).trim();
	const ledger = await ledgerOf(home);
	const read = /^(\d+)(?: to (\d+))?$/.exec(mark);
	if (read === null) throw new Error(`the mark is ${JSON.stringify(mark)}`);
	const at = Number(read[1]);
	if (ledger.format !== at && !(read[2] !== undefined && ledger.format === at + 1))
		throw new Error(`the mark is ${mark} and the ledger is in format ${ledger.format}`);
	if (ledger.applied.join() !== Array.from({ length: ledger.format - FORMAT_FLOOR }, (_, i) => FORMAT_FLOOR + i).join())
		throw new Error(`the ledger applied ${ledger.applied.join()} to reach format ${ledger.format}`);
	if (ledger.format > FORMAT_FLOOR || read[2] !== undefined) await checkBackup(home, count);
	const floorBuild = await migrateHome(home, { migrations: [] }).then(
		() => "opened",
		(error: unknown) => (error instanceof NewerHome ? "refused" : String(error)),
	);
	const expected = mark === `${FORMAT_FLOOR}` ? "opened" : "refused";
	if (floorBuild !== expected) throw new Error(`a build of the floor's format ${floorBuild} a home marked ${mark}`);
}

/** Once it finished: the build's format, every step applied once and in order, the backup from before the first. */
export async function checkSettled(home: string, count: number): Promise<void> {
	const mark = await readFile(join(home, "format"), "utf8");
	if (mark !== `${FORMAT_FLOOR + count}\n`) throw new Error(`the mark is ${JSON.stringify(mark)}`);
	const ledger = await ledgerOf(home);
	const expected = Array.from({ length: count }, (_, i) => FORMAT_FLOOR + i);
	if (ledger.format !== FORMAT_FLOOR + count || ledger.applied.join() !== expected.join())
		throw new Error(`the ledger is ${JSON.stringify(ledger)}`);
	if (count > 0) await checkBackup(home, count);
}

async function checkBackup(home: string, count: number): Promise<void> {
	const backup = JSON.parse(await readFile(join(home, "backup.json"), "utf8")) as {
		from: number;
		to: number;
		ledger: Ledger;
	};
	const pristine = { from: FORMAT_FLOOR, to: FORMAT_FLOOR + count, ledger: { format: FORMAT_FLOOR, applied: [] } };
	if (JSON.stringify(backup) !== JSON.stringify(pristine))
		throw new Error(`the backup is ${JSON.stringify(backup)}, not the home as it was before the first step`);
}
