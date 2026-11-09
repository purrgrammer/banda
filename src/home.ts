/** The home (DESIGN.md "Home"): `~/.banda`, `--home <dir>` or `BANDA_HOME`. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";

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

/** A stable installation ID for provider sign-in flows. It is not a credential. */
export async function deviceId(home: string): Promise<string> {
	const path = join(home, "auth", "device-id");
	try {
		const id = (await readFile(path, "utf8")).trim();
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(join(home, "auth"), { recursive: true, mode: 0o700 });
	const id = randomUUID();
	await writeFile(path, `${id}\n`, { mode: 0o600 });
	return id;
}

/** The web UI's link. The token rides in the fragment, which the browser never sends; the UI keeps it and drops it. */
export const webLink = (port: number, token: string) => `http://127.0.0.1:${port}/#token=${token}`;
