import { ChevronRightIcon, UserRoundIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { cn } from "@/lib/cn";
import type { AvatarFace } from "../../../src/core/avatar-face.ts";
import type { UsageReport, UsageRow, UsageTotals } from "../../../src/core/usage.ts";
import { Face } from "./Face.tsx";
import { ProviderMark } from "./ProviderMark.tsx";

const currency = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const smallCurrency = new Intl.NumberFormat(undefined, {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 4,
	maximumFractionDigits: 4,
});
const count = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, {
	style: "percent",
	maximumFractionDigits: 0,
	minimumIntegerDigits: 2,
});
const usd = (amount: number) =>
	amount > 0 && amount < 0.0001
		? `<${smallCurrency.format(0.0001)}`
		: amount > 0 && amount < 0.01
			? smallCurrency.format(amount)
			: currency.format(amount);
const rate = (value: number | null) => (value === null ? "—" : percent.format(value));
const groups = ["agent", "provider", "model"] as const;
type Group = (typeof groups)[number];
type AgentLabel = { name: string; face?: AvatarFace };
type Label = AgentLabel & { provider?: string };

const providerNames: Readonly<Record<string, string>> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	"openai-codex": "OpenAI Codex",
	google: "Google",
	"google-vertex": "Google Vertex",
	azure: "Azure",
	"azure-openai": "Azure OpenAI",
	"amazon-bedrock": "Amazon Bedrock",
	bedrock: "Amazon Bedrock",
	"github-copilot": "GitHub Copilot",
	openrouter: "OpenRouter",
	xai: "xAI",
	mistral: "Mistral",
	groq: "Groq",
	cerebras: "Cerebras",
	deepseek: "DeepSeek",
};

function TokenCounts({ usage }: { usage: UsageTotals }) {
	return (
		<dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-meta sm:grid-cols-4">
			{(
				[
					["Input", usage.input],
					["Cache read", usage.cacheRead],
					["Cache write", usage.cacheWrite],
					["Output", usage.output],
				] as const
			).map(([label, value]) => (
				<div key={label} className="min-w-0">
					<dt className="text-ink-2">{label}</dt>
					<dd className="break-words font-medium tabular-nums text-ink">{count.format(value)}</dd>
				</div>
			))}
		</dl>
	);
}

const columns = "grid grid-cols-[minmax(4.25rem,1.2fr)_minmax(1.5rem,1fr)_5rem_4rem] items-center gap-2 px-1";

