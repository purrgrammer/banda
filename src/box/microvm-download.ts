import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileSha256, type MicrovmAssets, type MicrovmBrowser } from "./microvm-assets.ts";

const PUBLISHERS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const MAX_REDIRECTS = 4;
const DOWNLOAD_MS = 15 * 60_000;

async function cacheDirectory(home: string): Promise<string> {
	let directory = await realpath(home);
	for (const part of ["cache", "computer", "browser"]) {
		directory = join(directory, part);
		await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		});
		const info = await lstat(directory);
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			(process.getuid !== undefined && info.uid !== process.getuid()) ||
			(info.mode & 0o022) !== 0
		)
			throw new Error("The browser cache must be an app-owned directory outside the computer's writable files.");
	}
	return directory;
}

function publisher(address: string): URL {
	const url = new URL(address);
	if (
		url.protocol !== "https:" ||
		!PUBLISHERS.has(url.hostname) ||
		(url.port !== "" && url.port !== "443") ||
		url.username !== "" ||
		url.password !== ""
	)
		throw new Error("The browser download was redirected outside its trusted publisher.");
	return url;
}

async function responseFor(address: string, fetcher: typeof fetch, signal: AbortSignal): Promise<Response> {
	let url = publisher(address);
	for (let redirects = 0; ; redirects++) {
		const response = await fetcher(url, { redirect: "manual", credentials: "omit", signal });
		if (![301, 302, 303, 307, 308].includes(response.status)) return response;
		await response.body?.cancel();
		const location = response.headers.get("location");
		if (redirects >= MAX_REDIRECTS || location === null)
			throw new Error("The browser download has too many redirects.");
		url = publisher(new URL(location, url).href);
	}
}

/** A verified data archive only. No URL override, host execution, store row or guest-visible cache is involved. */
export async function downloadMicrovmBrowser(options: {
	readonly home: string;
	readonly browser: MicrovmBrowser;
	readonly signal: AbortSignal;
	readonly progress?: (value: { readonly received: number; readonly total: number }) => void;
	readonly fetch?: typeof fetch;
}): Promise<MicrovmAssets["box"]> {
	const { browser } = options;
	options.signal.throwIfAborted();
	const directory = await cacheDirectory(options.home);
	const archive = join(directory, `${browser.sha256}.tar`);
	const result = { archive, ref: browser.ref, digest: browser.digest };
	const present = await lstat(archive).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	});
	if (present?.isSymbolicLink()) throw new Error("The browser cache archive must not be a symbolic link.");
	if (present !== undefined && !present.isFile()) throw new Error("The browser cache archive is not a regular file.");
	if (present?.isFile() && present.size === browser.bytes && (await fileSha256(archive)) === browser.sha256)
		return result;
	const temporary = join(directory, `.download-${process.pid}-${randomBytes(8).toString("hex")}`);
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(DOWNLOAD_MS)]);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let received = 0;
	const cancel = () => void reader?.cancel(signal.reason).catch(() => undefined);
	signal.addEventListener("abort", cancel, { once: true });
	try {
		const response = await responseFor(browser.url, options.fetch ?? fetch, signal);
		if (!response.ok || response.body === null) {
			await response.body?.cancel();
			throw new Error(`The browser download answered HTTP ${response.status}. Check your connection and try again.`);
		}
		reader = response.body.getReader();
		const length = response.headers.get("content-length");
		if (length !== null && Number(length) !== browser.bytes)
			throw new Error("The browser download has the wrong size.");
		const file = await open(temporary, "wx", 0o600);
		try {
			options.progress?.({ received: 0, total: browser.bytes });
			for (;;) {
				signal.throwIfAborted();
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > browser.bytes) throw new Error("The browser download exceeds its pinned size.");
				await file.writeFile(value);
				options.progress?.({ received, total: browser.bytes });
			}
			signal.throwIfAborted();
			if (received !== browser.bytes) throw new Error("The browser download ended early. Try again.");
			await file.sync();
		} finally {
			await file.close();
		}
		if ((await fileSha256(temporary)) !== browser.sha256)
			throw new Error("The browser download failed SHA-256 verification. Try again.");
		signal.throwIfAborted();
		await rename(temporary, archive);
		return result;
	} catch (error) {
		if (options.signal.aborted) throw options.signal.reason;
		throw error;
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader?.cancel().catch(() => undefined);
		await rm(temporary, { force: true });
	}
}
