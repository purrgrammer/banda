/**
 * A daemon's start touches no box but its own home's, whichever kind of box it uses: it never sweeps what other homes
 * left behind, since a home missing from this disk is no evidence it was this daemon's (another machine's on a shared
 * Docker engine, a disk not mounted now). Real chooseBox, container.ts and microvm.ts; Docker is faked at
 * `node:child_process`, the computer caches' folder at `node:fs/promises` (the real one is never listed). Each fake is
 * shown to catch a sweep by calling the sweep itself, so the isolation cannot hide one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { deletions, engine, resetEngine } from "./fixtures/fake-docker.ts";

vi.mock("node:child_process", async () => (await import("./fixtures/fake-docker.ts")).childProcess);
const listed = vi.hoisted(() => ({ caches: 0 }));
vi.mock("node:fs/promises", async (original) => {
	const real = await original<typeof import("node:fs/promises")>();
	return {
		...real,
		readdir: async (path: string, options?: unknown) => {
			if (path !== (process.platform === "darwin" ? "/private/tmp" : "/tmp"))
				return real.readdir(path, options as never);
			listed.caches += 1;
			return [];
		},
	};
});
vi.mock("../src/box/microvm-assets.ts", async (original) => ({
	...(await original<typeof import("../src/box/microvm-assets.ts")>()),
	microvmTarget: () => "linux-x64",
	installedMicrovmAssets: async () => {
		throw new Error("no runtime in this test");
	},
}));

const { chooseBox } = await import("../src/box/box.ts");
const { sweepBoxes } = await import("../src/box/container.ts");
const { sweepMicrovmBoxes } = await import("../src/box/microvm.ts");

/** The home that starts: it exists, as a starting daemon's does (each box writes its proxy's key there). */
const home = mkdtempSync(join(tmpdir(), "banda-start-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const foreign = "/nonexistent-banda-test/other-machine/.banda";
const foreignBox = "banda-box-0000000009";
const engineWithAForeignBox = () =>
	resetEngine(
		[
			{ name: foreignBox, home: foreign },
			{ name: `${foreignBox}-proxy`, home: foreign },
		],
		[`${foreignBox}-workspace`, `${foreignBox}-ca`],
	);

describe("a daemon's start", () => {
	it("on a container box asks the engine only whether it answers, and removes nothing", async () => {
		engineWithAForeignBox();
		const lines: string[] = [];
		const setup = await chooseBox(home, (line) => lines.push(line), "container");
		expect(setup).toBeDefined();
		expect(engine.calls).toEqual([["version", "--format", "{{.Server.Version}}"]]);
		expect(deletions()).toEqual([]);
		expect(lines).toEqual([]);
	});

	it("on a microVM box never lists the computer caches", async () => {
		const before = listed.caches;
		engineWithAForeignBox();
		const setup = await chooseBox(home, () => {}, "microvm");
		expect(setup).toBeDefined();
		expect(listed.caches).toBe(before);
		expect(engine.calls).toEqual([]);
	});

	it("the fakes would show a sweep: each sweep, called itself, reaches its fake", async () => {
		engineWithAForeignBox();
		await sweepBoxes();
		expect(engine.calls).toContainEqual(["ps", "--all", "--format", '{{.Names}}\t{{.Label "banda.home"}}']);
		expect(deletions()).not.toEqual([]);
		const before = listed.caches;
		await sweepMicrovmBoxes();
		expect(listed.caches).toBe(before + 1);
	});
});
