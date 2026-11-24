/**
 * Every test run gets a temporary folder of its own, and every temporary folder a test, a daemon, a Chrome or a Vite
 * server makes goes in it: it all goes with the run, whatever a test forgot to remove. A run that was killed leaves its
 * folder, and a later run on the machine removes it once its process is gone and it has been quiet for an hour. After the run, what a box left behind
 * goes too: a box whose home was under this run's folder is the leftover of one of its tests that died before its own
 * teardown. Only this run's: another run's test may be using its box right now, and a home this machine cannot find
 * (another machine's on a shared Docker engine, one on a disk not mounted now) was never this run's to remove.
 */
import { mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dockerAvailable, sweepBoxes } from "../src/box/container.ts";
import { sweepMicrovmBoxes } from "../src/box/microvm.ts";

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
		// both spellings, read before the folder goes: a box's label may name its home either way (/var is /private/var)
		const roots = [resolve(run), await realpath(run).catch(() => resolve(run))];
		await rm(run, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
		await sweepMicrovmBoxes({ within: roots }).catch(() => undefined);
		if (await dockerAvailable()) await sweepBoxes({ within: roots });
	};
}
