/**
 * The kill driver: runs the worker until it finishes, process `i` under `schedules[i]` and later ones under none, so
 * every scheduled kill lands in a process of its own and the last process recovers.
 */
import { execFile } from "node:child_process";
import type { Inbound } from "../../src/core/gateway.ts";
import type { Fault } from "./faults.ts";
import { readSent, type Sent, type Summary } from "./sut.ts";

export type Killed = {
	readonly sent: Sent[];
	readonly summary: Summary;
	readonly kills: number;
	readonly commits: number;
};

export async function runKilled(
	home: string,
	messages: readonly Inbound[],
	schedules: readonly (readonly Fault[])[],
): Promise<Killed> {
	const { last, kills } = await runWorker("test/fault/worker.ts", [home, JSON.stringify(messages)], schedules);
	const { summary, commits } = last as { summary: Summary; commits: number };
	return { sent: readSent(home), summary, kills, commits };
}

/**
 * Run `script` with `args` and a schedule until it finishes, process `i` under `schedules[i]`: resolves with the JSON
 * of its last line and the number of processes killed.
 */
export async function runWorker(
	script: string,
	args: readonly string[],
	schedules: readonly (readonly Fault[])[],
): Promise<{ last: unknown; kills: number }> {
	let kills = 0;
	for (let i = 0; i <= schedules.length; i++) {
		const result = await worker([script, ...args, JSON.stringify(schedules[i] ?? [])]);
		if (result.signal === "SIGKILL") {
			kills++;
			continue;
		}
		if (result.status !== 0) throw new Error(`worker failed (${result.status ?? result.signal}): ${result.stderr}`);
		return { last: JSON.parse(result.stdout.trim().split("\n").at(-1)!), kills };
	}
	throw new Error("the worker never finished");
}

function worker(
	args: string[],
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, args, { encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
			const failed = error as (Error & { code?: number; signal?: NodeJS.Signals }) | null;
			resolve({
				status: failed === null ? 0 : (failed.code ?? null),
				signal: failed?.signal ?? null,
				stdout,
				stderr,
			});
		});
	});
}

/** At most two subprocess jobs per suite; drain started jobs before allowing test cleanup. */
export async function pool<T>(width: number, jobs: readonly (() => Promise<T>)[]): Promise<T[]> {
	if (!Number.isSafeInteger(width) || width < 1) throw new Error("pool width must be a positive integer");
	const results: T[] = [];
	let next = 0;
	let failed = false;
	let failure: unknown;
	await Promise.all(
		Array.from({ length: Math.min(width, 2, jobs.length) }, async () => {
			while (!failed && next < jobs.length) {
				const i = next++;
				try {
					results[i] = await jobs[i]!();
				} catch (error) {
					if (!failed) failure = error;
					failed = true;
				}
			}
		}),
	);
	if (failed) throw failure;
	return results;
}
