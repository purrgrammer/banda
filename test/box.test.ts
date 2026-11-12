/**
 * The box (DESIGN.md "The box"): pi-durable's env conformance suite on the container box, and what it keeps out.
 * The container cases need Docker and skip without it; the first run builds the image, which takes minutes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Box, openBox } from "../src/box/box.ts";
import { containerBox, dockerAvailable, removeContainerBox } from "../src/box/container.ts";
import { context } from "../src/core/store.ts";
import { until } from "./helpers.ts";

const docker = await dockerAvailable();

/** A home for the whole file: the shared helper's are removed after each test, under a running box. */
function fileHome(): string {
	return mkdtempSync(join(tmpdir(), "banda-box-test-"));
}

async function sh(env: ExecutionEnv, command: string, ctx = context): Promise<{ out: string; code: number }> {
	let out = "";
	const result = await env.exec(command, { onOutput: (text) => (out += text) }, ctx);
	if (!result.ok) return { out: `${out}${result.error.code}: ${result.error.message}`, code: -1 };
	return { out: out.trim(), code: result.value.exitCode };
}

/**
 * A conformance case banda does not rely on: a windowed exec. Under load, pi-env's daemon can replace the last unsent
 * frame of a windowed command and settle it before a next event carries the skip, so the count comes up short. banda
 * runs every command without a window (`bash`, checks, tools), so it is pi-env's to fix (BACKLOG, Upstream).
 */
const UPSTREAM = new Set(["windowed exec keeps the exact tail and counts what it skips"]);

/** Each conformance case in a fresh directory under `root`, in the box. */
function conformance(name: string, box: () => Box, root: () => string) {
	let n = 0;
	const cases = ((title: string, run: () => Promise<void>, timeout?: number) =>
		UPSTREAM.has(title) ? it.skip(title, run, timeout) : it(title, run, timeout)) as typeof it;
	registerEnvConformance(
		{ describe, it: cases, expect: expect as never },
		name,
		async (use) => {
			const dir = `${root()}/case-${++n}`;
			const made = await box().env().createDir(dir, { recursive: true }, context);
			if (!made.ok) throw made.error;
			await use(box().env(dir));
		},
		{ listFiles: true },
	);
}

describe.skipIf(!docker)("the container box", () => {
	let home: string;
	let box: Box;
	beforeAll(async () => {
		home = fileHome();
		box = openBox(containerBox(home), () => {});
		// the first run builds the image
		expect((await sh(box.env(), "true")).code).toBe(0);
	}, 20 * 60_000);
	afterAll(async () => {
		await box?.close();
		if (home !== undefined) {
			await removeContainerBox(home);
			rmSync(home, { recursive: true, force: true });
		}
	});

	conformance(
		"container box: the env conformance suite",
		() => box,
		() => "/work/conformance",
	);

	it("keeps the host out: the owner's uid, a read-only root, no capabilities", async () => {
		const env = box.env();
		expect((await sh(env, "id -u")).out).toBe(String(process.getuid?.()));
		expect((await sh(env, "pwd")).out).toBe("/workspace");
		expect((await sh(env, "touch /usr/x")).code).not.toBe(0);
		expect((await sh(env, "grep CapEff /proc/self/status")).out).toMatch(/0{16}$/);
		expect((await sh(env, "grep NoNewPrivs /proc/self/status")).out).toMatch(/1$/);
		expect((await sh(env, "test -e /Users || ls -A /home | wc -l")).out).toBe("0");
		for (const path of ["/workspace", "/work", "/tools", "/tmp"])
			expect((await sh(env, `touch ${path}/.probe && rm ${path}/.probe`)).code).toBe(0);
	});

	it("a cancelled command is killed with everything it started", async () => {
		const env = box.env();
		const cancel = new AbortController();
		const running = sh(env, "sleep 301 & sleep 302 & wait", withAbortSignal(cancel.signal, context));
		const count = async () => (await sh(env, "pgrep -c -f '^sleep 30[12]$' || true")).out;
		await until(async () => (await count()) === "2");
		cancel.abort();
		expect((await running).out).toContain("aborted");
		// the kill reaches the whole group: none is left (a survivor would keep this waiting, and the test time out)
		await until(async () => (await count()) === "0");
	});

	it("a daemon that starts takes the box over clean: what a command detached is gone", async () => {
		const env = box.env();
		expect((await sh(env, "setsid sleep 307 > /dev/null 2>&1 < /dev/null & echo left")).out).toBe("left");
		// detached, it starts after its command returned
		await until(async () => (await sh(env, "pgrep -f '^sleep 307$' | wc -l")).out === "1");
		// another daemon on the same home: its first bring-up restarts the box
		const next = openBox(containerBox(home), () => {});
		try {
			const again = next.env();
			expect((await sh(again, "pgrep -f '^sleep 307$' | wc -l")).out).toBe("0");
			expect((await sh(again, "cat /workspace/note 2>/dev/null; echo ok")).out).toMatch(/ok$/);
		} finally {
			await next.close();
		}
		// the old connection lost its box with the restart; it reconnects at its next use
		const first = await sh(env, "echo back");
		expect(first.out === "back" ? first.out : (await sh(env, "echo back")).out).toBe("back");
	});

	it("a box that went away is made again at the next use, its files kept", async () => {
		const env = box.env();
		expect((await sh(env, "echo kept > /workspace/note")).code).toBe(0);
		await removeContainerOnly(home);
		// the connection is lost with the container; the next request starts pi-env again, which makes the box first
		const first = await sh(env, "cat /workspace/note");
		const second = first.code === 0 ? first : await sh(env, "cat /workspace/note");
		expect(second.out).toBe("kept");
	});
});

async function removeContainerOnly(home: string): Promise<void> {
	const { execFileSync } = await import("node:child_process");
	const { containerName } = await import("../src/box/container.ts");
	execFileSync("docker", ["rm", "--force", containerName(home)]);
}
