/** Model usage from pi-durable's conversation ledgers and Banda's system ledger. */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	type DocumentReader,
	defineExtension,
	defineTool,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { AgentChats, LEAD } from "./agents.ts";
import { backendOf } from "./provider-accounts.ts";
import { SystemUsage } from "./system-usage.ts";
import { READ_USAGE } from "./toolsets.ts";

export type UsageNumbers = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	estimatedUsd: number;
};

export type UsageTotals = UsageNumbers & { cacheReadRate: number | null };
export type UsageRow = UsageTotals & { id: string };

export type UsageReport = {
	total: UsageTotals;
	byAgent: UsageRow[];
	byProvider: UsageRow[];
	byModel: UsageRow[];
	system: UsageTotals;
};

const zero = (): UsageNumbers => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimatedUsd: 0 });

export function usageTotals(numbers: UsageNumbers): UsageTotals {
	const prompt = numbers.input + numbers.cacheRead + numbers.cacheWrite;
	return { ...numbers, cacheReadRate: prompt === 0 ? null : numbers.cacheRead / prompt };
}

type Recorded = Omit<UsageNumbers, "estimatedUsd"> & { cost: { total: number } };

const hasUsage = (usage: Recorded) =>
	usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.cost.total > 0;

function add(target: UsageNumbers, usage: Recorded) {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.estimatedUsd += usage.cost.total;
}

function row(rows: Map<string, UsageNumbers>, id: string): UsageNumbers {
	const prior = rows.get(id);
	if (prior !== undefined) return prior;
	const initial = zero();
	rows.set(id, initial);
	return initial;
}

const sorted = (rows: Map<string, UsageNumbers>): UsageRow[] =>
	[...rows]
		.map(([id, numbers]) => ({ id, ...usageTotals(numbers) }))
		.sort((a, b) => b.estimatedUsd - a.estimatedUsd || a.id.localeCompare(b.id));

export async function readUsage(
	reader: Pick<DocumentReader, "snapshot">,
	ctx: Context,
	agent?: string,
): Promise<UsageReport> {
	const total = zero();
	const system = zero();
	const byAgent = new Map<string, UsageNumbers>();
	const byProvider = new Map<string, UsageNumbers>();
	const byModel = new Map<string, UsageNumbers>();
	const byChat = (await reader.snapshot(AgentChats, ctx))?.chats ?? {};
	const count = (model: string, usage: Recorded, target: UsageNumbers) => {
		add(total, usage);
		const slash = model.indexOf("/");
		const provider = backendOf(slash < 0 ? model : model.slice(0, slash));
		add(row(byProvider, provider), usage);
		add(row(byModel, slash < 0 ? model : provider + model.slice(slash)), usage);
		add(target, usage);
	};
	for (const [id, owner] of Object.entries(byChat)) {
		if (agent !== undefined && owner !== agent) continue;
		const doc = await reader.snapshot(UsageDoc, Number(id) as ConversationId, ctx);
		for (const [model, usage] of Object.entries(doc?.models ?? {})) {
			if (!hasUsage(usage)) continue;
			count(model, usage, row(byAgent, owner));
		}
	}
	if (agent === undefined) {
		const systems = (await reader.snapshot(SystemUsage, ctx))?.systems ?? {};
		for (const models of Object.values(systems))
			for (const [model, line] of Object.entries(models)) if (hasUsage(line.usage)) count(model, line.usage, system);
	}
	return {
		total: usageTotals(total),
		byAgent: sorted(byAgent),
		byProvider: sorted(byProvider),
		byModel: sorted(byModel),
		system: usageTotals(system),
	};
}

export const usageExtension = defineExtension({
	name: "banda.usage",
	tools: [
		defineTool({
			name: READ_USAGE,
			description:
				"Read recorded all-time model token counts, prompt cache read rate and estimated USD spend for your own direct and group chats, by provider and model. The lead agent can also request band-wide usage, including Banda's own model requests. Estimates are based on recorded model rates.",
			parameters: Type.Object(
				{
					scope: Type.Optional(Type.Union([Type.Literal("self"), Type.Literal("band")])),
				},
				{ additionalProperties: false },
			),
			replay: "safe",
			execute: async ({ scope }, api, ctx) => {
				const agent = (await api.snapshot(AgentChats, ctx))?.chats[Number(api.conversationId)];
				if (agent === undefined || (scope === "band" && agent !== LEAD))
					return { output: [{ type: "text", text: "Only the lead agent can read band-wide usage." }], isError: true };
				const report = await readUsage(api, ctx, scope === "band" ? undefined : agent);
				return { output: [{ type: "text", text: JSON.stringify(report) }] };
			},
		}),
	],
});
