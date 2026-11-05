/**
 * Reading the web in a chat: one quiet line for each stretch of reads (the `web_fetch` calls between two of the
 * owner's messages), the pages read, the last first, after the entry of its last call; the family of the browser's
 * "Browsed" line. A read that failed or was refused read nothing, so it is not listed. Pure, like `../chat.ts`.
 */
import type { Segment } from "../chat.ts";
import type { Segmenter, ViewInput } from "./types.ts";

declare module "./types.ts" {
	interface AreaSegments {
		/** What a stretch of reading the web read: its pages, the last first. */
		read: { readonly kind: "read"; readonly key: string; readonly pages: readonly string[] };
	}
}

/** The transcript entry a segment comes from, by its key (`<entry>`, `<entry>:<call>…`, `answer:<entry>`). */
const ENTRY = /^(?:answer:)?(\d+)(?::|$)/;
const entryOf = (key: string): number | undefined => {
	const found = ENTRY.exec(key);
	return found === null ? undefined : Number(found[1]);
};

export function withRead(segments: Segment[], items: ViewInput["items"]): Segment[] {
	const stretches: { last: number; pages: string[] }[] = [];
	let current: { last: number; pages: string[] } | undefined;
	// a page was read only once its call went through
	const through = new Set(items.flatMap((item) => (item.role === "tool" && !item.error ? [item.call] : [])));
	for (const item of items) {
		if (item.role === "user") {
			current = undefined;
			continue;
		}
		if (item.role !== "assistant") continue;
		for (const call of item.calls ?? []) {
			if (call.name !== "web_fetch") continue;
			const url = (call.args as { url?: unknown }).url;
			if (!through.has(call.id) || typeof url !== "string") continue;
			if (current === undefined) {
				current = { last: item.id, pages: [] };
				stretches.push(current);
			}
			current.last = item.id;
			if (!current.pages.includes(url)) current.pages.push(url);
		}
	}
	let out = segments;
	for (const stretch of stretches) {
		const line: Segment = { kind: "read", key: `${stretch.last}:read`, pages: [...stretch.pages].reverse() };
		const later = out.findIndex((segment) => (entryOf(segment.key) ?? -1) > stretch.last);
		const at = later < 0 ? (out.at(-1)?.kind === "working" ? out.length - 1 : out.length) : later;
		out = [...out.slice(0, at), line, ...out.slice(at)];
	}
	return out;
}

export const web: Segmenter = {
	after: (segments, { items }) => withRead(segments, items),
	shown: (segment) => (segment.kind === "read" ? segment.pages : undefined),
};
