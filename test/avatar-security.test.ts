import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { tempHome } from "./helpers.ts";

it("bounds corrected arcs before any sync validation, including box listing and owner acceptance", async () => {
	const home = await tempHome();
	// This is a test watchdog, not the security mechanism. If preflight regresses, SIGKILL stops the
	// exploit's synchronous loop in the child; neither Vitest's event loop nor its timeout can be blocked.
	const { stdout } = await promisify(execFile)(process.execPath, ["test/fixtures/avatar-security.ts", home], {
		timeout: 10_000,
		killSignal: "SIGKILL",
		maxBuffer: 1024 * 1024,
	});
	expect(stdout).toContain("avatar security boundaries passed");
}, 15_000);
