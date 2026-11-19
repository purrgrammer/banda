/**
 * The exchange between two agents (DESIGN.md "Agents and groups"): what `message_agent` delivered from each to the
 * other, read from both direct chats, where each message is the recipient's feed entry and nothing else there is
 * theirs to each other. The owner opens it from either agent's chat, at the message that opened it, and reads: no
 * composer, nothing of either agent's turns, tools or thinking, nothing the owner said to either. A page holds the
 * newest messages, older pages come by the cursor the page gives (`?before=`), and a page never leaves a hole: a side
 * that still has older messages holds the other side's back to where they could interleave.
 */
import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { Accepted, agentPath } from "../../core/agents.ts";
import { context } from "../../core/store.ts";
import { AGENT_MESSAGE } from "../../core/turn.ts";
import type { ExchangeMessage, ExchangeView } from "../api.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule } from "./area.ts";

/** Messages a page takes from each side at most. */
export const EXCHANGE_PAGE = 20;
/** Entries a side scans for one page at most, however few messages they hold: a long chat of other work. */
export const EXCHANGE_SCAN = 2000;
/** Entries read from the store at a time. */
const STEP = 50;

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A page's cursor: each side's bound (entries below it are older), 0 when a side has nothing older. */
const CURSOR = /^(\d{1,15})\.(\d{1,15})$/;

/** One side of the exchange: what `from` sent `to`, which landed in `to`'s chat. */
export type Side = { readonly chat: number | undefined; readonly from: string; readonly to: string };

/** A side's newest messages below a bound: oldest first, with the entry scanned last and whether older ones remain. */
export type Fetched = {
	readonly items: readonly ExchangeMessage[];
	/** Whether entries older than `last` remain unread. */
	readonly more: boolean;
	/** The oldest entry id scanned; the next page's bound for this side. */
	readonly last: number | undefined;
};

/** The message an entry holds for this side, or nothing: any other entry of the chat is not the pair's. */
export function messageOf(entry: EntryRecord, side: Side): ExchangeMessage | undefined {
	if (entry.kind !== AGENT_MESSAGE || side.chat === undefined) return undefined;
	const data = entry.data as { from?: unknown; text?: unknown; at?: unknown; call?: unknown } | undefined;
	if (data?.from !== side.from || typeof data.text !== "string" || typeof data.at !== "number") return undefined;
	return {
		chat: side.chat,
		entry: Number(entry.id),
		from: side.from,
		to: side.to,
		text: data.text,
		at: data.at,
		...(typeof data.call === "string" ? { call: data.call } : {}),
	};
}

async function fetchSide(
	harness: Harness,
	side: Side,
	before: number | undefined,
	page: number,
	ctx: Context,
): Promise<Fetched> {
	const none = { items: [], more: false, last: undefined };
	if (side.chat === undefined || before === 0) return none;
	const chat = await harness.conversation(side.chat as ConversationId, ctx);
	if (chat === undefined) return none;
	const range = {
		order: "descending",
		...(before === undefined ? {} : { maxEntryId: (before - 1) as EntryId }),
	} as const;
	const items: ExchangeMessage[] = [];
	let scanned = 0;
	let last: number | undefined;
	let cursor: Parameters<typeof chat.entries>[2];
	let more = false;
	do {
		const read = await chat.entries(range, STEP, cursor, ctx);
		cursor = read.next;
		for (const [index, entry] of read.items.entries()) {
			last = Number(entry.id);
			scanned++;
			const message = messageOf(entry, side);
			if (message !== undefined) items.push(message);
			if (items.length >= page) {
				more = index < read.items.length - 1 || cursor !== undefined;
				break;
			}
		}
		if (items.length >= page) break;
		more = cursor !== undefined;
	} while (cursor !== undefined && scanned < EXCHANGE_SCAN);
	return { items: items.reverse(), more, last };
}

