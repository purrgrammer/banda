/**
 * Which chat's browser tab is enlarged, if any, shared by a message's live view and hand-over controls: each chat has
 * its own tab, and the view is inline in the chat until the owner opens it in the full-screen sheet for watching
 * or take-over.
 */
import { useSyncExternalStore } from "react";

let open: number | undefined;
const listeners = new Set<() => void>();

/** Enlarge chat `chat`'s tab, or close the one open (undefined). */
export function setBrowserOpen(chat: number | undefined) {
	if (open === chat) return;
	open = chat;
	for (const listener of listeners) listener();
}

/** The chat whose tab is enlarged, if any. */
export function useBrowserOpen(): number | undefined {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => open,
	);
}

export type Point = { readonly x: number; readonly y: number };
export type Box = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
export type Size = { readonly width: number; readonly height: number };

/**
 * Where on the page a point of the screen falls, in the page's own CSS pixels, or undefined off the page. The page is
 * drawn whole inside `box`, keeping its aspect ratio (CSS `object-fit: contain`), so a box of another shape leaves bars
 * on two sides, which are not the page. `point` and `box` are the app's CSS pixels (a pointer's clientX and clientY, an
 * element's bounding rectangle) and `page` is the page's size as the screencast reports it, in its CSS pixels: the
 * device pixel ratio of either screen never enters. With `clamp`, a point off the page is taken to its nearest edge (a
 * drag that left the page while pressed).
 */
export function pageAt(point: Point, box: Box, page: Size, clamp = false): Point | undefined {
	if (box.width <= 0 || box.height <= 0 || page.width <= 0 || page.height <= 0) return undefined;
	const scale = Math.min(box.width / page.width, box.height / page.height);
	const left = box.left + (box.width - page.width * scale) / 2;
	const top = box.top + (box.height - page.height * scale) / 2;
	const x = (point.x - left) / scale;
	const y = (point.y - top) / scale;
	const inside = x >= 0 && y >= 0 && x < page.width && y < page.height;
	if (!inside && !clamp) return undefined;
	return {
		x: Math.min(page.width - 1, Math.max(0, Math.floor(x))),
		y: Math.min(page.height - 1, Math.max(0, Math.floor(y))),
	};
}
