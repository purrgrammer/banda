/**
 * Whether a home used the provider's prompt cache well, from what its store already holds: pure over rows, so the
 * reading of the store stays in `scripts/cache-audit.ts`. Aggregates only; message text never reaches it.
 */
import type { JsonRepresentation } from "@earendil-works/chord";
import type { Usage } from "@earendil-works/pi-ai";
import type { Line, System, SystemUsageValue } from "./system-usage.ts";

/** How long a prompt stays cached after its last use unless the audit is told otherwise: Anthropic's short cache. */
export const CACHE_WINDOW = 5 * 60_000;

export type AuditUsage = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
};

/** One chat's history, oldest first: what starts a turn, and each request its assistant entries record. */
export type AuditRow =
	| { readonly type: "input"; readonly chat: number }
	| {
			readonly type: "request";
			readonly chat: number;
			readonly at: number;
			/** `provider/modelId`. */
			readonly model: string;
			readonly usage?: AuditUsage | undefined;
	  };

/** `first` should have read the cache; `first-cold` came too late to, or was the chat's first; `later` is mid-turn. */
export type RequestClass = "first" | "first-cold" | "later";

const CLASSES: readonly RequestClass[] = ["first", "first-cold", "later"];

type Tokens = { requests: number; read: number; written: number; uncached: number };

export type ClassLine = Tokens & { readonly class: RequestClass; readonly model: string; readonly hitRate?: number };
export type SystemLine = Tokens & {
	readonly system: System;
	readonly model: string;
	readonly unreported: number;
	readonly hitRate?: number;
};
export type UnaccountedLine = {
	readonly provider: string;
	readonly input: number;
	readonly output: number;
	readonly read: number;
	readonly written: number;
	readonly cost: number;
};

export type CacheAudit = {
	readonly classes: readonly ClassLine[];
	/** Requests left out above and below: no counter reported. */
	readonly unreported: number;
	readonly starts: { readonly cold: number; readonly turns: number };
	readonly systems: readonly SystemLine[];
	/** The conversations' ledgers minus their entries: compaction and other requests with no entry, per provider. */
	readonly unaccounted: readonly UnaccountedLine[];
};

const hasNumbers = (usage: AuditUsage | undefined): usage is AuditUsage =>
	usage !== undefined && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;

const hitRate = ({ read, written, uncached }: Tokens): { hitRate?: number } => {
	const sent = uncached + read + written;
	return sent === 0 ? {} : { hitRate: read / sent };
};

const tokensOf = (usage: JsonRepresentation<Usage> | undefined) =>
	usage === undefined
		? { input: 0, output: 0, read: 0, written: 0, cost: 0 }
		: {
				input: usage.input,
				output: usage.output,
				read: usage.cacheRead,
				written: usage.cacheWrite,
				cost: usage.cost.total,
			};

const providerOf = (model: string) => model.split("/", 1)[0] ?? model;

/**
 * The audit of `rows`, each chat's in order; `ledger` is every conversation's `pi.usage` models summed by
 * `provider/modelId`.
 */
export function auditCache({
	rows,
	usage,
	ledger,
	between = {},
	window = CACHE_WINDOW,
}: {
	rows: readonly AuditRow[];
	usage: Readonly<SystemUsageValue> | undefined;
	ledger: { readonly [model: string]: JsonRepresentation<Usage> };
	/** Count only requests in this range, to compare before and after a change; each chat's gaps still use all of them. */
	between?: { readonly from?: number; readonly to?: number };
	/** How long a prompt stays cached after its last use, in milliseconds. */
	window?: number;
}): CacheAudit {
	const inside = (at: number) =>
		at >= (between.from ?? Number.NEGATIVE_INFINITY) && at < (between.to ?? Number.POSITIVE_INFINITY);
	const lines = new Map<string, Tokens & { class: RequestClass; model: string }>();
	const chats = new Map<number, { starting: boolean; last?: number }>();
	const entries = new Map<string, UnaccountedLine>();
	let unreported = 0;
	let cold = 0;
	let turns = 0;
	for (const row of rows) {
		const chat = chats.get(row.chat) ?? { starting: false };
		chats.set(row.chat, chat);
		if (row.type === "input") {
			chat.starting = true;
			continue;
		}
		// a request with no numbers never reached the model as far as anyone can tell: it does not start a turn
		if (!hasNumbers(row.usage)) {
			unreported++;
			continue;
		}
		const late = chat.last === undefined || row.at - chat.last >= window;
		const kind: RequestClass = chat.starting ? (late ? "first-cold" : "first") : "later";
		if (inside(row.at)) {
			if (chat.starting) {
				turns++;
				if (late) cold++;
			}
			const key = `${kind}\0${row.model}`;
			const line = lines.get(key) ?? { class: kind, model: row.model, requests: 0, read: 0, written: 0, uncached: 0 };
			lines.set(key, line);
			line.requests++;
			line.read += row.usage.cacheRead;
			line.written += row.usage.cacheWrite;
			line.uncached += row.usage.input;
		}
		chat.starting = false;
		chat.last = row.at;
		const provider = providerOf(row.model);
		const seen = entries.get(provider) ?? { provider, input: 0, output: 0, read: 0, written: 0, cost: 0 };
		entries.set(provider, {
			provider,
			input: seen.input + row.usage.input,
			output: seen.output + row.usage.output,
			read: seen.read + row.usage.cacheRead,
			written: seen.written + row.usage.cacheWrite,
			cost: seen.cost + row.usage.cost,
		});
	}

	const systems: SystemLine[] = [];
	for (const [system, models] of Object.entries(usage?.systems ?? {}) as [System, { [model: string]: Line }][]) {
		for (const [model, line] of Object.entries(models)) {
			const tokens = {
				requests: line.requests,
				read: line.usage.cacheRead,
				written: line.usage.cacheWrite,
				uncached: line.usage.input,
			};
			systems.push({ system, model, unreported: line.unreported, ...tokens, ...hitRate(tokens) });
		}
	}

	const ledgers = new Map<string, UnaccountedLine>();
	for (const [model, spent] of Object.entries(ledger)) {
		const provider = providerOf(model);
		const seen = ledgers.get(provider) ?? { provider, input: 0, output: 0, read: 0, written: 0, cost: 0 };
		const tokens = tokensOf(spent);
		ledgers.set(provider, {
			provider,
			input: seen.input + tokens.input,
			output: seen.output + tokens.output,
			read: seen.read + tokens.read,
			written: seen.written + tokens.written,
			cost: seen.cost + tokens.cost,
		});
	}
	const unaccounted = [...new Set([...ledgers.keys(), ...entries.keys()])].sort().map((provider): UnaccountedLine => {
		const spent = ledgers.get(provider);
		const recorded = entries.get(provider);
		return {
			provider,
			input: (spent?.input ?? 0) - (recorded?.input ?? 0),
			output: (spent?.output ?? 0) - (recorded?.output ?? 0),
			read: (spent?.read ?? 0) - (recorded?.read ?? 0),
			written: (spent?.written ?? 0) - (recorded?.written ?? 0),
			cost: (spent?.cost ?? 0) - (recorded?.cost ?? 0),
		};
	});

	return {
		classes: [...lines.values()]
			.sort((a, b) => CLASSES.indexOf(a.class) - CLASSES.indexOf(b.class) || a.model.localeCompare(b.model))
			.map((line) => ({ ...line, ...hitRate(line) })),
		unreported,
		starts: { cold, turns },
		systems,
		unaccounted,
	};
}
