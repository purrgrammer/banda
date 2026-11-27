/**
 * The microVM sweep with `within` (as a test run's teardown calls it) takes up only caches whose home is under those
 * roots, and removes what it takes up: the home's computers through its runtime, then its cache. Nothing real is
 * reached: the cache folder's listing, its caches and their homes are invented in a mocked `node:fs/promises` (the real
 * cache folder is never listed), the bundled runtime is a fake path whose commands a mocked `execFile` answers, and
 * any other process is refused.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uid = process.getuid?.() ?? 0;
const cacheRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
const cacheOf = (home: string) =>
	join(cacheRoot, `banda-msb-${uid}-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`);
const vmOf = (home: string) =>
	`banda-microvm-${createHash("sha256").update(home).digest("hex").slice(0, 10)}-0123456789ab`;

const world = vi.hoisted(() => ({
	/** home -> whether it exists on disk */
	homes: new Map<string, boolean>(),
	runtimeRequests: 0,
	/** what the fake runtime was asked, as `<MSB_HOME> <args>` */
	runtime: [] as string[],
	removed: [] as string[],
	refused: [] as string[],
	msb: "/nonexistent-banda-test/computer/msb",
}));

vi.mock("node:child_process", async (original) => {
	const { createHash } = await import("node:crypto");
	const refuse = (name: string) => (file: string) => {
		world.refused.push(`${name} ${file}`);
		throw new Error(`refusing ${name}`);
	};
	const homeOf = (cache: string) =>
		[...world.homes.keys()].find((home) =>
			cache.endsWith(createHash("sha256").update(home).digest("hex").slice(0, 16)),
		);
	return {
		...(await original<typeof import("node:child_process")>()),
		execFile: (
			file: string,
			args: string[],
			options: { env: Record<string, string> },
			callback: (...a: unknown[]) => void,
		) => {
			if (file !== world.msb) return refuse("execFile")(file);
			const cache = options.env.MSB_HOME ?? "";
			world.runtime.push(`${cache} ${args.join(" ")}`);
			const home = homeOf(cache) ?? "";
			const vm = `banda-microvm-${createHash("sha256").update(home).digest("hex").slice(0, 10)}-0123456789ab`;
			const inspection = {
				name: vm,
				status: "running",
				config: {
					labels: { "banda.home": home, "banda.runtime": "microvm" },
					manifest_digest: "x",
					network: { ports: [] },
				},
			};
			const out =
				args[0] === "list"
					? JSON.stringify([{ name: vm, status: "running" }])
					: args[0] === "inspect"
						? JSON.stringify(inspection)
						: "";
			queueMicrotask(() => callback(null, out, ""));
			return { stdin: { on() {}, end() {} } };
		},
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
		return { root: "/nonexistent-banda-test/computer", msb: world.msb, firmware: "/nonexistent-banda-test/fw" };
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
const unmounted = "/Volumes/unmounted-disk/banda-home";

beforeEach(() => {
	world.homes.clear();
	world.runtimeRequests = 0;
	world.runtime = [];
	world.removed = [];
	world.refused = [];
});

describe("sweepMicrovmBoxes within the run's roots", () => {
	it("takes up neither a home outside them nor one that still exists", async () => {
		world.homes.set(unmounted, false);
		world.homes.set("/Users/someone/.banda", false);
		world.homes.set(`${run}x/home`, false);
		world.homes.set(`${canonical}-old/home`, false);
		world.homes.set(`${run}/../b-1-climbs-out/home`, false);
		world.homes.set(`${run}/home-live`, true);
		expect(await sweepMicrovmBoxes({ within: roots })).toBe(0);
		expect(world.runtimeRequests).toBe(0);
		expect(world.runtime).toEqual([]);
		expect(world.removed).toEqual([]);
		expect(world.refused).toEqual([]);
	});

	it.each([`${run}/home-1`, `${canonical}/home-2`])(
		"removes this run's gone home %s: its computer through the runtime, then its cache; the unmounted one stays",
		async (home) => {
			world.homes.set(home, false);
			world.homes.set(unmounted, false);
			expect(await sweepMicrovmBoxes({ within: roots })).toBe(1);
			const cache = cacheOf(home);
			const vm = vmOf(home);
			expect(world.runtime).toEqual([
				`${cache} list --format json`,
				`${cache} inspect ${vm} --format json`,
				`${cache} inspect ${vm} --format json`,
				`${cache} remove --force ${vm}`,
			]);
			expect(world.removed).toEqual([cache]);
			expect(world.refused).toEqual([]);
		},
	);
});
