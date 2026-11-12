/**
 * A list a service hands oldest first, by numbered pages and with no way to ask for the newest first (GitHub's reviews
 * and comments; DESIGN.md "Watches"): a watch reads its tail, the last pages, so what came last is always in the
 * reading. Where the list ends is the count the reading gives (a pull request's `comments`), or else how long the last
 * look found it; a look reads at most `TAIL_PAGES` pages, so its cost is bounded however long the list grows.
 */
import { type Item, type Json, later, newestOf } from "./follow.ts";

/** A read's `tail`: the field that orders its list (oldest first), and the path of the list's full count, if any. */
export type Tail = { readonly by: string; readonly total?: string };

/** The most pages one look reads of a tail. */
export const TAIL_PAGES = 3;
/** The most items a tail's page may ask for: what services that number their pages hand at most (GitHub's 100). */
export const MAX_TAIL_PAGE = 100;

/**
 * The page a tail's reading starts at, for a list `length` long in pages of `size`: the one before its last, so the
 * reading holds at least a page of the newest even when the last page holds one item. Unknown, the first.
 */
export const tailStart = (length: number | undefined, size: number): number =>
	length === undefined || length <= 0 ? 1 : Math.max(1, Math.ceil(length / size) - 1);

/** What a read of a tail found. */
export type TailRead =
	/** It reached the end: the newest items, oldest first, and how long the whole list is. */
	| { readonly items: Item[]; readonly length: number }
	/** It read `TAIL_PAGES` full pages without reaching the end: the list is at least `length` long. */
	| { readonly behind: true; readonly length: number }
	/** A page could not be read: what the service said. */
	| { readonly failed: string; readonly until?: number };

/**
 * Read the tail of a list in pages of `size`, from where `length` puts it, fetching page `n` (1 first) with `page`.
 * `exact` says `length` is the list's own count, just read: a short page before the last it implies is not the end (a
 * page the service filtered). A list shorter than the count said (items deleted since) steps back a page while
 * nothing is read yet. Never more than `TAIL_PAGES` pages.
 */
export async function readTail(
	page: (n: number) => Promise<Item[] | { readonly failed: string; readonly until?: number }>,
	size: number,
	length: number | undefined,
	exact: boolean,
): Promise<TailRead> {
	let last = exact && length !== undefined && length > 0 ? Math.ceil(length / size) : undefined;
	let n = tailStart(length, size);
	const items: Item[] = [];
	/** How long the list is up to the last page read that held any. */
	let end = 0;
	for (let reads = 0; reads < TAIL_PAGES; reads++) {
		const got = await page(n);
		if (!Array.isArray(got)) return got;
		if (got.length === 0 && items.length === 0 && n > 1) {
			// nothing from here on: the list is shorter than its count said, by little (deleted since) or by much (a count
			// that is wrong); halving the page reaches its start within the pages a look reads either way
			n = Math.floor(n / 2);
			last = n;
			continue;
		}
		items.push(...got);
		if (got.length > 0) end = (n - 1) * size + got.length;
		if (got.length === 0 || (got.length < size && (last === undefined || n >= last))) return { items, length: end };
		n++;
	}
	// the last page read (n - 1) was full: the list may go on past it, so the next look starts at that page
	return { behind: true, length: (n - 1) * size + 1 };
}

/**
 * Whether a watch diffing a tail's list from `before` (the reading it last saw) to `after` (the newest, `length` long
 * as read) may miss items: `after` is not the whole list and does not reach back to the newest item `before` held, so
 * what came between was in neither (more came between two looks than a look's pages, or than a tail's bytes, hold).
 * A list `before` did not hold (its first look, or one not read then) misses none: it is no change of its items.
 */
export function missed(before: Json | undefined, after: Json | undefined, by: string, length: number | undefined) {
	if (!Array.isArray(before) || !Array.isArray(after) || length === undefined || after.length >= length) return false;
	const items = (list: Json[]) =>
		list.filter((item): item is Item => item !== null && typeof item === "object" && !Array.isArray(item));
	const newest = newestOf(items(before), by);
	const oldest = items(after)[0]?.[by];
	if (oldest === undefined) return false;
	return newest === undefined || later(oldest, newest);
}

/** The newest of `items` (oldest first) whose JSON fits in `maxBytes`: the oldest leave first, never the newest. */
export function newestWithin(items: readonly Item[], maxBytes: number): Item[] {
	const kept: Item[] = [];
	let bytes = 2;
	for (let i = items.length - 1; i >= 0; i--) {
		const size = JSON.stringify(items[i]).length + 1;
		if (bytes + size > maxBytes && kept.length > 0) break;
		bytes += size;
		kept.push(items[i] as Item);
	}
	return kept.reverse();
}
