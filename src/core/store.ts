/** The one store: pi-durable over `<home>/durable.db`. Only the daemon opens it. */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type HarnessOptions, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { isGroupTools } from "./toolsets.ts";

/** Chord's never-cancelling context, for every call that has no narrower one. */
export const context: Context = BACKGROUND_CONTEXT;

export type StoreOptions = HarnessOptions & {
	/** Wraps the storage the Harness commits through; fault injection in tests crashes around its commits. */
	readonly wrapStorage?: (storage: Storage) => Storage;
};

/**
 * The shape of a home this build reads. Pre-release, stored shapes change in place without migrations, so a home made
 * by a build of another format is refused, plainly, rather than opened into odd failures.
 */
export const HOME_FORMAT = 3;

export class OldHome extends Error {}

/** Refuse a home of another format; mark a new home with this one. */
async function checkFormat(home: string): Promise<void> {
	const marker = join(home, "format");
	const stored = await readFile(marker, "utf8").catch(() => undefined);
	if (stored === undefined) {
		if (existsSync(join(home, "durable.db")))
			throw new OldHome(
				`${home} was made by an earlier build of banda, which this one cannot read. Start a fresh home (BANDA_HOME=<a new folder>), or use the build that made it.`,
			);
		await writeFile(marker, `${HOME_FORMAT}\n`);
		return;
	}
	if (Number(stored.trim()) !== HOME_FORMAT)
		throw new OldHome(
			`${home} is in format ${stored.trim()}, and this build of banda reads format ${HOME_FORMAT}. Start a fresh home (BANDA_HOME=<a new folder>), or use the build that made it.`,
		);
}

export async function openStore(
	home: string,
	{ wrapStorage, ...options }: StoreOptions,
	ctx: Context = context,
): Promise<Harness> {
	await mkdir(home, { recursive: true });
	await checkFormat(home);
	const opened = await openNodeSqliteStorage(join(home, "durable.db"));
	const storage = wrapStorage === undefined ? opened : wrapStorage(opened);
	try {
		return await Harness.open(
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
	} catch (error) {
		await storage.close(ctx).catch(() => undefined);
		throw error;
	}
}
