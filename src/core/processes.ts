/**
 * The processes a harness session starts, found and killed: by the process groups below the harness (a harness may run
 * each command detached, in a group of its own), and by a marker in their environment (Linux, where every process's
 * environment can be read). Kept light: the supervisor every harness runs under imports it.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/** The variable every process a session starts carries in its environment, and its value: the session's marker. */
export const MARKER = "BANDA_HARNESS";

/**
 * The processes carrying `marker` in their environment: the harness and everything it started, its own process groups
 * included (Claude Code runs each command detached, in a group of its own), whatever their parents now are.
 */
export function marked(marker: string): number[] {
	const token = `${MARKER}=${marker}`;
	const found: number[] = [];
	if (process.platform === "linux") {
		let pids: string[] = [];
		try {
			pids = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
		} catch {
			return [];
		}
		for (const pid of pids) {
			try {
				if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(token)) found.push(Number(pid));
			} catch {
				// gone, or not ours to read
			}
		}
	} else {
		let listing = "";
		try {
			// macOS: -E adds the environment of the owner's own processes after each command
			listing = execFileSync("ps", ["-E", "-ww", "-A", "-o", "pid=,command="], {
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
			});
		} catch {
			return [];
		}
		for (const line of listing.split("\n")) {
			const match = /^\s*(\d+)\s(.*)$/.exec(line);
			if (match === null) continue;
			if ((match[2] ?? "").split(/\s+/).includes(token)) found.push(Number(match[1]));
		}
	}
	return found.filter((pid) => pid !== process.pid);
}

/** Kill every process a session started, by its marker: nothing it ran outlives it, nothing else is touched. */
export function killMarked(marker: string | undefined): void {
	if (marker === undefined) return;
	for (const pid of marked(marker))
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone already
		}
}

/** A group is identified by observed members and their start times, never its reusable number alone. */
export type ProcessGroup = {
	readonly id: number;
	readonly members: { readonly pid: number; readonly started: number }[];
};

type Process = { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly started: number };

/** Every process now, with its parent, its group and when it started (ms); empty when ps cannot be read. */
function processes(): Process[] {
	let listing = "";
	try {
		listing = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			env: { ...process.env, LC_ALL: "C" },
		});
	} catch {
		return [];
	}
	return listing.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
		if (match === null) return [];
		const started = Date.parse(match[4] ?? "");
		return [
			{
				pid: Number(match[1]),
				ppid: Number(match[2]),
				pgid: Number(match[3]),
				started: Number.isNaN(started) ? 0 : started,
			},
		];
	});
}

/** The groups of `root` and of everything below it, its own included: what killing its group alone would miss. */
export function treeGroups(root: number | undefined): ProcessGroup[] {
	if (root === undefined) return [];
	const all = processes();
	const below = new Set([root]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const one of all)
			if (below.has(one.ppid) && !below.has(one.pid)) {
				below.add(one.pid);
				grew = true;
			}
	}
	return [...new Set(all.filter((one) => below.has(one.pid)).map((one) => one.pgid))]
		.filter((group) => group > 1)
		.map((id) => ({
			id,
			members: all
				.filter((one) => one.pgid === id && below.has(one.pid) && one.started > 0)
				.map(({ pid, started }) => ({ pid, started })),
		}));
}

/**
 * A still-live observed member anchors its group: while it exists that group number cannot be reused. A stale record
 * with no matching PID and start time authorizes no kill. Environment markers cover descendants no longer anchored.
 */
export function killGroups(groups: readonly ProcessGroup[] | undefined): void {
	if (groups === undefined || groups.length === 0) return;
	const all = processes();
	const wanted = new Set(
		groups
			.filter((group) =>
				group.members.some((member) =>
					all.some(
						(one) =>
							one.pgid === group.id && one.pid === member.pid && one.started === member.started && one.started > 0,
					),
				),
			)
			.map((group) => group.id),
	);
	for (const one of all)
		if (wanted.has(one.pgid) && one.pid !== process.pid)
			try {
				process.kill(one.pid, "SIGKILL");
			} catch {
				/* already gone */
			}
}
