/**
 * The signer's client when the system gives a child no pipes (EMFILE, ENFILE): the call answers a fixed code, kills
 * that child, and the home's next call starts its own (src/wallet/signer-client.ts, C20). Only `spawn` is replaced; the
 * second call reaches the real one.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const pipeless = vi.hoisted(() => ({ left: 0, killed: [] as string[] }));

vi.mock("node:child_process", async (actual) => {
	const real = await actual<typeof import("node:child_process")>();
	return {
		...real,
		spawn: ((...args: Parameters<typeof real.spawn>) => {
			if (pipeless.left === 0) return real.spawn(...args);
			pipeless.left -= 1;
			const child = Object.assign(new EventEmitter(), {
				pid: 4242,
				stdin: null,
				stdout: null,
				exitCode: null as number | null,
				signalCode: null as string | null,
				kill(signal: string) {
					pipeless.killed.push(signal);
					child.signalCode = signal;
					queueMicrotask(() => child.emit("exit", null, signal));
					return true;
				},
			});
			return child;
		}) as typeof real.spawn,
	};
});

const { Signer } = await import("../src/wallet/signer-client.ts");

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("answers other for a child with no pipes, kills it, and the home's next call runs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "banda-signer-spawn-"));
	dirs.push(dir);
	const env = { ...process.env, BANDA_TEST_KEYSTORE: join(dir, "keys.json") };
	const signer = new Signer({ id: "h-spawn", binding: "a".repeat(64) }, { env, deadline: 10_000 });
	try {
		pipeless.left = 1;
		expect(await signer.canary()).toEqual({ ok: false, code: "other" });
		expect(pipeless.killed).toEqual(["SIGKILL"]);
		expect(await signer.canary()).toEqual({ ok: true });
	} finally {
		signer.stop();
	}
});
