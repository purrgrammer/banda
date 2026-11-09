/** Images are measured from their headers before anything decodes them (src/core/images.ts). */
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { describe, expect, it } from "vitest";
import { dimensions, guardImages } from "../src/core/images.ts";

const bytes = (...parts: (string | number[])[]) =>
	Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le32 = (n: number) => [...le16(n & 0xffff), ...le16(n >>> 16)];
const png = (w: number, h: number) =>
	bytes([0x89], "PNG", [13, 10, 26, 10], be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0]);
// a real 2×1 PNG, so the processor behind the guard has something to decode
const TINY = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=";

describe("dimensions", () => {
	it("reads what each format's header declares", () => {
		expect(dimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
		expect(dimensions(bytes("GIF89a", le16(320), le16(200)))).toEqual({ width: 320, height: 200 });
		expect(dimensions(bytes("BM", Array(16).fill(0), le32(100), le32(-50)))).toEqual({ width: 100, height: 50 });
		const jpeg = bytes([0xff, 0xd8], [0xff, 0xe0], [0, 4, 0, 0], [0xff, 0xc0], [0, 11, 8], [0x01, 0x2c], [0x01, 0x90]);
		expect(dimensions(jpeg)).toEqual({ width: 400, height: 300 });
		const vp8x = bytes("RIFF", le32(30), "WEBP", "VP8X", le32(10), [0, 0, 0, 0], [0xff, 0x0f, 0], [0x7f, 0x0b, 0]);
		expect(dimensions(vp8x)).toEqual({ width: 4096, height: 2944 });
		expect(dimensions(bytes("not an image"))).toBeUndefined();
		expect(dimensions(bytes([0xff, 0xd8, 0xff]))).toBeUndefined();
	});
});

describe("guardImages", () => {
	it("decodes a small image, and never one whose header declares too many pixels or cannot be read", async () => {
		const seen: number[] = [];
		const inner: ImageProcessor = {
			prepare: async (data, mimeType) => {
				seen.push(data.length);
				return { data: "x", mimeType };
			},
		};
		const guarded = guardImages(inner);
		expect(await guarded.prepare(png(100_000, 100_000), "image/png", DEFAULT_IMAGE_LIMITS)).toBeUndefined();
		expect(await guarded.prepare(bytes("garbage"), "image/png", DEFAULT_IMAGE_LIMITS)).toBeUndefined();
		expect(seen).toEqual([]);
		expect(await guarded.prepare(png(800, 600), "image/png", DEFAULT_IMAGE_LIMITS)).toEqual({
			data: "x",
			mimeType: "image/png",
		});
	});

	it("passes a real image through to Photon", async () => {
		const guarded = guardImages(await createNodePhotonImages());
		const prepared = await guarded.prepare(
			new Uint8Array(Buffer.from(TINY, "base64")),
			"image/png",
			DEFAULT_IMAGE_LIMITS,
		);
		expect(prepared?.mimeType).toBe("image/png");
	});
});
