import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("cli", () => {
	it("prints its version and usage", async () => {
		const { stdout } = await run(process.execPath, ["src/cli/index.ts", "--help"]);
		expect(stdout).toMatch(/^banda \d+\.\d+\.\d+/);
		expect(stdout).toContain("banda say");
		expect(stdout).toContain("banda approve <id>");
		// host mode, where it is chosen, says agents lose their wallets (H-064)
		const host = stdout.slice(stdout.indexOf("--box host"), stdout.indexOf("banda say"));
		expect(host.replace(/\s+/g, " ")).toContain("wallets are offline for agents: their commands run as you");
	});

	it("loads no store module for src/home.ts, which every command imports", async () => {
		// a command that reads only the home starts without node:sqlite and the store's schemas (they load lazily)
		const { stdout } = await run(process.execPath, [
			"--input-type=module",
			"-e",
			"await import('./src/home.ts'); console.log(process.moduleLoadList.some((m) => m.includes('sqlite')))",
		]);
		expect(stdout.trim()).toBe("false");
	});

	it("says there is no daemon when none runs", async () => {
		const failed = await run(process.execPath, ["src/cli/index.ts", "status", "--home", "/nonexistent/banda"]).catch(
			(e) => e,
		);
		expect(failed.code).toBe(1);
		expect(failed.stderr).toContain("no banda daemon runs on /nonexistent/banda");
	});
});
