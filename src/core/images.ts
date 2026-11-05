/**
 * Images the daemon decodes come from outside (an upload) or from the box (`read` of an image): a small file
 * can declare enormous dimensions and take gigabytes to decode. Every image is measured from its header first, and
 * one that declares more than `maxPixels`, or whose header cannot be read, is never decoded.
 */
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";

/** 40 megapixels: an 8000 × 5000 photo, about 160 MB decoded. */
export const MAX_PIXELS = 40_000_000;

export type Dimensions = { readonly width: number; readonly height: number };

/** The dimensions an image's header declares: PNG, GIF, JPEG, WebP or BMP; undefined for anything else. */
export function dimensions(bytes: Uint8Array): Dimensions | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const byte = (offset: number) => bytes[offset] ?? 0;
	const at = (offset: number, length: number) => bytes.length >= offset + length;
	const ascii = (offset: number, text: string) =>
		at(offset, text.length) && [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
	// PNG: the signature, then IHDR's width and height
	if (ascii(1, "PNG") && bytes[0] === 0x89 && ascii(12, "IHDR") && at(16, 8))
		return { width: view.getUint32(16), height: view.getUint32(20) };
	if ((ascii(0, "GIF87a") || ascii(0, "GIF89a")) && at(6, 4))
		return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	if (ascii(0, "BM") && at(18, 8))
		return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
		if (ascii(12, "VP8X") && at(24, 6))
			return {
				width: 1 + (byte(24) | (byte(25) << 8) | (byte(26) << 16)),
				height: 1 + (byte(27) | (byte(28) << 8) | (byte(29) << 16)),
			};
		if (ascii(12, "VP8L") && at(21, 4)) {
			const b = view.getUint32(21, true);
			return { width: 1 + (b & 0x3fff), height: 1 + ((b >>> 14) & 0x3fff) };
		}
		if (ascii(12, "VP8 ") && at(26, 4))
			return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
		return undefined;
	}
	// JPEG: the first start-of-frame marker (C0–CF, but C4, C8 and CC, which are not frames)
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (at(offset, 4)) {
			if (bytes[offset] !== 0xff) return undefined;
			const marker = byte(offset + 1);
			if (marker === 0xff) {
				offset++;
				continue;
			}
			const length = view.getUint16(offset + 2);
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
				return at(offset + 5, 4)
					? { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
					: undefined;
			if (length < 2) return undefined;
			offset += 2 + length;
		}
	}
	return undefined;
}

/** `inner`, deciding nothing it should not decode: an image too large by its header, or with no header it can read. */
export function guardImages(inner: ImageProcessor, maxPixels = MAX_PIXELS): ImageProcessor {
	return {
		prepare: async (bytes, mimeType, limits) => {
			const size = dimensions(bytes);
			if (size === undefined || size.width === 0 || size.height === 0) return undefined;
			if (size.width * size.height > maxPixels) return undefined;
			return inner.prepare(bytes, mimeType, limits);
		},
	};
}
