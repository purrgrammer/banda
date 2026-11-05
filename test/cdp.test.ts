import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { Cdp, CdpError } from "../src/box/cdp.ts";

const spawned = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock("node:child_process", () => ({ spawn: () => spawned.child }));
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanups.splice(0)) close();
	vi.useRealTimers();
});
function setup() {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => true),
	});
	spawned.child = child;
	const log = vi.fn();
	const cdp = new Cdp(["controlled-browser"], log);
	cleanups.push(() => {
		child.emit("close", 0, null);
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
	});
	return { child, cdp, log };
}

it("ends at process exit even while a descendant holds diagnostic stderr open", async () => {
	const { child, cdp } = setup();
	const pending = cdp.send("Unanswered.command").catch((error: unknown) => error);
	let ended: string | undefined;
	void cdp.ended.then((why) => {
		ended = why;
	});
	// Node's exit event does not require inherited stdio to have closed. Deliberately withhold close.
	child.emit("exit", 0, null);
	await Promise.resolve();
	expect(ended).toBe("it ended (code 0)");
	expect(cdp.closed).toBe(ended);
	expect(await pending).toBeInstanceOf(CdpError);
	expect(child.stdout.destroyed).toBe(true);
	expect(child.stderr.destroyed).toBe(true);
});

it("spawn failure settles pending commands without needing an exit event", async () => {
	const { child, cdp } = setup();
	const pending = cdp.send("Unanswered.command").catch((error: unknown) => error);
	child.emit("error", new Error("ENOENT"));
	expect(await cdp.ended).toBe("it did not start: ENOENT");
	expect(await pending).toBeInstanceOf(CdpError);
});

it("answers normally and bounds shutdown without waiting for diagnostic EOF", async () => {
	vi.useFakeTimers();
	const { child, cdp } = setup();
	const answer = cdp.send("Answered.command");
	child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\0`);
	expect(await answer).toEqual({ ok: true });
	cdp.close();
	expect(child.stdin.writableEnded).toBe(true);
	await vi.advanceTimersByTimeAsync(3000);
	expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
	child.emit("exit", null, "SIGKILL");
	expect(await cdp.ended).toBe("it ended (SIGKILL)");
});

it("does not publish buffered events after process exit", async () => {
	const { child, cdp, log } = setup();
	const event = vi.fn();
	cdp.on(event);
	child.stderr.write("last browser diagnostic\n");
	child.emit("exit", 1, null);
	await Promise.resolve();
	child.stdout.emit("data", Buffer.from(`${JSON.stringify({ method: "Page.late", params: {} })}\0`));
	expect(event).not.toHaveBeenCalled();
	expect(await cdp.ended).toContain("last browser diagnostic");
	child.emit("close", 1, null);
	await Promise.resolve();
	expect(log).toHaveBeenCalledTimes(1);
});
