import { describe, expect, it } from "vitest";
import { attentionFrom, NOTHING, tooltipOf, wantsOwner, withDot } from "../desktop/src/attention.ts";

describe("the desktop tray's dot", () => {
	it("counts only what the page said in whole numbers above zero", () => {
		expect(attentionFrom({ asks: 2, unread: 5 })).toEqual({ asks: 2, unread: 5 });
		for (const said of [undefined, null, "3", 4, {}, { asks: -1, unread: Number.NaN }, { asks: "2", unread: 1.5 }])
			expect(attentionFrom(said)).toEqual(NOTHING);
		expect(wantsOwner(NOTHING)).toBe(false);
		expect(wantsOwner({ asks: 1, unread: 0 })).toBe(true);
		expect(wantsOwner({ asks: 0, unread: 1 })).toBe(true);
	});

	it("says the counts in the tooltip, asks first", () => {
		expect(tooltipOf(NOTHING)).toBe("banda");
		expect(tooltipOf({ asks: 1, unread: 0 })).toBe("banda: 1 waiting");
		expect(tooltipOf({ asks: 2, unread: 3 })).toBe("banda: 2 waiting, 3 unread");
	});

	it("draws the dot in the top right corner inside a ring, at any scale", () => {
		for (const width of [18, 36]) {
			// a full grey square stands in for the icon
			const icon = new Uint8Array(width * width * 4).fill(128);
			const unit = width / 18;
			const pixel = (out: Uint8Array, x: number, y: number) => [
				...out.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
			];
			const center = [Math.floor(width - 3 * unit), Math.floor(3.75 * unit)] as const;
			// 3.25pt above the centre is past the dot and inside the ring
			const onRing = [center[0], Math.floor(0.5 * unit)] as const;
			const near = (got: number[], want: number[]) => {
				for (const [at, value] of got.entries()) expect(Math.abs(value - (want[at] ?? 0))).toBeLessThanOrEqual(8);
			};
			const colored = withDot(icon, width, [255, 255, 255], [28, 28, 28]);
			expect(icon.every((value) => value === 128)).toBe(true);
			expect(pixel(colored, ...center)).toEqual([28, 28, 28, 255]);
			near(pixel(colored, ...onRing), [255, 255, 255, 255]);
			// without a colour the dot is a hole in the icon, the ring still drawn
			const holed = withDot(icon, width, [0, 0, 0]);
			expect(pixel(holed, ...center)).toEqual([0, 0, 0, 0]);
			near(pixel(holed, ...onRing), [0, 0, 0, 255]);
			// the rest of the icon is as it was
			for (const out of [colored, holed]) {
				expect(pixel(out, 0, 0)).toEqual([128, 128, 128, 128]);
				expect(pixel(out, width - 1, width - 1)).toEqual([128, 128, 128, 128]);
				expect(pixel(out, Math.floor(width / 2), Math.floor(width / 2))).toEqual([128, 128, 128, 128]);
			}
		}
	});
});
