/** What a chat follows arrives in order; one fill that fails must not lose what comes behind it. */
import { describe, expect, it } from "vitest";
import { orderedWork } from "./ordered-work.ts";

const now = async () => {};

describe("work done in order", () => {
	it("retries a fill that failed, holding what came after it behind, so nothing lands over a hole", async () => {
		const stop = new AbortController();
		const done: string[] = [];
		const work = orderedWork(stop.signal, now);
		let tries = 0;
		work.fill(async () => {
			if (++tries < 3) throw new Error("the network went away");
			done.push("filled");
		});
		work.step(() => done.push("entry"));
		await work.settled();
		expect(tries).toBe(3);
		expect(done).toEqual(["filled", "entry"]);
	});

	it("goes on after a step that threw", async () => {
		const stop = new AbortController();
		const done: string[] = [];
		const work = orderedWork(stop.signal, now);
		work.step(() => {
			throw new Error("a bad entry");
		});
		work.step(() => done.push("next"));
		await work.settled();
		expect(done).toEqual(["next"]);
	});

	it("stops retrying when the chat is left", async () => {
		const stop = new AbortController();
		const work = orderedWork(stop.signal, now);
		let tries = 0;
		work.fill(async () => {
			if (++tries === 2) stop.abort();
			throw new Error("still away");
		});
		await work.settled();
		expect(tries).toBe(2);
	});
});
