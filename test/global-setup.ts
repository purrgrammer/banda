/**
 * Every test run gets a temporary folder of its own, and every temporary folder a test, a daemon, a Chrome or a Vite
 * server makes goes in it: it all goes with the run, whatever a test forgot to remove. A run that was killed leaves its
 * folder, and a later run on the machine removes it once its process is gone and it has been quiet for an hour. After the run, what a box left behind
 * goes too: a box whose home is gone is the leftover of a test that died before its own teardown. Only gone homes:
 * another run's test may be using its box right now.
 */
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable, sweepBoxes } from "../src/box/container.ts";

/** Short: a folder in it carries Unix socket paths, which the kernel limits to about a hundred bytes. */
const RUN = /^b-(\d+)-/;
/** In every run's folder, so only a test run's folder is ever removed. */
const MARK = ".banda-test-run";
/**
 * A run's main process may be in another pid namespace (a container sharing the temp folder), where it looks dead: its
 * folder goes only once its mark is an hour old, longer than any run.
 */
const QUIET = 60 * 60_000;

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
		if (!(pid > 0) || alive(pid)) continue;
		const marked = await stat(join(system, name, MARK)).catch(() => undefined);
		if (marked !== undefined && Date.now() - marked.mtimeMs > QUIET)
			await rm(join(system, name), { recursive: true, force: true }).catch(() => undefined);
	}
	const run = await mkdtemp(join(system, `b-${process.pid}-`));
	await writeFile(join(run, MARK), "");
	process.env.TMPDIR = run;
	return async () => {
		await rm(run, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
		if (await dockerAvailable()) await sweepBoxes();
	};
}
