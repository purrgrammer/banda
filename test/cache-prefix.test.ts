import { describe, expect, it } from "vitest";
import { nowLine } from "../src/core/now.ts";
import { context } from "../src/core/store.ts";
import { fauxChat, simulate, wirePayload } from "./fixtures/cache-prefix.ts";

/** The chat's requests so far, in order, as Anthropic's cache would serve them. */
async function predicted(s: ReturnType<typeof fauxChat>) {
	return simulate(await Promise.all(s.requests.map(wirePayload)));
}

describe("what the provider's cache can reuse of banda's requests", () => {
	it("a later request of a turn reads what came before it", async () => {
		const s = fauxChat();
		const harness = await s.open();
		try {
			await s.say(harness, "hi");
			const [first, later] = await predicted(s);
			expect(first?.written).toBeGreaterThan(0);
			expect(later?.read).toBe((first?.read ?? 0) + (first?.written ?? 0));
		} finally {
			await harness.close(context);
		}
	});

	it("the first request of turn 2 reads the previous turn's history", async () => {
		const s = fauxChat();
		const harness = await s.open();
		try {
			await s.say(harness, "hi");
			const ended = s.requests.length - 1;
			await s.say(harness, "again");
			const predictions = await predicted(s);
			expect(predictions[ended + 1]?.read).toBeGreaterThanOrEqual(predictions[ended]?.history ?? 0);
		} finally {
			await harness.close(context);
		}
	});

	it("when the hour changes between turns, the next request still reads the earlier history", async () => {
		let at = 1_800_000_000_000;
		const s = fauxChat(() => at);
		const harness = await s.open();
		try {
			await s.say(harness, "hi");
			const ended = s.requests.length - 1;
			at += 3_600_000;
			await s.say(harness, "again");
			const predictions = await predicted(s);
			expect(JSON.stringify(s.requests[ended + 1]?.context)).toContain(nowLine(at).split(" (")[0]);
			expect(predictions[ended + 1]?.read).toBeGreaterThanOrEqual(predictions[ended]?.history ?? 0);
		} finally {
			await harness.close(context);
		}
	});
});

describe("the simulator's rule", () => {
	const text = (t: string, marked = false) => ({
		type: "text",
		text: t,
		...(marked ? { cache_control: { type: "ephemeral" } } : {}),
	});

	it("reads only up to a block an earlier request marked, and writes up to its own last mark", () => {
		const [one, two, three] = simulate([
			{ messages: [{ role: "user", content: [text("a"), text("b", true)] }] },
			{ messages: [{ role: "user", content: [text("a"), text("b"), text("c", true), text("d")] }] },
			{ messages: [{ role: "user", content: [text("a"), text("x", true)] }] },
		]);
		expect(one).toMatchObject({ read: 0, uncached: 0 });
		expect(two?.read).toBe(one?.written);
		expect(two?.uncached).toBeGreaterThan(0);
		// "a" alone was never marked, so a request that shares only it reads nothing
		expect(three?.read).toBe(0);
	});

	it("does not look further back than 20 blocks", () => {
		const blocks = Array.from({ length: 25 }, (_, i) => text(`block ${i}`));
		const [, far, near] = simulate([
			{ messages: [{ role: "user", content: [text("start", true)] }] },
			{
				messages: [
					{ role: "user", content: [text("start"), ...blocks.slice(0, -1), { ...text("end"), cache_control: {} }] },
				],
			},
			{ messages: [{ role: "user", content: [text("start"), { ...text("end"), cache_control: {} }] }] },
		]);
		expect(far?.read).toBe(0);
		expect(near?.read).toBeGreaterThan(0);
	});
});
