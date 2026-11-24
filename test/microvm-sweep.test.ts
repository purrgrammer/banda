/**
 * The microVM sweep with `within` (as a test run's teardown calls it) takes up only caches whose home is under those
 * roots. Nothing real is reached: the cache folder's listing, its caches and their homes are invented in a mocked
 * `node:fs/promises` (the real cache folder is never listed), the bundled runtime is a mock that refuses, and no
 * process can start. A cache the sweep takes up is seen as its one request for the runtime.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uid = process.getuid?.() ?? 0;
const cacheRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
const cacheOf = (home: string) =>
	join(cacheRoot, `banda-msb-${uid}-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`);

const world = vi.hoisted(() => ({
	/** home -> whether it exists on disk */
	homes: new Map<string, boolean>(),
	runtimeRequests: 0,
	removed: [] as string[],
	processes: [] as string[],
}));

vi.mock("node:child_process", async (original) => {
	const refuse = (name: string) => (file: string) => {
		world.processes.push(`${name} ${file}`);
		throw new Error(`refusing ${name}`);
	};
	return {
		...(await original<typeof import("node:child_process")>()),
		execFile: refuse("execFile"),
		spawn: refuse("spawn"),
		exec: refuse("exec"),
		fork: refuse("fork"),
	};
});
vi.mock("../src/box/microvm-assets.ts", async (original) => ({
	...(await original<typeof import("../src/box/microvm-assets.ts")>()),
	microvmTarget: () => "linux-x64",
	installedMicrovmAssets: async () => {
		world.runtimeRequests += 1;
		throw new Error("no runtime in this test");
	},
}));
vi.mock("node:fs/promises", async (original) => {
	const real = await original<typeof import("node:fs/promises")>();
	const caches = () => new Map([...world.homes.keys()].map((home) => [cacheOf(home), home]));
	const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
	return {
		...real,
		readdir: async (path: string, options?: unknown) => {
			if (path !== cacheRoot) return real.readdir(path, options as never);
			return [...caches().keys()].map((cache) => ({
				name: cache.slice(cacheRoot.length + 1),
				isDirectory: () => true,
			}));
		},
		lstat: async (path: string) => {
			if (caches().has(path)) return { uid };
			if (world.homes.has(path)) {
				if (world.homes.get(path) === true) return { uid };
				throw enoent(path);
			}
			throw new Error(`unexpected lstat in this test: ${path}`);
		},
		readFile: async (path: string, options?: unknown) => {
			const home = caches().get(path.replace(/\/home\.json$/, ""));
			if (home !== undefined) return JSON.stringify({ home });
			return real.readFile(path, options as never);
		},
		rm: async (path: string, options?: unknown) => {
			if (path.startsWith(`${cacheRoot}/banda-msb-`)) {
				world.removed.push(path);
				return;
			}
			return real.rm(path, options as never);
		},
	};
});

const { sweepMicrovmBoxes } = await import("../src/box/microvm.ts");

const run = "/var/folders/xy/T/b-4242-abcdef";
const canonical = `/private${run}`;
const roots = [run, canonical];

beforeEach(() => {
	world.homes.clear();
	world.runtimeRequests = 0;
	world.removed = [];
	world.processes = [];
});

describe("sweepMicrovmBoxes within the run's roots", () => {
	it("takes up neither a home outside them nor one that still exists", async () => {
		world.homes.set("/Volumes/unmounted-disk/banda-home", false);
		world.homes.set("/Users/someone/.banda", false);
		world.homes.set(`${run}x/home`, false);
		world.homes.set(`${canonical}-old/home`, false);
		world.homes.set(`${run}/../b-1-climbs-out/home`, false);
		world.homes.set(`${run}/home-live`, true);
		await sweepMicrovmBoxes({ within: roots });
		expect(world.runtimeRequests).toBe(0);
		expect(world.removed).toEqual([]);
		expect(world.processes).toEqual([]);
	});

	it.each([`${run}/home-1`, `${canonical}/home-2`])("takes up this run's gone home %s", async (home) => {
		world.homes.set(home, false);
		world.homes.set("/Volumes/unmounted-disk/banda-home", false);
		await sweepMicrovmBoxes({ within: roots });
		expect(world.runtimeRequests).toBe(1);
		expect(world.processes).toEqual([]);
	});
});
