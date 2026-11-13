/**
 * What banda's own provider requests cost: the ones no agent's chat records, by system and model. One bookkeeping doc.
 * `usage` sums only the requests that reported numbers; the others are counted in `unreported`, so an unknown never
 * reads as zero.
 */
import type { JsonRepresentation } from "@earendil-works/chord";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { context } from "./store.ts";

export type System = "inference.face" | "check.provider";

type StoredUsage = JsonRepresentation<Usage>;

export type Line = { requests: number; unreported: number; usage: StoredUsage };

export type SystemUsageValue = {
	systems: { [S in System]?: { [model: string]: Line } };
};

export const SystemUsage = defineDoc<SystemUsageValue>({
	kind: "banda.system-usage",
	version: 1,
	scope: "session",
	initial: () => ({ systems: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

/** What a request answered, as far as it got: the model is known even when nothing came back. */
export type RecordedMessage = Pick<AssistantMessage, "provider" | "model"> & { readonly usage?: Usage | undefined };

/** Commits one request. It never rejects: a request that went out is not undone by failing to write it down. */
export type RecordUsage = (message: RecordedMessage) => Promise<void>;

const zero = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function add(total: StoredUsage, usage: StoredUsage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

/** Whether a provider said anything about a request: an aborted stream can leave every counter at zero, or none. */
export function reported(usage: Usage | undefined): usage is Usage {
	return [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite, usage?.totalTokens].some(
		(count) => (count ?? 0) > 0,
	);
}

/** A strict copy of what the provider reported: a stream keeps writing to its own object, and drafts refuse `undefined`. */
function copy(usage: Usage): StoredUsage {
	const total = zero();
	add(total, { ...usage, cost: usage.cost ?? zero().cost });
	return total;
}

/** A recorder for one system's requests. A record that fails goes to `log`, and the request carries on. */
export function usageRecorder(
	harness: Pick<Harness, "commit">,
	system: System,
	log: (line: string) => void = (line) => console.error(line),
): RecordUsage {
	return async (message) => {
		const model = `${message.provider}/${message.model}`;
		const usage = reported(message.usage) ? copy(message.usage) : undefined;
		try {
			await harness.commit(async (tx) => {
				const doc = await tx.doc(SystemUsage);
				doc.systems[system] ??= {};
				const lines = doc.systems[system];
				lines[model] ??= { requests: 0, unreported: 0, usage: zero() };
				const line = lines[model];
				line.requests++;
				if (usage === undefined) line.unreported++;
				else add(line.usage, usage);
			}, context);
		} catch (error) {
			log(`usage of ${system} not recorded: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
}
