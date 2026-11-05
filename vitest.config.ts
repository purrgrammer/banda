import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Three groups, one after another, so no group's load is what another waits on:
 * - unit: every other file, two at a time;
 * - faults: the fault-injection suites (`*.faults.test.ts`), one file at a time: each runs a pool of killed worker
 *   processes of its own, and all of them side by side, with the unit files beside them, starved each other and every
 *   test of their time budgets;
 * - docker: the files that drive Docker (containers, their networks, the egress proxy), one at a time: a container's
 *   bring-up and teardown is many docker calls.
 */
const FAULTS = ["test/**/*.faults.test.ts"];
const DOCKER = ["test/box.test.ts", "test/**/*.docker.test.ts", "test/tools.test.ts"];

// Tests wait on state (`until` in test/helpers.ts), never on a clock of their own, so the timeouts below are the only
// bound: generous, since many tests start processes, a daemon or a container, seconds each on a busy machine. A hook
// does the same kind of work (removing a container and its volumes), so it gets more than vitest's 10 s too.
const timeouts = { testTimeout: 30_000, hookTimeout: 120_000 };

export default defineConfig({
	test: {
		maxWorkers: 2,
		// what a test's box left behind goes after the run, whatever killed the test
		globalSetup: ["test/global-setup.ts"],
		projects: [
			{
				resolve: { alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) } },
				test: { name: "unit", include: ["test/**/*.test.ts", "web/src/**/*.test.ts"], exclude: [...FAULTS, ...DOCKER], ...timeouts },
			},
			{
				test: { name: "faults", include: FAULTS, maxWorkers: 1, sequence: { groupOrder: 1 }, ...timeouts },
			},
			{
				test: { name: "docker", include: DOCKER, fileParallelism: false, sequence: { groupOrder: 2 }, ...timeouts },
			},
		],
	},
});
