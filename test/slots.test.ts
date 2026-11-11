import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { hold, type Slots } from "./slots.ts";

/** Ports of a test's own, away from the slots real runs hold. */
const range = (size: number): Slots => ({ first: 20_000 + Math.floor(Math.random() * 8_000), size });
const settled = async (promise: Promise<unknown>) => {
	const pending = Symbol();
	await new Promise((resolve) => setTimeout(resolve, 300));
	return (await Promise.race([promise, pending])) !== pending;
};

it("gives out no more slots than there are, and the next waiter gets one when it is released", async () => {
	const slots = range(2);
	const first = await hold(slots);
	const second = await hold(slots);
	const third = hold(slots);
	expect(await settled(third)).toBe(false);
	await first();
	const last = await third;
	await Promise.all([second(), last()]);
});

it("frees the slot of a process that is killed", async () => {
	const slots = range(1);
	const module = fileURLToPath(new URL("./slots.ts", import.meta.url));
	const holder = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { hold } = await import(${JSON.stringify(module)}); await hold(${JSON.stringify(slots)}); console.log("held"); setInterval(() => {}, 1000);`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	const exited = new Promise((resolve) => holder.once("exit", resolve));
	await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
	const waiting = hold(slots);
	expect(await settled(waiting)).toBe(false);
	holder.kill("SIGKILL");
	await exited;
	await (await waiting)();
});

it("fails, naming the ports, when no slot comes free within its patience", async () => {
	const slots = { ...range(1), patience: 300 };
	const held = await hold(slots);
	await expect(hold(slots)).rejects.toThrow(`127.0.0.1:${slots.first}`);
	await held();
});
