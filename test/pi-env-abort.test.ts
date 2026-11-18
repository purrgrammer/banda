import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const run = (script: string) =>
	new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
		execFile(process.execPath, [fixture(script)], { encoding: "utf8", timeout: 20_000 }, (error, stdout, stderr) =>
			resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout, stderr }),
		);
	});

describe("pi-env 1.5.2 (upstream)", () => {
	// A request with an aborted signal on a closed connection leaves a rejection nothing handles, and Node's default
	// ends the process. Banda hit it at shutdown (src/box/tools.ts listing files). Fails once pi-env handles it.
	it("leaves a rejection unhandled when a closed connection is asked with an aborted signal", async () => {
		const { code, stdout, stderr } = await run("pi-env-abort-after-close.mjs");
		expect(stdout).toContain("caller got: aborted");
		expect(stdout).not.toContain("survived");
		expect(code).not.toBe(0);
		expect(stderr).toContain("Connection closed");
	});
});

describe("the box's connection", () => {
	it("refuses a request once closed, so pi-env never leaves one unhandled", async () => {
		const { code, stdout } = await run("box-connection-after-close.ts");
		expect(stdout.split("\n").filter((line) => line.startsWith("caller got:"))).toEqual([
			"caller got: unknown Connection closed",
			"caller got: unknown Connection closed",
		]);
		expect(stdout).toContain("survived");
		expect(code).toBe(0);
	});
});
