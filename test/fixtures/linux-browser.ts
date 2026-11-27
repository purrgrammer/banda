/** The Linux browser preflight (scripts/verify-linux-browser.ts) run as its own process, on a binary a test names. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach } from "vitest";
import { LinuxBrowserResult } from "../../scripts/verify-linux-browser.ts";

const homes: string[] = [];
afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

export async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "banda-browser-preflight-"));
	homes.push(home);
	return { home, output: join(home, "evidence") };
}

export async function run(binary: string, output: string) {
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import { verifyLinuxBrowser } from './scripts/verify-linux-browser.ts';
		const result = await verifyLinuxBrowser({ chrome: process.argv[1], output: process.argv[2] });
		process.exitCode = result.passed ? 0 : 1;
	`,
			binary,
			output,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let log = "";
	child.stdout.on("data", (bytes: Buffer) => {
		log += bytes.toString();
	});
	child.stderr.on("data", (bytes: Buffer) => {
		log += bytes.toString();
	});
	const status = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	const value: unknown = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
	if (!Value.Check(LinuxBrowserResult, value)) throw new Error(`Invalid preflight result: ${log}`);
	return { status, result: value, log };
}
