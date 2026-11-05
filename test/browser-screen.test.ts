/**
 * The live view's pointer (web/src/lib/browser.ts, `pageAt`): a point of the app's screen to the page's own pixels,
 * whatever the shape of the box the page is drawn in, wherever it stands, and whatever the device pixel ratio.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pageAt } from "../web/src/lib/browser.ts";
import { pbtRuns } from "./pbt.ts";

const PAGE = { width: 1280, height: 800 };

describe("the live view's pointer", () => {
	it("a box of the page's shape: scaled, offset where the box stands", () => {
		const box = { left: 100, top: 50, width: 640, height: 400 };
		expect(pageAt({ x: 100, y: 50 }, box, PAGE)).toEqual({ x: 0, y: 0 });
		expect(pageAt({ x: 420, y: 250 }, box, PAGE)).toEqual({ x: 640, y: 400 });
		expect(pageAt({ x: 739.9, y: 449.9 }, box, PAGE)).toEqual({ x: 1279, y: 799 });
		expect(pageAt({ x: 740, y: 450 }, box, PAGE)).toBeUndefined();
	});

	it("a box wider than the page: bars left and right, which are not the page", () => {
		// 1000x400 draws the page at 640x400, centred: 180 px of bar on each side
		const box = { left: 0, top: 0, width: 1000, height: 400 };
		expect(pageAt({ x: 100, y: 200 }, box, PAGE)).toBeUndefined();
		expect(pageAt({ x: 900, y: 200 }, box, PAGE)).toBeUndefined();
		expect(pageAt({ x: 180, y: 0 }, box, PAGE)).toEqual({ x: 0, y: 0 });
		expect(pageAt({ x: 500, y: 200 }, box, PAGE)).toEqual({ x: 640, y: 400 });
		// a drag that left the page while pressed: to the nearest edge
		expect(pageAt({ x: 100, y: 200 }, box, PAGE, true)).toEqual({ x: 0, y: 400 });
		expect(pageAt({ x: 990, y: 500 }, box, PAGE, true)).toEqual({ x: 1279, y: 799 });
	});

	it("a box taller than the page (a phone): bars above and below", () => {
		// 390x700 draws the page at 390x243.75, centred: 228.125 px of bar above and below
		const box = { left: 0, top: 60, width: 390, height: 700 };
		expect(pageAt({ x: 195, y: 100 }, box, PAGE)).toBeUndefined();
		expect(pageAt({ x: 195, y: 60 + 228.125 + 121.875 }, box, PAGE)).toEqual({ x: 640, y: 400 });
		expect(pageAt({ x: 195, y: 750 }, box, PAGE)).toBeUndefined();
	});

	it("the device pixel ratio never enters: CSS pixels in, the page's CSS pixels out, at 1 and at 2", () => {
		// at DPR 1 a box stands on whole pixels; at DPR 2 its edges and the pointer may fall on half pixels
		const at1 = { left: 10, top: 20, width: 640, height: 400 };
		const at2 = { left: 10.5, top: 20.5, width: 640, height: 400 };
		expect(pageAt({ x: 10, y: 20 }, at1, PAGE)).toEqual({ x: 0, y: 0 });
		expect(pageAt({ x: 330, y: 220 }, at1, PAGE)).toEqual({ x: 640, y: 400 });
		expect(pageAt({ x: 10, y: 20 }, at2, PAGE)).toBeUndefined();
		expect(pageAt({ x: 10.5, y: 20.5 }, at2, PAGE)).toEqual({ x: 0, y: 0 });
		expect(pageAt({ x: 330.5, y: 220.5 }, at2, PAGE)).toEqual({ x: 640, y: 400 });
		// a page rendered at a scale of 2 sends a JPEG twice as wide; its size is still the screencast's 1280x800
		expect(pageAt({ x: 330.5, y: 220.5 }, at2, { width: 1280, height: 800 })).toEqual({ x: 640, y: 400 });
	});

	it("any point of the page, drawn in any box, comes back to itself", () => {
		fc.assert(
			fc.property(
				fc.record({
					left: fc.double({ min: -500, max: 2000, noNaN: true }),
					top: fc.double({ min: -500, max: 2000, noNaN: true }),
					width: fc.double({ min: 50, max: 4000, noNaN: true }),
					height: fc.double({ min: 50, max: 4000, noNaN: true }),
				}),
				fc.integer({ min: 0, max: PAGE.width - 1 }),
				fc.integer({ min: 0, max: PAGE.height - 1 }),
				(box, x, y) => {
					const scale = Math.min(box.width / PAGE.width, box.height / PAGE.height);
					const left = box.left + (box.width - PAGE.width * scale) / 2;
					const top = box.top + (box.height - PAGE.height * scale) / 2;
					// the middle of the page pixel, as the owner's pointer would land on it
					const at = pageAt({ x: left + (x + 0.5) * scale, y: top + (y + 0.5) * scale }, box, PAGE);
					expect(at).toEqual({ x, y });
				},
			),
			{ numRuns: pbtRuns(200) },
		);
	});
});
