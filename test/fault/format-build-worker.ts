/**
 * Brings a copy of the kept home to the build's format under a fault schedule, as a daemon's start does after an
 * upgrade: checks what the process before left, then runs until it settles, starting over after a thrown fault.
 * Prints how many attempts this process took.
 */
import { type Fault, Faults, InjectedFault } from "./faults.ts";
import { checkBuildSettled, checkBuildStopped, migrateBuild } from "./format-build.ts";

const [home, schedule] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(schedule) as Fault[]);
const injected = (error: unknown): boolean =>
	error instanceof InjectedFault || (error instanceof Error && error.cause !== undefined && injected(error.cause));
await checkBuildStopped(home);
for (let attempts = 1; ; attempts++) {
	try {
		await migrateBuild(home, (point) => faults.hit(point));
		await checkBuildSettled(home);
		console.log(JSON.stringify({ attempts }));
		break;
	} catch (error) {
		if (!injected(error)) throw error;
		await checkBuildStopped(home);
	}
}
