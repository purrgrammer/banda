import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { ownerEdits } from "./owner-edits.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("owner identity saves", () => {
	it("does not discard one agent's pending edits when the owner opens another", async () => {
		const save = vi.fn(async () => {});
		const edit = ownerEdits(save);
		edit("otto", { name: "Otto renamed" });
		edit("mara", { name: "Mara renamed" });
		await vi.runAllTimersAsync();
		expect(save.mock.calls).toEqual([
			["otto", { name: "Otto renamed" }],
			["mara", { name: "Mara renamed" }],
		]);
	});

	it("submits a face immediately together with any unsaved personality instead of losing either", async () => {
		const save = vi.fn(async () => {});
		const edit = ownerEdits(save);
		const face = defaultAvatarFace();
		edit("otto", { personality: "Speak plainly." });
		edit("otto", { face }, true);
		await Promise.resolve();
		expect(save).toHaveBeenCalledExactlyOnceWith("otto", { personality: "Speak plainly.", face });
		await vi.runAllTimersAsync();
		expect(save).toHaveBeenCalledTimes(1);
	});

	it("serializes edits for one agent so each save can use the previous accepted version", async () => {
		let finish: () => void = () => {};
		const first = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const save = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
		const edit = ownerEdits(save);
		edit("otto", { face: defaultAvatarFace() }, true);
		edit("otto", { name: "A new name" }, true);
		await Promise.resolve();
		expect(save).toHaveBeenCalledTimes(1);
		finish();
		await vi.runAllTimersAsync();
		expect(save).toHaveBeenCalledTimes(2);
		expect(save).toHaveBeenLastCalledWith("otto", { name: "A new name" });
	});

	it("does not block later picks after the caller has reported a failed save", async () => {
		const save = vi.fn().mockRejectedValueOnce(new Error("reported failure")).mockResolvedValue(undefined);
		const edit = ownerEdits(save);
		edit("otto", { name: "First" }, true);
		edit("otto", { name: "Second" }, true);
		await vi.runAllTimersAsync();
		expect(save).toHaveBeenLastCalledWith("otto", { name: "Second" });
	});
});
