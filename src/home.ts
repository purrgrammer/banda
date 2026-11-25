/** The home (DESIGN.md "Home"): `~/.banda`, `--home <dir>` or `BANDA_HOME`. */
import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { NetworkId } from "./wallet/networks.ts";

/**
 * An installation id as `installationId` writes it. Here, not in src/core/format.ts, which imports it: every command
 * loads this module, and it imports node's builtins alone, so none of them pays for the store's modules.
 */
export const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveHome(flag?: string): string {
	return flag ?? process.env.BANDA_HOME ?? join(homedir(), ".banda");
}

export type Config = {
	/** The model new chats run with. */
	readonly model: ModelRef;
	/** What one file may weigh, in bytes, wherever it comes from or goes: an upload, a message's file, a document. */
	readonly files?: { readonly maxBytes?: number };
	/** The forges whose git fetches are reads, default the public ones banda lists. */
	readonly egress?: { readonly git?: readonly string[] };
	/**
	 * Where the owner's devices reach the daemon over Iroh (`server/remote.ts`): `reach` is `n0` (the default, n0's
	 * public relays), `loopback` (this computer only) or `off`; `relay` a relay's URL in place of n0's. `BANDA_REMOTE`
	 * overrides `reach`.
	 */
	readonly remote?: { readonly reach?: "n0" | "loopback" | "off"; readonly relay?: string };
	/** Each network's RPC by network id (`src/wallet/networks.ts`); an absent one takes the default banda ships. */
	readonly wallets?: { readonly rpc?: Readonly<Partial<Record<NetworkId, string>>> };
};

/**
 * A credential the egress proxy sets for a host: the header and its whole value ("Bearer …"), over https only unless it
 * names `scheme: "http"` (a forge on the owner's own network).
 */
export type EgressCredential = {
	readonly host: string;
	readonly header: string;
	readonly value: string;
	readonly scheme?: "http";
};

/**
 * `<home>/auth/egress.json`: credentials the proxy sets for their hosts, so the box never holds them (DESIGN.md "The
 * box", Network): `{ "credentials": [{ "host", "header", "value", "scheme"? }] }`. Read at every push, so an edit takes effect at
 * the next one. A malformed file sets none, and says why.
 */
export async function egressCredentials(
	home: string,
	log: (line: string) => void = () => {},
): Promise<EgressCredential[]> {
	let text: string;
	try {
		text = await readFile(join(home, "auth", "egress.json"), "utf8");
	} catch {
		return [];
	}
	try {
		const parsed = JSON.parse(text) as { credentials?: unknown };
		const credentials = Array.isArray(parsed.credentials) ? parsed.credentials : [];
		return credentials.flatMap((c: unknown) => {
			const { host, header, value, scheme } = (c ?? {}) as Record<string, unknown>;
			return typeof host === "string" && typeof header === "string" && typeof value === "string" && host !== ""
				? [{ host: host.toLowerCase(), header, value, ...(scheme === "http" ? { scheme: "http" as const } : {}) }]
				: [];
		});
	} catch (error) {
		log(`auth/egress.json: ${(error as Error).message}`);
		return [];
	}
}

/**
 * Keep `credential` in `auth/egress.json`, replacing one for the same host and header: a key the owner let the daemon
 * keep from a page. Written whole and renamed into place, owner-only, so a crash leaves the old file or the new one.
 */
export async function keepEgressCredential(home: string, credential: EgressCredential): Promise<void> {
	const kept = (await egressCredentials(home)).filter(
		(c) => !(c.host === credential.host.toLowerCase() && c.header.toLowerCase() === credential.header.toLowerCase()),
	);
	kept.push({ ...credential, host: credential.host.toLowerCase() });
	await mkdir(join(home, "auth"), { recursive: true, mode: 0o700 });
	const path = join(home, "auth", "egress.json");
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ credentials: kept }, null, "\t")}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

/** 50 MB. */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** What one file may weigh, from the config; a value that is not a positive whole number of bytes is refused. */
export function maxFileBytes(config: Config): number {
	const value = config.files?.maxBytes;
	if (value === undefined) return DEFAULT_MAX_FILE_BYTES;
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new Error(`config.json: files.maxBytes must be a positive whole number of bytes, not ${value}`);
	return value;
}

/** The model banda runs when config.json names none: not the owner's pick, so first run still asks them. */
export const DEFAULT_MODEL: ModelRef = { provider: "anthropic", modelId: "claude-opus-5-5" };
const DEFAULT_CONFIG: Config = { model: DEFAULT_MODEL };

