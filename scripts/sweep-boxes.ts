/**
 * `npm run boxes:sweep`: remove the boxes (containers, networks, volumes) of homes that are gone, and of throwaway homes
 * under the temporary folders whose daemon is not running. A home whose daemon runs, or any home outside the temporary
 * folders that still exists (~/.banda), is never touched. Do not run it while tests run: a test's box has no daemon.
 */
import { dockerAvailable, sweepBoxes } from "../src/box/container.ts";

if (!(await dockerAvailable())) {
	console.log("Docker is not running: nothing to sweep.");
	process.exit(0);
}
const swept = await sweepBoxes({ idle: true });
console.log(swept.length === 0 ? "Nothing left behind." : `Swept ${swept.length}:\n${swept.join("\n")}`);
