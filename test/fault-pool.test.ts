import { expect, it } from "vitest";
import { pool } from "./fault/kill.ts";

it("bounds nested fault concurrency and preserves every result", async () => {
	let active = 0;
	let peak = 0;
	const result = await pool(
		8,
		Array.from({ length: 12 }, (_, i) => async () => {
			peak = Math.max(peak, ++active);
			await new Promise<void>((resolve) => setImmediate(resolve));
			active--;
			return i;
		}),
	);
	expect(peak).toBe(2);
	expect(active).toBe(0);
	expect(result).toEqual(Array.from({ length: 12 }, (_, i) => i));
});

it("stops scheduling after a failure and drains active work before rejecting", async () => {
	const failure = new Error("injected failure");
	let start!: () => void;
	const started = new Promise<void>((resolve) => {
		start = resolve;
	});
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let drained = false;
	let extra = false;
	const run = pool(8, [
		async () => {
			await started;
			throw failure;
		},
		async () => {
			start();
			await finished;
			drained = true;
		},
		async () => {
			extra = true;
		},
	]);
	let settled = false;
	const checked = run.catch((error) => {
		settled = true;
		expect(drained).toBe(true);
		expect(error).toBe(failure);
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(settled).toBe(false);
	finish();
	await checked;
	expect(settled).toBe(true);
	expect(extra).toBe(false);
});

it("handles empty work and rejects invalid widths", async () => {
	expect(await pool(2, [])).toEqual([]);
	for (const width of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		await expect(pool(width, [])).rejects.toThrow("positive integer");
	}
});
