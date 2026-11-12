/**
 * Host mode (DESIGN.md "The box"): no box. pi-env's daemon runs on the daemon's own machine, its commands in
 * `<home>/workspace`, so banda runs where there is no Docker, or inside a box that is already the isolation. Opt-in
 * only (`banda serve --box host`), never a fallback: nothing keeps the commands in, there is no egress proxy (no
 * tickets, no credentials set for a host) and no browser.
 *
 * What it keeps of the container box's exec: every command in its own process group, killed whole on cancel or timeout
 * (pi-env's), the tools' own timeouts, and an allow-listed environment: the daemon's own variables (its model keys among
 * them) never reach a command.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { localDaemon } from "@earendil-works/pi-env";
import type { BoxSetup } from "./box.ts";

/** The variables a command gets from the daemon's environment; every other one is left out. */
const PASSED = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "USER", "LOGNAME", "TMPDIR", "TZ"] as const;

export function hostBox(home: string): BoxSetup {
	const root = resolve(home);
	const workspace = join(root, "workspace");
	const attachments = join(root, "work", "attachments");
	const env = PASSED.flatMap((name) => {
		const value = process.env[name];
		return value === undefined ? [] : [`${name}=${value}`];
	});
	return {
		workspace,
		attachments,
		kind: "host",
		ensure: async () => {
			await mkdir(workspace, { recursive: true, mode: 0o700 });
			await mkdir(attachments, { recursive: true, mode: 0o700 });
		},
		command: ["/usr/bin/env", "-i", `HOME=${homedir()}`, ...env, localDaemon()],
	};
}
