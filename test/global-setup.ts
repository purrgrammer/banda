/**
 * After every test run, what a box left behind goes: a test's home is removed after it (test/helpers.ts), so any box
 * whose home is gone is the leftover of a test that died before its own teardown. Only gone homes: another run's test
 * may be using its box right now.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable, sweepBoxes } from "../src/box/container.ts";

export default async function setup() {
	// every Vite server a test starts keeps its dependency cache in here (`viteCacheDir` in test/helpers.ts), and it goes
	// with the run
	const caches = await mkdtemp(join(tmpdir(), "banda-vite-"));
	process.env.BANDA_VITE_CACHES = caches;
	return async () => {
		await rm(caches, { recursive: true, force: true });
		if (await dockerAvailable()) await sweepBoxes();
	};
}