/** `<home>/config.json`; absent fields take their defaults. */
export async function readConfig(home: string): Promise<Config> {
	let text: string;
	try {
		text = await readFile(join(home, "config.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
		throw error;
	}
	return { ...DEFAULT_CONFIG, ...(JSON.parse(text) as Partial<Config>) };
}

/** `<home>/daemon.json`: the running daemon's pid, and once it listens, its port and token. Owner-only. */
export type DaemonFile = { readonly pid: number; readonly port?: number; readonly token?: string };

export const daemonFile = (home: string) => join(home, "daemon.json");

export async function readDaemonFile(home: string): Promise<DaemonFile | undefined> {
	try {
		return JSON.parse(await readFile(daemonFile(home), "utf8")) as DaemonFile;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * `<home>/auth/token`: the owner's token for the daemon's API, made on first use and kept, so a restart does not sign
 * the browser out. Deleting the file rotates it at the next start. Owner-only.
 */
export async function ownerToken(home: string): Promise<string> {
	const path = join(home, "auth", "token");
	try {
		const token = (await readFile(path, "utf8")).trim();
		if (/^[\w-]{43}$/.test(token)) return token;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(join(home, "auth"), { recursive: true, mode: 0o700 });
	const token = randomBytes(32).toString("base64url");
	await writeFile(path, `${token}\n`, { mode: 0o600 });
	return token;
}

/**
 * A stable installation ID: provider sign-in flows send it, and the wallets' signer names the home's keychain items by
 * it, so it never changes once made. It is made once, on disk before it is answered: written whole to a temporary
 * file, flushed, linked into place only if no other process made it first, and its folder flushed, so a power cut
 * leaves either no id or the whole one. On a filesystem without hard links (an exFAT or FAT drive, many network
 * shares) the flushed file is renamed into place instead, once none is there: what makes the id runs in the daemon,
 * under its lock on the home, and this process makes one id at a time, so nothing else makes it meanwhile. A file that
 * is there but holds no id is refused, never replaced: a new id would leave every wallet key under the old one out of
 * reach. It is not a credential.
 */
export function installationId(
	home: string,
	options: { readonly hit?: (point: IdPoint) => void } = {},
): Promise<string> {
	const path = resolve(join(home, "auth", "device-id"));
	const running = making.get(path);
	if (running !== undefined) return running;
	const made = makeId(home, path, options.hit ?? (() => {})).finally(() => making.delete(path));
	making.set(path, made);
	return made;
}

/** The ids this process is making, by their file. */
const making = new Map<string, Promise<string>>();

/** What `link` fails with where the filesystem has no hard links. */
const NO_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "ENOSYS"]);

/**
 * The boundaries of making a home's id, for the fault suites (principle 10): its temporary file written and flushed, and
 * the id in place, linked or renamed, before its folder is flushed.
 */
export type IdPoint = "home:id:written" | "home:id:linked";

/** Whether the process `pid` still runs: one that does may be making its id now, so its temporary file stays. */
function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Removes the temporary files of the id that processes killed while making it left in `auth/` (`device-id.<pid>.*`). */
async function sweepIdTemporaries(path: string): Promise<void> {
	const name = `${path.slice(dirname(path).length + 1)}.`;
	let entries: string[];
	try {
		entries = await readdir(dirname(path));
	} catch {
		return;
	}
	for (const entry of entries) {
		const pid = Number(entry.slice(name.length).split(".")[0]);
		if (!entry.startsWith(name) || !entry.endsWith(".tmp") || !Number.isInteger(pid)) continue;
		if (pid !== process.pid && !running(pid)) await rm(join(dirname(path), entry), { force: true });
	}
}

/** Flushes each folder `mkdir` made on the way to `folder`, from its parent: their entries survive a power cut too. */
async function syncMade(folder: string, made: string | undefined): Promise<void> {
	if (made === undefined || process.platform === "win32") return;
	for (let at = folder; at !== dirname(made); at = dirname(at)) {
		const directory = await open(dirname(at), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
}

async function makeId(home: string, path: string, hit: (point: IdPoint) => void): Promise<string> {
	await sweepIdTemporaries(path);
	const kept = await readId(path);
	if (kept !== undefined) return kept;
	madeIds.add(path);
	const auth = join(home, "auth");
	// the `auth` entry is flushed into the home's folder (and each folder made on the way), so a power cut never loses
	// the folder the id is in: made here, or by the token's write at the same start, which flushes nothing
	await syncMade(auth, (await mkdir(auth, { recursive: true, mode: 0o700 })) ?? auth);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(`${randomUUID()}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		hit("home:id:written");
		try {
			await link(temporary, path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (code === "EEXIST") {
				// another process made it first: its id stands
			} else if (NO_LINKS.has(code)) {
				if ((await readId(path)) === undefined) await rename(temporary, path);
			} else throw error;
		}
		hit("home:id:linked");
	} finally {
		await rm(temporary, { force: true });
	}
	if (process.platform !== "win32") {
		const directory = await open(join(home, "auth"), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
	const made = await readId(path);
	if (made === undefined) throw new Error(`${path} was made but cannot be read back`);
	return made;
}

/**
 * The home's installation id as it is kept, never made: undefined when its file is missing, refused when the file holds
 * anything else. What reads the id of a home that may hold wallets uses it, so no path makes a new id where the old one
 * names every wallet key (H-261).
 */
export const readInstallationId = (home: string): Promise<string | undefined> =>
	readId(join(home, "auth", "device-id"));

/** The ids this process made, by their file: a home that had wallets and finds its id made new lost the old one. */
const madeIds = new Set<string>();

/**
 * Whether this process made `home`'s installation id because its file was missing: in a home that had wallets, the id
 * that names their keychain items is gone, and the wallets refuse to run on the new one (`identityLost`).
 */
export const madeInstallationId = (home: string): boolean => madeIds.has(resolve(join(home, "auth", "device-id")));

/** The id at `path`; undefined when there is no file, refused when the file holds anything else. */
async function readId(path: string): Promise<string | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const id = raw.trim();
	if (INSTALLATION_ID.test(id)) return id;
	throw new Error(
		`${path} holds no installation id: banda names this home's wallet keys by it, so it makes no new one. Put back the id this home had; only a home that never made a wallet may delete the file for a new one`,
	);
}

/** The web UI's link. The token rides in the fragment, which the browser never sends; the UI keeps it and drops it. */
export const webLink = (port: number, token: string) => `http://127.0.0.1:${port}/#token=${token}`;
