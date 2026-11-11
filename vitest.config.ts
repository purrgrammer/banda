import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Four groups, one after another, so no group's load is what another waits on:
 * - unit: every file that is none of the others, each holding one of the machine's file slots (as many as it has cores);
 * - browser: the files that drive Chrome and Vite (`*.browser.test.ts`), each holding one of the machine's browser slots
 *   (test/slots.ts) while it runs: a file waits for one before its clock starts, however many runs are on the machine;
 * - faults: the fault-injection suites (`*.faults.test.ts`), one file at a time: each runs a pool of killed worker
 *   processes of its own, and all of them side by side, with the unit files beside them, starved each other and every
 *   test of their time budgets;
 * - docker: the files that drive Docker (containers, their networks, the egress proxy), one at a time: a container's
 *   bring-up and teardown is many docker calls.
 */
const FAULTS = ["test/**/*.faults.test.ts"];
const DOCKER = ["test/box.test.ts", "test/**/*.docker.test.ts", "test/tools.test.ts"];
const BROWSER = ["test/**/*.browser.test.ts"];

// Tests wait on state (`until` in test/helpers.ts), never on a clock of their own, so the timeouts below are the only
// bound: generous, since many tests start processes, a daemon or a container, seconds each on a busy machine. A hook
// does the same kind of work (removing a container and its volumes), so it gets more than vitest's 10 s too.
const timeouts = { testTimeout: 30_000, hookTimeout: 120_000 };
// A daemon a test starts binds no Iroh endpoint unless the test asks for one, on loopback: tests never need the network.
const env = { BANDA_REMOTE: "off" };
const alias = { "@": fileURLToPath(new URL("./web/src", import.meta.url)) };

export default defineConfig({
	test: {
		maxWorkers: 6,
		// what a test's box left behind goes after the run, whatever killed the test
		globalSetup: ["test/global-setup.ts"],
		projects: [
			{
				resolve: { alias },
				test: { name: "unit", include: ["test/**/*.test.ts", "web/src/**/*.test.ts"], exclude: [...FAULTS, ...DOCKER, ...BROWSER], setupFiles: ["test/file-slot.ts"], env, ...timeouts },
			},
			{
				resolve: { alias },
				test: { name: "browser", include: BROWSER, setupFiles: ["test/browser-slot.ts"], sequence: { groupOrder: 1 }, env, ...timeouts },
			},
			{
				test: { name: "faults", include: FAULTS, maxWorkers: 1, sequence: { groupOrder: 2 }, env, ...timeouts },
			},
			{
				test: { name: "docker", include: DOCKER, fileParallelism: false, sequence: { groupOrder: 3 }, env, ...timeouts },
			},
		],
	},
});
