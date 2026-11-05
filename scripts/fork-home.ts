#!/usr/bin/env node
/**
 * A fork of a home for trying the app with the owner's own setup and conversations, never the home itself: the store
 * copied consistently while its daemon runs (SQLite's backup), its blobs, config and the proxy's credentials, the
 * model providers' sign-in linked rather than copied, and the box's volumes copied into the fork's own box. Routines
 * start paused in the fork. The derived search index is rebuilt by the fork's daemon.
 *
 * The provider sign-in is a link: an OAuth refresh rotates the refresh token, so a copy that refreshed would sign the
 * forked-from home out; through the link both read and write the one file. Two daemons refreshing at the same instant
 * can still race, and the loser signs in again.
 */
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, realpath, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { containerName, dockerAvailable, VOLUMES } from "../src/box/container.ts";
import { Control } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import { resolveHome } from "../src/home.ts";

export type ForkOptions = {
	/** Copy the browser's profile too: the sites the owner signed in to, so the fork can act as them there. */
	readonly browser?: boolean;
	/** Copy the box's volumes (default: when Docker answers and the box exists). */
	readonly volumes?: boolean;
	readonly log?: (line: string) => void;
};

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

/** Fork home `from` into `to` (new or empty), as the module's comment says. What was copied, by name. */
export async function forkHome(from: string, to: string, options: ForkOptions = {}): Promise<string[]> {
	const log = options.log ?? (() => {});
	// a box is named by its home's path as given (resolved, links kept), so the volumes are named the same way
	from = resolve(from);
	to = resolve(to);
	await mkdir(to, { recursive: true });
	if ((await realpath(to)) === (await realpath(from))) throw new Error("a home cannot be forked onto itself");
	if ((await readdir(to)).length > 0) throw new Error(`${to} is not empty`);
	const done: string[] = [];

	// the store, whole and consistent although its daemon writes on
	const source = new DatabaseSync(join(from, "durable.db"), { readOnly: true });
	try {
		await backup(source, join(to, "durable.db"));
	} finally {
		source.close();
	}
	// the format comes with the store it describes: a home of another format is refused where it is served
	if (await exists(join(from, "format"))) await cp(join(from, "format"), join(to, "format"));
	done.push("store");
	if (await exists(join(from, "blobs"))) {
		await cp(join(from, "blobs"), join(to, "blobs"), { recursive: true });
		done.push("blobs");
	}
	if (await exists(join(from, "config.json"))) {
		await copyFile(join(from, "config.json"), join(to, "config.json"));
		done.push("config");
	}

	// the owner's token and the proxy's credentials copied; the providers' sign-in linked; a key and an id of its own
	await mkdir(join(to, "auth"), { recursive: true, mode: 0o700 });
	for (const name of ["token", "egress.json"]) {
		if (!(await exists(join(from, "auth", name)))) continue;
		await copyFile(join(from, "auth", name), join(to, "auth", name));
		done.push(`auth/${name}`);
	}
	if (await exists(join(from, "auth", "providers.json"))) {
		await symlink(await realpath(join(from, "auth", "providers.json")), join(to, "auth", "providers.json"));
		done.push("auth/providers.json (linked)");
	}

	// nothing runs on its own in the fork until the owner resumes it
	const harness = await openStore(to, { models: createModels(), registry: createRegistry() });
	try {
		await harness.commit(async (tx) => {
			const control = await tx.doc(Control);
			control.paused ??= Date.now();
		}, context);
	} finally {
		await harness.close(context);
	}
	done.push("routines paused");

	// the box's files, into volumes of the fork's own box
	const box = containerName(from);
	const volumes = options.volumes ?? ((await dockerAvailable()) && hasContainer(box));
	if (volumes) {
		const image = execFileSync("docker", ["inspect", "--format", "{{.Config.Image}}", box], {
			encoding: "utf8",
		}).trim();
		const into = containerName(to);
		for (const volume of Object.keys(VOLUMES)) {
			if (volume === "browser" && !options.browser) continue;
			log(`copying the box's ${volume}…`);
			execFileSync(
				"docker",
				[
					"run",
					"--rm",
					"--network",
					"none",
					"--user",
					"0",
					"--mount",
					`type=volume,src=${box}-${volume},dst=/from,readonly`,
					"--mount",
					`type=volume,src=${into}-${volume},dst=/to`,
					"--entrypoint",
					"sh",
					image,
					"-c",
					"cp -a /from/. /to/",
				],
				{ stdio: "inherit", timeout: 30 * 60_000 },
			);
			done.push(`box ${volume}`);
		}
	}
	return done;
}

function hasContainer(name: string): boolean {
	try {
		execFileSync("docker", ["container", "inspect", name], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const usage = `Fork a home for trying the app with your own setup (Node 26)
  npm run home:fork -- [--from <home>] [--to <dir>] [--browser] [--no-volumes]
--from defaults to $BANDA_HOME or ~/.banda, which is only read. --to defaults to a new temporary directory.
--browser also copies the browser's signed-in sites. Then:
  BANDA_HOME=<dir> node dist/cli/index.js serve --port 0`;

async function main() {
	const { values } = parseArgs({
		options: {
			from: { type: "string" },
			to: { type: "string" },
			browser: { type: "boolean" },
			"no-volumes": { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	if (values.help) return console.log(usage);
	const from = resolveHome(values.from);
	const to = values.to ?? (await mkdtemp(join(tmpdir(), "banda-fork-")));
	const done = await forkHome(from, to, {
		...(values.browser ? { browser: true } : {}),
		...(values["no-volumes"] ? { volumes: false } : {}),
		log: (line) => console.error(line),
	});
	console.log(`forked ${from} into ${to}: ${done.join(", ")}`);
	console.log(`run it: BANDA_HOME=${to} node dist/cli/index.js serve --port 0`);
	console.log("routines are paused there; resume them in the app if you want them to run");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
