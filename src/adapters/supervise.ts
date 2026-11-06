/**
 * The supervisor every harness runs under: `node supervise.ts <command> [args…]`. It starts the harness, passes its stdio
 * through, and watches the process tree below it, every process group it sees. When the daemon's end of the pipe
 * closes (the daemon ended, or died: nothing else outlives it) or the harness exits, it kills everything it saw, then
 * exits. A harness's commands may run detached, each in a group of its own, and lose their parent when it dies (Claude
 * Code's do); killing the harness's own group would miss them. A group must still have a captured member with the same start time before it is killed; a reused group number grants no authority.
 */
import { spawn } from "node:child_process";
import { killGroups, type ProcessGroup, treeGroups } from "../core/processes.ts";

const [command = "", ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
const seen = new Map<number, ProcessGroup>();
const look = () => {
	for (const group of treeGroups(child.pid)) seen.set(group.id, group);
};
const watching = setInterval(look, 500);
let ending = false;
const end = (code: number) => {
	if (ending) return;
	ending = true;
	clearInterval(watching);
	look();
	killGroups([...seen.values()]);
	try {
		if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
	} catch {
		// gone already
	}
	process.exit(code);
};
child.on("error", (error) => {
	process.stderr.write(`${error.message}\n`);
	end(127);
});
child.on("exit", (code, signal) => end(code ?? (signal === null ? 0 : 1)));
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
// the daemon's end closed: it stopped, or died; the harness and all it started go
process.stdin.on("end", () => end(0));
process.on("SIGTERM", () => end(143));
look();
