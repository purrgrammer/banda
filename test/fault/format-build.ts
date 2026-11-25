/**
 * The build's own steps, on a kept home of the format before the build's: what a daemon's start does to an owner's home
 * after an upgrade, with the backup it takes before the first step. What must hold wherever it stopped, and once it
 * settled.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { Devices } from "../../src/core/devices.ts";
import {
	backupBeforeUpgrade,
	type FormatPoint,
	HOME_FORMAT,
	INSTALLATION_ID,
	MIGRATIONS,
	migrateHome,
	NewerHome,
} from "../../src/core/format.ts";
import { Permissions } from "../../src/core/permissions.ts";
import { context, openStore } from "../../src/core/store.ts";
import { Incoming, Wallets } from "../../src/wallet/docs.ts";
import type { Expected } from "../fixtures/homes/make.ts";

/** The boundaries inside the build's step to format 5, which a home with a damaged installation id passes once each. */
export const ID_POINTS: readonly FormatPoint[] = ["format:id:written", "format:id:renamed"];

/** The format the build's last step starts from. */
export const PREVIOUS = HOME_FORMAT - 1;
/** The kept home of that format. */
export const KEPT = join(import.meta.dirname, "../fixtures/homes", `format-${PREVIOUS}`);

/** A copy of the kept home, in a folder of its own so its backups land beside it there. */
export async function seedKept(parent: string): Promise<string> {
	const home = join(parent, "home");
	await mkdir(home);
	await cp(KEPT, home, { recursive: true });
	return home;
}

export const migrateBuild = (home: string, hit: (point: FormatPoint) => void) =>
	migrateHome(home, { before: async (from) => void (await backupBeforeUpgrade(home, from)), hit });

/** A build of the previous format, as an owner who went back to it would start one. */
const previousBuild = (home: string) =>
	migrateHome(home, { migrations: MIGRATIONS.slice(0, -1) }).then(
		() => "opened",
		(error: unknown) => (error instanceof NewerHome ? "refused" : String(error)),
	);

/** Wherever it stopped: the previous build opens the home only while no step began, and the store is as kept. */
export async function checkBuildStopped(home: string): Promise<void> {
	const mark = (await readFile(join(home, "format"), "utf8")).trim();
	const begun = mark !== `${PREVIOUS}`;
	if (begun && mark !== `${PREVIOUS} to ${HOME_FORMAT}` && mark !== `${HOME_FORMAT}`)
		throw new Error(`the mark is ${JSON.stringify(mark)}`);
	if (begun && !existsSync(join(`${home}-backups`, `before-format-${HOME_FORMAT}`, "manifest.json")))
		throw new Error("a step began with no whole backup beside the home");
	const previous = await previousBuild(home);
	if (previous !== (begun ? "refused" : "opened"))
		throw new Error(`the previous build ${previous} a home marked ${mark}`);
	await checkIdStopped(home);
}

/**
 * Wherever it stopped, the installation id is the one the home was kept with or a whole one; once a whole one replaced
 * a damaged one, every later stop and the settled home keep that same id (kept beside the home, across processes).
 */
async function checkIdStopped(home: string): Promise<void> {
	const id = await readMaybe(join(home, "auth", "device-id"));
	const kept = await readMaybe(join(home, "..", "kept-id"));
	if (id === undefined || id === "") return;
	if (!INSTALLATION_ID.test(id.trim())) throw new Error(`the installation id reads ${JSON.stringify(id)}`);
	if (kept === undefined) await writeFile(join(home, "..", "kept-id"), id);
	else if (kept !== id)
		throw new Error(`the installation id moved from ${JSON.stringify(kept)} to ${JSON.stringify(id)}`);
}

const readMaybe = (path: string) =>
	readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});

/**
 * Once settled: the build's format, every doc the kept home holds reads as kept, and the previous build refuses it. The
 * wallets, the payments, the money that came in and the config's wallets are compared only where the kept home holds
 * them, a home of format 5 or later: the step to format 5 starts from a home with none, so they are first compared from
 * the step that starts at format 5.
 */
export async function checkBuildSettled(home: string): Promise<void> {
	const mark = await readFile(join(home, "format"), "utf8");
	if (mark !== `${HOME_FORMAT}\n`) throw new Error(`the mark is ${JSON.stringify(mark)}`);
	await checkBuildStopped(home);
	const expected = JSON.parse(await readFile(join(KEPT, "expected.json"), "utf8")) as Expected;
	const store = await openStore(home, { models: createModels(), registry: createRegistry() });
	try {
		const read: [string, unknown, unknown][] = [
			["permissions", expected.permissions, await store.snapshot(Permissions, context)],
			["devices", expected.devices, await store.snapshot(Devices, context)],
		];
		if (expected.wallets !== undefined)
			read.push(["wallets", expected.wallets, await store.snapshot(Wallets, context)]);
		if (expected.incoming !== undefined)
			read.push(["incoming", expected.incoming, await store.snapshot(Incoming, context)]);
		if (expected.config !== undefined) {
			const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { wallets?: unknown };
			read.push(["config's wallets", expected.config, { wallets: config.wallets }]);
		}
		for (const [what, kept, now] of read)
			if (JSON.stringify(now) !== JSON.stringify(kept))
				throw new Error(`the store's ${what} reads ${JSON.stringify(now)}, not what was kept`);
	} finally {
		await store.close(context);
	}
	await checkIdSettled(home);
}

/**
 * The installation id once settled, against the one the backup before the step kept: a whole one is kept as it was,
 * a damaged one (an earlier build's, written with no flush) is replaced by a whole one, and none stays none.
 */
async function checkIdSettled(home: string): Promise<void> {
	const read = readMaybe;
	if (existsSync(join(home, "auth", "device-id.tmp"))) throw new Error("the id's temporary file was left");
	const before = await read(join(`${home}-backups`, `before-format-${HOME_FORMAT}`, "auth", "device-id"));
	const now = await read(join(home, "auth", "device-id"));
	if (before === undefined ? now !== undefined : !INSTALLATION_ID.test(now?.trim() ?? ""))
		throw new Error(`the installation id reads ${JSON.stringify(now)} after ${JSON.stringify(before)}`);
	if (before !== undefined && INSTALLATION_ID.test(before.trim()) && now !== before)
		throw new Error("a whole installation id was replaced");
}

/** A copy of the kept home whose installation id an earlier build left empty: a power cut after its unflushed write. */
export async function seedDamagedId(parent: string): Promise<string> {
	const home = await seedKept(parent);
	await mkdir(join(home, "auth"), { recursive: true });
	await writeFile(join(home, "auth", "device-id"), "");
	return home;
}
