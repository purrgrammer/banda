/**
 * The Linux browser preflight against owned stand-ins for Chrome (shell scripts): how it records a fatal exit, an
 * overflowing stderr and an unresponsive binary. No browser runs; the real Chrome run is
 * test/verify-linux-browser.browser.test.ts.
 */
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixture, run } from "./fixtures/linux-browser.ts";

/**
 * Two cases signal processes: one stand-in aborts itself, and the unresponsive one ends only by the helper's SIGKILL.
 * CI runs them (the check job sets CI); a development machine skips them, as it skips process-kill sweeps.
 */
const signals = process.platform === "win32" || process.env.CI === undefined;

it.skipIf(signals)("keeps the fatal first bytes and actual abort after a long stack trace", async () => {
	const { home, output } = await fixture();
	const binary = join(home, "owned-fatal-child");
	await writeFile(
		binary,
		`#!/bin/sh
if [ "$1" = --version ]; then printf 'owned fatal fixture\\n'; exit 0; fi
printf 'FATAL first diagnostic\\n' >&2
i=0
while [ "$i" -lt 400 ]; do printf 'stack frame without original fatal reason\\n' >&2; i=$((i+1)); done
printf '[end of stack trace]\\n' >&2
kill -ABRT $$
`,
		{ mode: 0o700 },
	);
	const { status, result } = await run(binary, output);
	expect(status).toBe(1);
	expect(result.primaryFailure).toContain("SIGABRT");
	expect(result.helperExit).toContain("SIGABRT");
	expect(result.cleanup.kind).toBe("complete");
	expect(result.stderr.complete).toBe(true);
	expect(result.process.browserObservation).toBe("unobserved");
	const raw = await readFile(join(output, "chrome.stderr"), "utf8");
	expect(raw.startsWith("FATAL first diagnostic\n")).toBe(true);
	expect(raw.endsWith("[end of stack trace]\n")).toBe(true);
	expect(raw.length).toBeGreaterThan(2000);
	expect(existsSync(result.process.profile ?? "")).toBe(false);
});

it.skipIf(process.platform === "win32")(
	"fails overflow while retaining a bounded beginning and the original byte count",
	async () => {
		const { home, output } = await fixture();
		const binary = join(home, "owned-noisy-child");
		await writeFile(
			binary,
			`#!/bin/sh
if [ "$1" = --version ]; then printf 'owned noisy fixture\\n'; exit 0; fi
printf 'FATAL first diagnostic\\n' >&2
dd if=/dev/zero bs=1048576 count=3 >&2 2>/dev/null
exit 7
`,
			{ mode: 0o700 },
		);
		const { status, result, log } = await run(binary, output);
		expect(status).toBe(1);
		expect(result.stderr.complete).toBe(false);
		expect(result.stderr.bytesBeforeRetention).toBeGreaterThan(2 << 20);
		expect(result.stderr.retainedBytes).toBe(2 << 20);
		expect((await stat(join(output, "chrome.stderr"))).size).toBe(2 << 20);
		expect((await readFile(join(output, "chrome.stderr"), "utf8")).startsWith("FATAL first diagnostic\n")).toBe(true);
		expect(log.length).toBeLessThan(4096);
		expect(result.cleanup.kind).toBe("complete");
	},
);

it.skipIf(signals)(
	"preserves the command timeout before the helper's forced cleanup and leaves no owned child",
	async () => {
		const { home, output } = await fixture();
		const binary = join(home, "owned-unresponsive-child");
		// it answers nothing, so only SIGKILL ends it while the preflight lives; once that parent is gone (a run killed
		// midway), it is re-parented and ends itself instead of outliving the run
		const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
		await writeFile(
			binary,
			`#!/bin/sh
if [ "$1" = --version ]; then printf 'owned unresponsive fixture\\n'; exit 0; fi
exec ${node} -e 'const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(); }, 200)'
`,
			{ mode: 0o700 },
		);
		const { status, result } = await run(binary, output);
		expect(status).toBe(1);
		expect(result.primaryFailure).toContain("did not answer Browser.getVersion in time");
		expect(result.helperExit).toContain("SIGKILL");
		expect(result.cleanup.kind).toBe("complete");
		const pid = Number((await readFile(join(output, "wrapper.pid"), "utf8")).trim());
		expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
		expect(() => process.kill(pid, 0)).toThrow();
		expect(existsSync(result.process.profile ?? "")).toBe(false);
	},
);