/**
 * One page from what both sides gave: every message newer than the oldest point both sides are known to be whole down
 * to, oldest first, and where each side's next page starts. A side with older messages unread sets that point at its
 * oldest fetched message; what the other side has below it waits for the next page, so pages never interleave out of
 * order. A side unread but empty (nothing but other work in the entries scanned) holds everything back, and the next
 * page scans it further.
 */
export function mergeExchange(fetched: readonly [Fetched, Fetched]): Pick<ExchangeView, "items" | "next"> {
	const floor = Math.max(
		...fetched.map((side) => (side.more ? (side.items[0]?.at ?? Number.POSITIVE_INFINITY) : Number.NEGATIVE_INFINITY)),
	);
	const kept = fetched.map((side) => side.items.filter((item) => item.at >= floor));
	const items = kept.flat().sort((a, b) => a.at - b.at || a.chat - b.chat || a.entry - b.entry);
	const bounds = fetched.map((side, i) => {
		const own = kept[i] ?? [];
		const oldest = own[0];
		// what was kept is whole down to its oldest: the next page reads below it (what was held back is older)
		if (oldest !== undefined) return oldest.entry;
		const newestHeld = side.items.at(-1);
		// everything fetched was held back: read it again, from the newest held
		if (newestHeld !== undefined) return newestHeld.entry + 1;
		// nothing but other work in the entries scanned: go on below the last of them
		return side.more ? (side.last ?? 0) : 0;
	});
	const older = fetched.some((side, i) => side.more || side.items.length > (kept[i]?.length ?? 0));
	return { items, ...(older ? { next: `${bounds[0] ?? 0}.${bounds[1] ?? 0}` } : {}) };
}

/**
 * The exchange between `a` and `b`, newest page first; undefined when either is no agent of this band. `page` is how
 * many messages a side gives a page (the tests page small).
 */
export async function exchange(
	harness: Harness,
	directChat: (harness: Harness, name: string, ctx: Context) => Promise<number | undefined>,
	a: string,
	b: string,
	before: string | undefined,
	ctx: Context = context,
	page = EXCHANGE_PAGE,
): Promise<ExchangeView | undefined> {
	const files = (await harness.snapshot(Accepted, ctx))?.files ?? {};
	if (files[agentPath(a)] === undefined || files[agentPath(b)] === undefined) return undefined;
	const bounds = before === undefined ? undefined : CURSOR.exec(before);
	if (before !== undefined && bounds === null) throw new BadRequest("before is a cursor a page gave");
	const at: [number | undefined, number | undefined] = [
		bounds === undefined || bounds === null ? undefined : Number(bounds[1]),
		bounds === undefined || bounds === null ? undefined : Number(bounds[2]),
	];
	const sides: [Side, Side] = [
		// what a sent b landed in b's chat, and the other way round
		{ chat: await directChat(harness, b, ctx), from: a, to: b },
		{ chat: await directChat(harness, a, ctx), from: b, to: a },
	];
	const fetched: [Fetched, Fetched] = [
		await fetchSide(harness, sides[0], at[0], page, ctx),
		await fetchSide(harness, sides[1], at[1], page, ctx),
	];
	return { agents: [a, b], ...mergeExchange(fetched) };
}

export const exchanges: AreaModule = {
	start: ({ harness, core }) => ({
		route: async ({ method, path, url }) => {
			const found = /^\/exchanges\/([^/]+)\/([^/]+)$/.exec(path);
			if (found === null || method !== "GET") return undefined;
			const [, a = "", b = ""] = found;
			if (!ID.test(a) || !ID.test(b)) throw new BadRequest("an exchange is between two agents, each by its id");
			if (a === b) throw new BadRequest("an exchange is between two different agents");
			const before = url.searchParams.get("before") ?? undefined;
			if (before !== undefined && !CURSOR.test(before)) throw new BadRequest("before is a cursor a page gave");
			const view = await exchange(harness, core.directChat, a, b, before);
			if (view === undefined) return { status: 404, body: { error: "no such agent" } };
			return { body: view };
		},
	}),
};
