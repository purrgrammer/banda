/** Words for token counts and costs in the raw transcript (DESIGN.md "The prompt"). */
import type { Item, TurnUsage } from "../../../src/server/api.ts";
import { startsRun } from "./feed.ts";

/** A token count, short: 812, 12.3k, 1.2M. */
export function tokens(n: number): string {
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Dollars, to the precision a single request needs. */
export function dollars(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

/** What a request held: everything sent, cached or not. */
export const sent = (u: TurnUsage) => u.input + u.cacheRead + u.cacheWrite;

/** The share of what was sent that the provider read from its cache, 0 to 1; undefined when nothing was sent. */
export function cached(u: TurnUsage): number | undefined {
	const all = sent(u);
	return all === 0 ? undefined : u.cacheRead / all;
}

/**
 * The context around compaction `id`: before, the newest answer's (what it was sent and what it said); after, what
 * the next answer was sent. Either is undefined when its answer is not among `items`.
 */
export function aroundCompaction(
	items: readonly Item[],
	id: number,
): { readonly before?: number; readonly after?: number } {
	const at = items.findIndex((item) => item.id === id);
	if (at < 0) return {};
	let before: number | undefined;
	for (let i = at - 1; i >= 0 && before === undefined; i--) {
		const item = items[i];
		if (item?.role === "assistant" && item.usage !== undefined && sent(item.usage) > 0)
			before = sent(item.usage) + item.usage.output;
		if (item?.role === "compaction") break;
	}
	let after: number | undefined;
	for (let i = at + 1; i < items.length && after === undefined; i++) {
		const item = items[i];
		if (item?.role === "assistant" && item.usage !== undefined && sent(item.usage) > 0) after = sent(item.usage);
		if (item?.role === "compaction") break;
	}
	return { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
}

/** Why a compaction ran, in words. */
export function reasonWords(reason: string): string {
	return reason === "threshold"
		? "past the budget"
		: reason === "overflow"
			? "the model refused the size"
			: reason === "manual"
				? "asked for"
				: reason;
}

/** One ended turn: every request it made, summed, and how full the context was at its last. */
export type TurnTotals = {
	/** The model of its last request, `provider/modelId`. */
	readonly model?: string;
	/** Its requests' usage, summed: what each sent uncached, read from and wrote to cache, answered, and cost. */
	readonly usage: TurnUsage;
	/** How many requests it made, failed attempts included. */
	readonly requests: number;
	/** The context at its last request that counted any: everything sent, and what came back. */
	readonly context?: number;
};

const ZERO: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function add(a: TurnUsage, b: TurnUsage): TurnUsage {
	const reasoning =
		a.reasoning === undefined && b.reasoning === undefined ? undefined : (a.reasoning ?? 0) + (b.reasoning ?? 0);
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		...(reasoning === undefined ? {} : { reasoning }),
		cost: a.cost + b.cost,
	};
}

/** Input that starts a turn or comes to one: the owner's words, a routine or a watch waking, what an agent told it. */
const isInput = (item: Item) => startsRun(item);

type Answer = Extract<Item, { role: "assistant" }>;

/**
 * The turns among `items` that ended, by the id of each one's last answer. Each request of a turn is an assistant item
 * of its own and sends the whole context again, so one request's numbers say little: a turn is read whole, from the
 * input that started it to the answer that ended it (one with no tool calls, or a failed one nothing came after). A
 * turn still running (`busy`, not ended yet) has none, and neither has one whose start is not among `items` (an older
 * page not read yet), whose sum would be short.
 */
export function turnTotals(items: readonly Item[], busy: boolean): Map<number, TurnTotals> {
	const ended = new Map<number, TurnTotals>();
	let started = false;
	let answers: Answer[] = [];
	const close = () => {
		const last = answers.at(-1);
		if (started && last !== undefined) {
			const counted = [...answers]
				.reverse()
				.find((a) => a.usage !== undefined && sent(a.usage) + a.usage.output > 0)?.usage;
			ended.set(last.id, {
				...(last.model === undefined ? {} : { model: last.model }),
				usage: answers.reduce((sum, a) => (a.usage === undefined ? sum : add(sum, a.usage)), ZERO),
				requests: answers.length,
				...(counted === undefined ? {} : { context: sent(counted) + counted.output }),
			});
		}
		answers = [];
		// what follows an ended turn is the next one, from its start
		started = true;
	};
	for (const item of items) {
		if (isInput(item)) {
			// after a failed answer the run is over: what comes next is another turn
			if (answers.at(-1)?.error !== undefined) close();
			started = true;
		} else if (item.role === "assistant") {
			answers.push(item);
			// a failed request may be retried within the turn: only an input or the run's end tells it ended
			if ((item.calls?.length ?? 0) === 0 && (item.error === undefined || item.error === "interrupted")) close();
		}
	}
	if (!busy && answers.length > 0) close();
	return ended;
}

/** The newest ended turn among `items`, if any. */
export function lastTurn(totals: ReadonlyMap<number, TurnTotals>): TurnTotals | undefined {
	return [...totals.values()].at(-1);
}
