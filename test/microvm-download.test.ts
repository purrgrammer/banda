import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MicrovmBrowser } from "../src/box/microvm-assets.ts";
import { downloadMicrovmBrowser } from "../src/box/microvm-download.ts";

const bytes = "verified browser image data";
const sha256 = createHash("sha256").update(bytes).digest("hex");
const browser: MicrovmBrowser = {
	sha256,
	bytes: Buffer.byteLength(bytes),
	digest: `sha256:${"a".repeat(64)}`,
	ref: `banda-browser:${"b".repeat(12)}`,
	url: `https://github.com/purrgrammer/banda/releases/download/v0.1.0-test/banda-browser-${sha256}.tar`,
};
const homes: string[] = [];
async function home() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "banda-browser-download-")));
	homes.push(directory);
	return directory;
}
afterEach(async () => {
	for (const directory of homes.splice(0)) await rm(directory, { recursive: true, force: true });
});
const cache = (directory: string) => join(directory, "cache", "computer", "browser");
const options = (directory: string, fetcher: typeof fetch) => ({
	home: directory,
	browser,
	signal: new AbortController().signal,
	fetch: fetcher,
});

describe("on-demand browser archive", () => {
	it("publishes verified bytes atomically and reuses the cache without fetching", async () => {
		const directory = await home();
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes));
		const progress: number[] = [];
		const image = await downloadMicrovmBrowser({
			...options(directory, fetcher),
			progress: (state) => progress.push(state.received),
		});
		expect(await readFile(image.archive, "utf8")).toBe(bytes);
		expect(image.archive).toBe(join(cache(directory), `${sha256}.tar`));
		expect(progress.at(-1)).toBe(browser.bytes);
		expect(await readdir(cache(directory))).toEqual([`${sha256}.tar`]);
		expect(await downloadMicrovmBrowser(options(directory, fetcher))).toEqual(image);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", credentials: "omit" });
	});
	it.each([
		["wrong hash", "x".repeat(bytes.length), undefined, /SHA-256/],
		["truncated", bytes.slice(1), undefined, /ended early/],
		["oversized", `${bytes}x`, undefined, /exceeds/],
		["wrong declared size", bytes, "1", /wrong size/],
	] as const)("rejects %s and leaves no published or partial file", async (_label, body, length, error) => {
		const directory = await home();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(
				async () => new Response(body, length === undefined ? {} : { headers: { "content-length": length } }),
			);
		await expect(downloadMicrovmBrowser(options(directory, fetcher))).rejects.toThrow(error);
		expect(await readdir(cache(directory))).toEqual([]);
		fetcher.mockImplementation(async () => new Response(bytes));
		await expect(downloadMicrovmBrowser(options(directory, fetcher))).resolves.toHaveProperty("ref", browser.ref);
	});
	it("allows only HTTPS publisher/CDN redirects", async () => {
		const directory = await home();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://release-assets.githubusercontent.com/asset" },
				}),
			)
			.mockResolvedValueOnce(new Response(bytes));
		await downloadMicrovmBrowser(options(directory, fetcher));
		expect(String(fetcher.mock.calls[1]?.[0])).toBe("https://release-assets.githubusercontent.com/asset");
	});
	it.each([
		"http://github.com/file",
		"https://127.0.0.1/file",
		"https://github.com.evil.test/file",
		"https://u:p@github.com/file",
	])("rejects redirect to %s before making that request", async (address) => {
		const directory = await home();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 302, headers: { location: address } }));
		await expect(downloadMicrovmBrowser(options(directory, fetcher))).rejects.toThrow(/trusted publisher/);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("cancels an interrupted stream, removes its partial bytes and retries", async () => {
		const directory = await home();
		let firstChunk = () => {};
		const first = new Promise<void>((resolve) => {
			firstChunk = resolve;
		});
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(bytes.slice(0, 3)));
			},
			cancel() {
				cancelled = true;
			},
		});
		const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(stream));
		const abort = new AbortController();
		const operation = downloadMicrovmBrowser({
			...options(directory, fetcher),
			signal: abort.signal,
			progress: (state) => {
				if (state.received > 0) firstChunk();
			},
		});
		const rejected = expect(operation).rejects.toThrow("stopped by owner");
		await first;
		abort.abort(new Error("stopped by owner"));
		await rejected;
		expect(cancelled).toBe(true);
		expect(await readdir(cache(directory))).toEqual([]);
		fetcher.mockImplementation(async () => new Response(bytes));
		await expect(downloadMicrovmBrowser(options(directory, fetcher))).resolves.toHaveProperty("ref", browser.ref);
	});
	it("replaces corrupted cached bytes and converges under concurrent publication", async () => {
		const directory = await home();
		await mkdir(cache(directory), { recursive: true });
		await writeFile(join(cache(directory), `${sha256}.tar`), "corrupt");
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes));
		const both = await Promise.all([
			downloadMicrovmBrowser(options(directory, fetcher)),
			downloadMicrovmBrowser(options(directory, fetcher)),
		]);
		expect(both[0]).toEqual(both[1]);
		expect(await readFile(both[0]!.archive, "utf8")).toBe(bytes);
		expect(await readdir(cache(directory))).toEqual([`${sha256}.tar`]);
	});
	it("refuses a cache ancestor redirected into writable computer files", async () => {
		const directory = await home();
		const workspace = join(directory, "computer", "workspace");
		await mkdir(workspace, { recursive: true });
		await symlink(workspace, join(directory, "cache"));
		const fetcher = vi.fn<typeof fetch>();
		await expect(downloadMicrovmBrowser(options(directory, fetcher))).rejects.toThrow(/app-owned directory/);
		expect(fetcher).not.toHaveBeenCalled();
	});
});
