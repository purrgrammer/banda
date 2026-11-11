/**
 * Every test run gets a temporary folder of its own, and every temporary folder a test, a daemon, a Chrome or a Vite
 * server makes goes in it: it all goes with the run, whatever a test forgot to remove. A run that was killed leaves its
 * folder, and the next run on the machine removes it once its process is gone. After the run, what a box left behind
 * goes too: a box whose home is gone is the leftover of a test that died before its own teardown. Only gone homes:
 * another run's test may be using its box right now.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable, sweepBoxes } from "../src/box/container.ts";

/** Short: a folder in it carries Unix socket paths, which the kernel limits to about a hundred bytes. */
const RUN = /^b-(\d+)-/;

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

export default async function setup() {
	const system = tmpdir();
	for (const name of await readdir(system).catch(() => [])) {
		const pid = Number(RUN.exec(name)?.[1]);
		if (pid > 0 && !alive(pid)) await rm(join(system, name), { recursive: true, force: true }).catch(() => undefined);
	}
	const run = await mkdtemp(join(system, `b-${process.pid}-`));
	process.env.TMPDIR = run;
	return async () => {
		await rm(run, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
		if (await dockerAvailable()) await sweepBoxes();
	};
}
