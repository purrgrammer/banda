/**
 * Makes a home as this build leaves one, to be kept under `test/fixtures/homes/<name>/` for every later build to open
 * (`test/home-upgrade.test.ts` says when one is due): `node test/fixtures/homes/make.ts [name]`, the name by default
 * the version in package.json. A real daemon, on pi-ai's faux provider and the host box, takes two chats from the CLI;
 * then a permission and a device are stored through the build's own definitions. All of it is invented: the repository
 * is public. A fixture is made once and never again: it refuses a name that exists.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { LEAD } from "../../../src/core/agents.ts";
import { Devices } from "../../../src/core/devices.ts";
import { Permissions } from "../../../src/core/permissions.ts";
import { context, openStore } from "../../../src/core/store.ts";
import { startDaemon } from "../../../src/daemon.ts";
import { hostBox } from "../host-box.ts";
import { echoModels } from "../models.ts";

/** What a fixture holds, for the test that opens it: kept beside it as `expected.json`. */
export type Expected = {
	/**
	 * What was said in each chat and what came back. `thread` is "" for the first agent's chat; a home from before the
	 * CLI wrote to an agent's one chat kept a chat of the CLI's own per thread, which the store still holds.
	 */
	readonly said: { readonly thread: string; readonly text: string; readonly reply: string }[];
	readonly permissions: unknown;
	readonly devices: unknown;
};

/** The home's files a fixture keeps: the store, its format, the config, and the definitions the store accepted. */
export const KEPT = ["format", "durable.db", "config.json", "workspace/agents"] as const;

if (process.argv[1] === fileURLToPath(import.meta.url)) await make();

async function make(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const version = (JSON.parse(await readFile(join(here, "../../../package.json"), "utf8")) as { version: string })
		.version;
	const to = join(here, process.argv[2] ?? version);
	if (existsSync(to)) throw new Error(`${to} exists: a fixture is made once`);
	// one path on every machine: the host box's prompt names its workspace, and the store keeps the prompt
	const home = "/tmp/banda-home-fixture";
	await rm(home, { recursive: true, force: true });
	await mkdir(home, { mode: 0o700 });
	process.env.BANDA_REMOTE = "off";
	try {
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const daemon = await startDaemon({ home, port: 0, models: echoModels().models, log: () => {}, box: hostBox(home) });
		const said: Expected["said"][number][] = [];
		try {
			for (const text of ["is anyone there", "the tide tables for Thursday", "and for Friday"]) {
				const { stdout } = await promisify(execFile)(process.execPath, [
					join(here, "../../../src/cli/index.ts"),
					"say",
					text,
					"--home",
					home,
				]);
				said.push({ thread: "", text, reply: stdout.trimEnd() });
			}
		} finally {
			await daemon.close();
		}
		const store = await openStore(home, { models: createModels(), registry: createRegistry() });
		let permissions: unknown;
		let devices: unknown;
		try {
			await store.commit(async (tx) => {
				const given = await tx.doc(Permissions);
				given.permissions["1"] = {
					tool: "tides__read",
					match: { port: "Vigo" },
					what: "read the tide tables for Vigo",
					scope: "always",
					agent: LEAD,
					at: 1_700_000_000_000,
					wait: 0,
				};
				given.next = 2;
				const paired = await tx.doc(Devices);
				paired.devices["a".repeat(64)] = { name: "Pixel", paired: 1_700_000_000_000 };
				paired.devices["b".repeat(64)] = { name: "Tablet", paired: 1_700_000_000_000, revoked: 1_700_000_100_000 };
			}, context);
			permissions = await store.snapshot(Permissions, context);
			devices = await store.snapshot(Devices, context);
		} finally {
			await store.close(context);
		}
		if (existsSync(join(home, "durable.db-wal")))
			throw new Error("the store left a write-ahead log: not all in one file");
		await mkdir(to);
		for (const kept of KEPT) await cp(join(home, kept), join(to, kept), { recursive: true });
		// the publications folder under agents is the daemon's work in flight, not a definition
		await rm(join(to, "workspace/agents/.banda-publications"), { recursive: true, force: true });
		const expected: Expected = { said, permissions, devices };
		await writeFile(join(to, "expected.json"), `${JSON.stringify(expected, null, "\t")}\n`);
		console.log(to);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}
