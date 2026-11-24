/**
 * A test run's teardown (test/global-setup.ts) removes the boxes only of homes under the folder the run made, by either
 * spelling of it, and never a box because its home is missing from this disk: another machine's home on a shared Docker
 * engine, or one on a disk not mounted now, was never the run's. Docker is faked at `node:child_process` (no engine is
 * reached), the disk is real and the homes invented; the microVM sweep is stubbed and only its scope is checked here
 * (test/microvm-sweep.test.ts runs it).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { within } from "../src/box/within.ts";
import { deletions, resetEngine } from "./fixtures/fake-docker.ts";

vi.mock("node:child_process", async () => (await import("./fixtures/fake-docker.ts")).childProcess);
const microvm = vi.hoisted(() => ({ scopes: [] as (readonly string[] | undefined)[] }));
vi.mock("../src/box/microvm.ts", () => ({
	sweepMicrovmBoxes: async ({ within }: { within?: readonly string[] } = {}) => {
		microvm.scopes.push(within);
		return 0;
	},
}));

const box = (n: number) => `banda-box-${String(n).padStart(10, "0")}`;
const sandboxes: string[] = [];
afterAll(() => {
	for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

describe("within", () => {
	it.each([
		["/t/b-1-ab", ["/t/b-1-ab"], true],
		["/t/b-1-ab/home", ["/t/b-1-ab"], true],
		["/t/b-1-ab/home", ["/t/b-1-ab/"], true],
		["/t/b-1-abc/home", ["/t/b-1-ab"], false],
		["/t/b-1-ab-old/home", ["/t/b-1-ab"], false],
		["/t/b-1-ab/../b-2-cd/home", ["/t/b-1-ab"], false],
		["/t/b-1-ab/..home", ["/t/b-1-ab"], true],
		["/t", ["/t/b-1-ab"], false],
		["t/b-1-ab/home", ["/t/b-1-ab"], false],
		["/t/b-1-ab/home", ["t/b-1-ab"], false],
		["/Users/someone/.banda", ["/"], false],
		["/private/t/b-1-ab/home", ["/t/b-1-ab", "/private/t/b-1-ab"], true],
		["/private/t/b-1-ab/home", ["/t/b-1-ab"], false],
		["/t/b-1-ab/home", [], false],
	] as const)("%s within %j: %s", (path, roots, expected) => {
		expect(within(path, roots)).toBe(expected);
	});
});

/**
 * Runs the real setup, then the teardown it returns, with the system temporary folder a symlink (as macOS's /var is), so
 * the run folder has two spellings. Before the teardown, the fake engine holds the boxes of the homes below.
 */
async function teardownOfARun(env: { BANDA_TEST_BOX?: string; DOCKER_HOST?: string }) {
	const sandbox = mkdtempSync(join(tmpdir(), "banda-sweep-scope-"));
	sandboxes.push(sandbox);
	const real = join(sandbox, "real");
	const system = join(sandbox, "alias");
	mkdirSync(real);
	symlinkSync(real, system, "dir");
	const tag = randomBytes(4).toString("hex");
	const saved = {
		TMPDIR: process.env.TMPDIR,
		BANDA_TEST_BOX: process.env.BANDA_TEST_BOX,
		DOCKER_HOST: process.env.DOCKER_HOST,
	};
	try {
		process.env.TMPDIR = system;
		for (const key of ["BANDA_TEST_BOX", "DOCKER_HOST"] as const) {
			if (env[key] === undefined) delete process.env[key];
			else process.env[key] = env[key];
		}
		const { default: setup } = await import("./global-setup.ts");
		const teardown = await setup();
		const run = process.env.TMPDIR ?? "";
		expect(run.startsWith(join(system, `b-${process.pid}-`))).toBe(true);
		const canonical = realpathSync(run);
		expect(canonical.startsWith(`${realpathSync(real)}/`)).toBe(true);
		const homes = [
			join(run, "home-1"), // 1: a test of this run's, labelled as made; it goes with the run folder
			join(canonical, "home-2"), // 2: the same, labelled by the folder's realpath
			`/nonexistent-banda-test-${tag}/other-machine/.banda`, // 3: another machine's, on a shared engine
			`/Volumes/banda-test-unmounted-${tag}/banda-home`, // 4: on a disk not mounted now
			join(sandbox, "live-home"), // 5: a home whose daemon runs (this process stands for it)
			join(system, "b-999999-busy", "home"), // 6: another run's test box, in use, no daemon
			`${run}x/home`, // 7: a sibling folder whose name starts like the run's, gone
			`${canonical}-old/home`, // 8: the same, by the realpath
			`${run}/../b-1-climbs-out/home`, // 9: a label that climbs out of the run folder, gone
		];
		mkdirSync(homes[0] ?? "");
		mkdirSync(homes[1] ?? "");
		mkdirSync(homes[4] ?? "");
		writeFileSync(join(homes[4] ?? "", "daemon.json"), JSON.stringify({ pid: process.pid }));
		mkdirSync(homes[5] ?? "", { recursive: true });
		resetEngine(
			homes.flatMap((home, i) => [
				{ name: box(i + 1), home },
				{ name: `${box(i + 1)}-proxy`, home },
			]),
			homes.flatMap((_, i) => [`${box(i + 1)}-workspace`, `${box(i + 1)}-ca`]),
		);
		const scopes = microvm.scopes.length;
		await teardown?.();
		return {
			run,
			canonical,
			runRemoved: !existsSync(run),
			microvmScopes: microvm.scopes.slice(scopes),
			deletions: deletions(),
		};
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const MODES = [
	{ BANDA_TEST_BOX: undefined, DOCKER_HOST: "tcp://shared-engine.invalid:2376" },
	{ BANDA_TEST_BOX: "container", DOCKER_HOST: "tcp://shared-engine.invalid:2376" },
	{ BANDA_TEST_BOX: "container", DOCKER_HOST: undefined },
];

describe("a test run's teardown", () => {
	it.each(MODES)(
		"BANDA_TEST_BOX=$BANDA_TEST_BOX DOCKER_HOST=$DOCKER_HOST: removes this run's boxes, and only those",
		async (mode) => {
			const result = await teardownOfARun(mode);
			expect(result.runRemoved).toBe(true);
			for (const n of [1, 2]) {
				expect(result.deletions).toContainEqual(["rm", "--force", box(n), `${box(n)}-proxy`]);
				expect(result.deletions).toContainEqual(["network", "rm", `${box(n)}-in`, `${box(n)}-out`]);
				expect(result.deletions).toContainEqual(["volume", "rm", "--force", `${box(n)}-workspace`, `${box(n)}-ca`]);
			}
			const others = [3, 4, 5, 6, 7, 8, 9].map(box);
			expect(
				result.deletions.flat().filter((arg) => others.some((name) => arg === name || arg.startsWith(`${name}-`))),
			).toEqual([]);
		},
	);

	it("scopes the microVM sweep to the run folder too, by both its spellings", async () => {
		const result = await teardownOfARun({});
		expect(result.microvmScopes).toHaveLength(1);
		expect(result.microvmScopes[0]).toEqual(expect.arrayContaining([result.run, result.canonical]));
		expect(result.microvmScopes[0]?.every((root) => root === result.run || root === result.canonical)).toBe(true);
	});
});
