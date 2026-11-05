/**
 * The browser in a chat: while this chat's run uses it (or the owner holds it), one card (what it is on, who has it,
 * Open), just before what the newest call that used it drew: the page as it stands, then the approval for the next
 * page, then what came after; last, above the line of work in progress, when nothing did. The browser stays open a while after a
 * run ends, to keep its page for the next one; that is not use, so a finished run shows no line. Pure, like
 * `../chat.ts`.
 */
import type { BrowserView } from "../../../../src/server/api.ts";
import type { Segment } from "../chat.ts";
import type { Segmenter, ViewInput } from "./types.ts";

declare module "./types.ts" {
	interface AreaSegments {
		/** The browser line: the browser this chat holds, while it runs. */
		browser: { readonly kind: "browser"; readonly key: string; readonly view: BrowserView };
		/** What a finished stretch of browsing opened: its pages, the last first; it stays after the browser closed. */
		browsed: { readonly kind: "browsed"; readonly key: string; readonly pages: readonly string[] };
	}
	interface ViewContext {
		/** The browser, as the daemon last said, when it runs for this chat. */
		readonly browser?: BrowserView;
	}
}

/** The transcript entry a segment comes from, by its key (`<entry>`, `<entry>:<call>…`, `answer:<entry>`). */
const ENTRY = /^(?:answer:)?(\d+)(?::|$)/;
const entryOf = (key: string): number | undefined => {
	const found = ENTRY.exec(key);
	return found === null ? undefined : Number(found[1]);
};

export function withBrowser(
	segments: Segment[],
	{ context, live, items }: Pick<ViewInput, "context" | "live" | "items">,
): Segment[] {
	segments = withBrowsed(segments, items, inUse(context.browser, live.busy));
	const view = context.browser;
	// a message of this run shows the browser live already; one before the owner last spoke is a finished one
	const lastOf = (is: (segment: Segment) => boolean) =>
		segments.reduce((last, segment, index) => (is(segment) ? index : last), -1);
	const spoke = lastOf((segment) => segment.kind === "owner" || segment.kind === "owner-message");
	const shown = lastOf((segment) => segment.kind === "companion" && segment.view === "browser");
	if (view === undefined || !inUse(view, live.busy) || shown > spoke) return segments;
	const line: Segment = { kind: "browser", key: "browser", view };
	// just before what the newest call that used the browser drew (its approval for the next page): the page as it
	// stands, then what was asked next, and the card stays by the newest of the chat
	const used = items.reduce(
		(last, item) =>
			item.role === "assistant" && (item.calls ?? []).some((call) => call.name.startsWith("browser_")) ? item.id : last,
		-1,
	);
	const later = used < 0 ? -1 : segments.findIndex((segment) => (entryOf(segment.key) ?? -1) >= used);
	// else last, the line of work in progress staying last
	const end = segments.at(-1)?.kind === "working" ? segments.length - 1 : segments.length;
	const at = later < 0 ? end : Math.min(later, end);
	return [...segments.slice(0, at), line, ...segments.slice(at)];
}

/**
 * One line for each stretch of browsing (the calls between two of the owner's messages): the pages it opened, after
 * the entry of its last call. The stretch in use now has the live line instead.
 */
export function withBrowsed(segments: Segment[], items: ViewInput["items"], using: boolean): Segment[] {
	const stretches: { last: number; pages: string[] }[] = [];
	let current: { last: number; pages: string[] } | undefined;
	// a page was browsed only once its call went through: one waiting for the owner, or refused, was not
	const through = new Set(items.flatMap((item) => (item.role === "tool" && !item.error ? [item.call] : [])));
	for (const item of items) {
		if (item.role === "user") {
			current = undefined;
			continue;
		}
		if (item.role !== "assistant") continue;
		for (const call of item.calls ?? []) {
			if (!call.name.startsWith("browser_")) continue;
			if (current === undefined) {
				current = { last: item.id, pages: [] };
				stretches.push(current);
			}
			current.last = item.id;
			const url = (call.args as { url?: unknown }).url;
			if (
				call.name === "browser_navigate" &&
				through.has(call.id) &&
				typeof url === "string" &&
				!current.pages.includes(url)
			)
				current.pages.push(url);
		}
	}
	const done = using ? stretches.slice(0, -1) : stretches;
	let out = segments;
	for (const stretch of done) {
		if (stretch.pages.length === 0) continue;
		const line: Segment = { kind: "browsed", key: `${stretch.last}:browsed`, pages: [...stretch.pages].reverse() };
		const later = out.findIndex((segment) => (entryOf(segment.key) ?? -1) > stretch.last);
		const at = later < 0 ? (out.at(-1)?.kind === "working" ? out.length - 1 : out.length) : later;
		out = [...out.slice(0, at), line, ...out.slice(at)];
	}
	return out;
}

/** Whether the browser is in use for this chat: it runs for it, and its run goes on or the owner holds it. */
export function inUse(view: BrowserView | undefined, busy: boolean): boolean {
	return view?.running === true && (busy || view.control === "owner");
}

export const browser: Segmenter = {
	after: withBrowser,
	shown: (segment) => (segment.kind === "browser" ? [segment.view.title ?? "", segment.view.url ?? ""] : undefined),
};