function SpendBars({ group, rows, label }: { group: Group; rows: readonly UsageRow[]; label: (id: string) => Label }) {
	const max = rows.reduce((largest, row) => Math.max(largest, row.estimatedUsd), 0);
	return (
		<div className="flex flex-col gap-1">
			<div aria-hidden="true" className={cn(columns, "text-meta text-ink-2")}>
				<span className="capitalize">{group}</span>
				<span />
				<span className="text-right">Spend</span>
				<span className="pr-3.5 text-right">Cache</span>
			</div>
			<ul aria-label={`Estimated spend by ${group}`} className="divide-y divide-line-soft">
				{rows.map((row) => {
					const { name, face, provider } = label(row.id);
					return (
						<li key={row.id} className="min-w-0">
							<details className="group">
								<summary
									className={cn(
										columns,
										"min-h-9 cursor-pointer list-none rounded-field hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden",
									)}
								>
									<span className="flex min-w-0 items-center gap-1.5" title={name}>
										{group === "agent" ? (
											<span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
												{face === undefined ? (
													<UserRoundIcon className="size-4 text-ink-2" />
												) : (
													<Face face={face} name={name} size="text" className="size-4" />
												)}
											</span>
										) : provider === undefined ? null : (
											<ProviderMark provider={provider} />
										)}
										<span className="truncate text-ui font-medium text-ink">{name}</span>
									</span>
									<span aria-hidden="true" className="h-2.5 overflow-hidden rounded-full bg-paper-3">
										<span
											className="block h-full rounded-full bg-ink-3"
											style={{
												width: max === 0 ? "0%" : `${(100 * row.estimatedUsd) / max}%`,
												backgroundColor: face?.color,
											}}
										/>
									</span>
									<span className="whitespace-nowrap text-right text-ui tabular-nums text-ink">
										{usd(row.estimatedUsd)}
									</span>
									<span className="flex items-center justify-end gap-0.5 whitespace-nowrap text-meta tabular-nums text-ink-2">
										{rate(row.cacheReadRate)}
										<span className="sr-only"> cache read</span>
										<ChevronRightIcon aria-hidden="true" className="size-3 shrink-0 group-open:rotate-90" />
									</span>
								</summary>
								<div className="mt-1 rounded-field bg-paper-2 px-2.5 py-2">
									<TokenCounts usage={row} />
								</div>
							</details>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

export function UsagePanel({
	report,
	agent,
	modelName,
}: {
	report: UsageReport;
	agent: (id: string) => AgentLabel;
	modelName?: (id: string) => string | undefined;
}) {
	const [group, setGroup] = useState<Group>("agent");
	const { total, byAgent, byProvider, byModel, system } = report;
	const rows =
		group === "agent"
			? [
					...byAgent,
					...(system.input + system.cacheRead + system.cacheWrite + system.output + system.estimatedUsd > 0
						? [{ ...system, id: "@banda" }]
						: []),
				].sort((a, b) => b.estimatedUsd - a.estimatedUsd)
			: group === "provider"
				? byProvider
				: byModel;
	const nameOf = (id: string): Label => {
		if (group === "agent") return id === "@banda" ? { name: "Banda" } : agent(id);
		if (group === "provider") return { name: providerNames[id] ?? id, provider: id };
		const slash = id.indexOf("/");
		const model = slash < 0 ? id : id.slice(slash + 1);
		return { name: modelName?.(model) ?? model, ...(slash < 0 ? {} : { provider: id.slice(0, slash) }) };
	};
	return (
		<section className="flex min-w-0 flex-col gap-3.5">
			<header className="flex items-center justify-between gap-2">
				<h2 className="text-body font-semibold text-ink">Usage</h2>
				<ButtonGroup aria-label="Group usage by">
					{groups.map((each) => (
						<Button
							key={each}
							size="sm"
							variant="outline"
							aria-pressed={group === each}
							onClick={() => setGroup(each)}
							className="capitalize aria-pressed:bg-paper-3"
						>
							{each}
						</Button>
					))}
				</ButtonGroup>
			</header>
			{byProvider.length === 0 ? (
				<p className="text-ui text-ink-2">No model usage has been recorded yet.</p>
			) : (
				<>
					<div className="flex flex-col gap-2.5 rounded-tile border border-line-soft px-3.5 py-3">
						<dl className="grid grid-cols-2 gap-3">
							<div>
								<dt className="text-meta text-ink-2">Estimated spend</dt>
								<dd className="text-xl font-semibold tabular-nums text-ink">{usd(total.estimatedUsd)}</dd>
							</div>
							<div>
								<dt className="text-meta text-ink-2">Prompt cache read rate</dt>
								<dd className="text-xl font-semibold tabular-nums text-ink">{rate(total.cacheReadRate)}</dd>
							</div>
						</dl>
						<div className="border-t border-line-soft pt-2">
							<TokenCounts usage={total} />
						</div>
					</div>
					{rows.length === 0 ? (
						<p className="text-ui text-ink-2">No {group} usage has been recorded yet.</p>
					) : (
						<SpendBars key={group} group={group} rows={rows} label={nameOf} />
					)}
					<p className="text-meta text-ink-2">
						All recorded usage. Cache read and write are prompt tokens. Spend is estimated.
					</p>
				</>
			)}
		</section>
	);
}
