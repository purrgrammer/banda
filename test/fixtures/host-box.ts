/**
 * A box for tests: host mode's box (`src/box/host.ts`), pi-env's daemon on the host in `<home>/workspace`, so tests
 * that run tools need no Docker; it also notes each start of pi-env's daemon.
 */
import { join } from "node:path";
import type { BoxSetup } from "../../src/box/box.ts";
import { hostBox as productHostBox } from "../../src/box/host.ts";

/**
 * `<home>/box.pids` gets a line per start of pi-env's daemon, "<pid of the process that started it> <its pid>", so a
 * test can wait for the daemon of a killed process to have gone (and killed its commands) before it looks.
 */
export const BOX_PIDS = "box.pids";

export function hostBox(home: string): BoxSetup {
	const setup = productHostBox(home);
	return {
		...setup,
		command: ["/bin/sh", "-c", 'echo "$PPID $$" >> "$0"; exec "$@"', join(home, BOX_PIDS), ...setup.command],
	};
}
