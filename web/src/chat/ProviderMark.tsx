import { BotIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { backendOf } from "../../../src/core/provider-accounts.ts";

const marks = new Set([
	"amazon-bedrock",
	"anthropic",
	"azure",
	"cerebras",
	"deepseek",
	"github-copilot",
	"google",
	"google-vertex",
	"groq",
	"meta",
	"mistral",
	"openai",
	"openrouter",
	"xai",
]);

const aliases: Readonly<Record<string, string>> = {
	"azure-openai": "azure",
	bedrock: "amazon-bedrock",
	"openai-codex": "openai",
};

export function ProviderMark({ provider, className }: { provider: string; className?: string }) {
	const backend = backendOf(provider);
	const mark = aliases[backend] ?? backend;
	const size = cn("size-4 shrink-0", className);
	return marks.has(mark) ? (
		<img src={`/providers/${mark}.svg`} alt="" className={cn(size, "dark:invert")} />
	) : (
		<BotIcon aria-hidden="true" className={cn(size, "text-ink-2")} />
	);
}
