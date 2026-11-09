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
	});

	it("says there is no daemon when none runs", async () => {
		const failed = await run(process.execPath, ["src/cli/index.ts", "status", "--home", "/nonexistent/banda"]).catch(
			(e) => e,
		);
		expect(failed.code).toBe(1);
		expect(failed.stderr).toContain("no banda daemon runs on /nonexistent/banda");
	});
});
