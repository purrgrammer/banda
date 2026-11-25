/**
 * What the backup suites share (test/backup.test.ts, test/backup.faults.test.ts): a home with a real store and every
 * kind of file a backup carries or leaves, the reading that compares a restored home with it, and the invariant a
 * kill must not break: a backup or a home that exists is whole, and a stage is never read as one.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { BackupPoint } from "../../src/core/backup.ts";
import { MANIFEST } from "../../src/core/backup.ts";
import { RESTORED_MARKER, Restored } from "../../src/core/restored.ts";
import { Control } from "../../src/core/routines.ts";
import { context, openStore } from "../../src/core/store.ts";

export const BACKUP_POINTS: readonly BackupPoint[] = [
	"backup:staged",
	"backup:blobs",
	"backup:store",
	"backup:files",
	"backup:computer",
	"backup:manifest",
	"backup:renamed",
];
export const RESTORE_POINTS: readonly BackupPoint[] = [
	"restore:staged",
	"restore:copied",
	"restore:verified",
	"restore:renamed",
];

export const open = (home: string) => openStore(home, { models: createModels(), registry: createRegistry() });

/** The fact the seeded store holds, read from a home's store. */
export async function chatOf(home: string): Promise<number | undefined> {
	const harness = await open(home);
	try {
		return (await harness.snapshot(Control, context))?.chat;
	} finally {
		await harness.close(context);
	}
}

const BLOB = "ab".repeat(32);

/** A home as a daemon leaves it: a store that holds `chat`, and what lives beside it. */
export async function seed(home: string, chat = 7): Promise<void> {
	const harness = await open(home);
	try {
		await harness.commit(async (tx) => {
			(await tx.doc(Control)).chat = chat;
		}, context);
	} finally {
		await harness.close(context);
	}
	const put = (path: string, bytes: string, mode?: number) => {
		mkdirSync(dirname(join(home, path)), { recursive: true });
		writeFileSync(join(home, path), bytes, mode === undefined ? {} : { mode });
	};
	put("config.json", '{"model":{"provider":"openai","modelId":"x"}}');
	mkdirSync(join(home, "auth"), { mode: 0o700 });
	put("auth/token", "owner-token\n", 0o600);
	put("auth/providers.json", '{"openai":{"type":"api_key","key":"k"}}', 0o600);
	put("auth/connections/slack.json", "{}", 0o600);
	put(`blobs/ab/${BLOB}`, "blob bytes");
	put("computer/workspace/agents/sancho.md", "# Sancho\n");
	put("computer/workspace/memory/notes.md", "remember\n");
	symlinkSync("agents/sancho.md", join(home, "computer/workspace/lead.md"));
	put("computer/work/repo/build.log", "x".repeat(4096));
	put("computer/tools/bin/tool", "#!/bin/sh\n", 0o755);
	put("computer/browser/Default/Cookies", "signed-in");
	put("computer/proxy/kept/1", "held");
	// what a backup leaves: derived, or a running daemon's
	put("search.db", "derived");
	put("cache/models.json", "{}");
	put("daemon.json", '{"pid":1}');
	put("daemon.log", "started\n");
	put("computer/runtime/socket", "runtime");
}

/** What a restore of `seed` brings back, besides the store. */
export const CARRIED = [
	"format",
	"config.json",
	"auth",
	"blobs",
	...["workspace", "work", "tools", "proxy", "browser"].map((name) => `computer/${name}`),
] as const;
/** What it never does. */
export const LEFT = ["search.db", "cache", "daemon.json", "daemon.log", "daemon.lock", "computer/runtime"] as const;

/** Every file and link under `root/<names>`, by path: its bytes' hash, or where it points; and its mode. */
export function reading(root: string, names: readonly string[] = CARRIED): Record<string, string> {
	const found: Record<string, string> = {};
	const visit = (path: string) => {
		const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
		if (stat === undefined) return;
		const mode = (stat.mode & 0o777).toString(8);
		if (stat.isSymbolicLink()) found[path] = `link ${readlinkSync(join(root, path))}`;
		else if (stat.isDirectory()) {
			found[`${path}/`] = mode;
			for (const name of readdirSync(join(root, path)).sort()) visit(`${path}/${name}`);
		} else
			found[path] = `${mode} ${createHash("sha256")
				.update(readFileSync(join(root, path)))
				.digest("hex")}`;
	};
	for (const name of names) visit(name);
	return found;
}

/** The stages left beside `path`, a backup's or a restore's. */
export const stages = (path: string): string[] =>
	lstatSync(dirname(path), { throwIfNoEntry: false }) === undefined
		? []
		: readdirSync(dirname(path)).filter((name) => name.startsWith(`.${basename(path)}.`));

const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/**
 * Whether a finished backup is at `to` and a home at `home`, as whoever comes next reads them; throws on a half of
 * either: a backup folder with no manifest, or a home that lacks any of what the manifest names.
 */
export function whole(to: string, home: string): { backup: boolean; home: boolean } {
	const backup = present(to);
	if (backup && !present(join(to, MANIFEST))) throw new Error(`${to} is half a backup`);
	const restored = present(home);
	if (restored) {
		const manifest = JSON.parse(readFileSync(join(to, MANIFEST), "utf8")) as {
			files: Record<string, unknown>;
			trees: Record<string, unknown>;
		};
		for (const name of [...Object.keys(manifest.files), ...Object.keys(manifest.trees)])
			if (!present(join(home, name))) throw new Error(`${home} is half a home: no ${name}`);
		// the home's binding reads the mark at every start: a restored home without a whole one could never sign
		let mark: unknown;
		try {
			mark = JSON.parse(readFileSync(join(home, RESTORED_MARKER), "utf8"));
		} catch {}
		if (!Value.Check(Restored, mark)) throw new Error(`${home} has no valid restore mark`);
	}
	return { backup, home: restored };
}
