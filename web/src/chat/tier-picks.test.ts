/** A pick of a chat's tier shows at once, falls back with a notice when the store refuses it, and the last pick wins. */
import { describe, expect, it, vi } from "vitest";
import type { Tier } from "../../../src/core/tiers.ts";
import { shownTier, tierPicks } from "./tier-picks.ts";

/** A selector over a store holding `held`, whose saves wait until the test answers them. */
function selector(held: Tier = "balanced") {
	const store = { held };
	const saves: { tier: Tier; ok: () => Promise<void>; refuse: (error: unknown) => Promise<void> }[] = [];
	const failed = vi.fn<(error: unknown, retry: () => void) => void>();
	const picks = tierPicks({
		stored: () => store.held,
		failed,
		save: (tier) =>
			new Promise<void>((resolve, reject) => {
				// a turn for the selector to act on the answer, so the test reads what follows it
				const settled = () => new Promise<void>((next) => setTimeout(next));
				saves.push({
					tier,
					ok: () => {
						resolve();
						return settled();
					},
					refuse: (error) => {
						reject(error);
						return settled();
					},
				});
			}),
	});
	/** The stream says the store holds `tier` now, as the selector hears it. */
	const move = (tier: Tier) => {
		store.held = tier;
		picks.saw(tier);
	};
	return {
		store,
		move,
		saves,
		failed,
		picks,
		shown: () => shownTier(picks.view(), store.held),
		saving: () => picks.view().saving,
	};
}

describe("a pick of a chat's tier", () => {
	it("shows at once, before the store has answered, and says it is saving", () => {
		const it_ = selector();
		it_.picks.pick("deep");
		expect(it_.shown()).toBe("deep");
		expect(it_.saving()).toBe(true);
		expect(it_.saves.map((one) => one.tier)).toEqual(["deep"]);
	});

	it("falls back to the stored tier with a notice when the store refuses it", async () => {
		const it_ = selector();
		it_.picks.pick("deep");
		const refusal = new Error("no such chat");
		await it_.saves[0]?.refuse(refusal);
		expect(it_.shown()).toBe("balanced");
		expect(it_.saving()).toBe(false);
		expect(it_.failed).toHaveBeenCalledTimes(1);
		expect(it_.failed.mock.calls[0]?.[0]).toBe(refusal);
	});

	it("tries the same pick again from the notice, shown at once like the first", async () => {
		const it_ = selector();
		it_.picks.pick("deep");
		await it_.saves[0]?.refuse(new Error("offline"));
		it_.failed.mock.calls[0]?.[1]();
		expect(it_.shown()).toBe("deep");
		expect(it_.saving()).toBe(true);
		expect(it_.saves.map((one) => one.tier)).toEqual(["deep", "deep"]);
	});

	it("holds a saved pick until the store says it, then follows the store", async () => {
		const it_ = selector();
		it_.picks.pick("deep");
		await it_.saves[0]?.ok();
		expect(it_.saving()).toBe(false);
		// answered, and the stream has not said so yet: no flash of the old tier
		expect(it_.shown()).toBe("deep");
		it_.move("deep");
		expect(it_.shown()).toBe("deep");
		// another device moved it afterwards
		it_.move("quick");
		expect(it_.shown()).toBe("quick");
	});

	it("follows the store back to the tier it held before the pick, once the pick was confirmed", async () => {
		const it_ = selector();
		it_.picks.pick("deep");
		await it_.saves[0]?.ok();
		it_.move("deep");
		// another device, or an accepted proposal, puts it back
		it_.move("balanced");
		expect(it_.shown()).toBe("balanced");
	});

	it("does not flash a tier the owner passed through when its echo comes after the last save was answered", async () => {
		const it_ = selector();
		it_.picks.pick("deep");
		it_.picks.pick("quick");
		await it_.saves[0]?.ok();
		await it_.saves[1]?.ok();
		expect(it_.shown()).toBe("quick");
		// the stream, behind, says deep and then quick
		it_.move("deep");
		expect(it_.shown()).toBe("quick");
		it_.move("quick");
		expect(it_.shown()).toBe("quick");
		// and after that it follows the store, whatever the tier
		it_.move("deep");
		expect(it_.shown()).toBe("deep");
	});

	it("follows the store at once when it already said the pick before the save was answered", async () => {
		const it_ = selector();
		it_.picks.pick("deep");
		it_.move("deep");
		await it_.saves[0]?.ok();
		expect(it_.picks.view().pick).toBeUndefined();
		it_.move("balanced");
		expect(it_.shown()).toBe("balanced");
	});

	it("sends one save at a time and ends the store on the owner's last pick", async () => {
		const it_ = selector();
		it_.picks.pick("deep");
		it_.picks.pick("quick");
		it_.picks.pick("deep");
		it_.picks.pick("quick");
		expect(it_.shown()).toBe("quick");
		expect(it_.saves.map((one) => one.tier)).toEqual(["deep"]);
		await it_.saves[0]?.ok();
		expect(it_.saves.map((one) => one.tier)).toEqual(["deep", "quick"]);
		expect(it_.saving()).toBe(true);
		await it_.saves[1]?.ok();
		expect(it_.saving()).toBe(false);
		expect(it_.shown()).toBe("quick");
		expect(it_.failed).not.toHaveBeenCalled();
	});

	it("does not resend a pick the owner came back to while it was saving", async () => {
		const it_ = selector();
		it_.picks.pick("deep");
		it_.picks.pick("quick");
		it_.picks.pick("deep");
		await it_.saves[0]?.ok();
		expect(it_.saves.map((one) => one.tier)).toEqual(["deep"]);
		expect(it_.saving()).toBe(false);
	});

	it("gives no notice for a failed pick the owner has already replaced", async () => {
		const it_ = selector();
		it_.picks.pick("deep");
		it_.picks.pick("quick");
		await it_.saves[0]?.refuse(new Error("busy"));
		expect(it_.failed).not.toHaveBeenCalled();
		expect(it_.shown()).toBe("quick");
		await it_.saves[1]?.ok();
		expect(it_.shown()).toBe("quick");
	});
});
