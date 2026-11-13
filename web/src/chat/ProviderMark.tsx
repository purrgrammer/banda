/**
 * A provider's mark: its own where banda ships one (`/providers/<mark>.svg`, monochrome, inverted in dark mode), a server
 * kind's for a server of the owner's (Ollama, LM Studio, vLLM), and a plain glyph otherwise.
 */
import { BotIcon, ServerIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { isCustomProvider, type ServerKind } from "../../../src/core/custom-providers.ts";
import { backendOf } from "../../../src/core/provider-accounts.ts";

const marks = new Set([
	"amazon-bedrock",
	"anthropic",
	"azure",
	"baseten",
	"cerebras",
	"cloudflare",
	"deepseek",
	"fireworks",
	"github-copilot",
	"google",
	"google-vertex",
	"groq",
	"huggingface",
	"kimi",
	"meta",
	"minimax",
	"mistral",
	"moonshot",
	"nvidia",
	"openai",
	"opencode",
	"openrouter",
	"qwen",
	"together",
	"vercel",
	"xai",
	"xiaomi",
	"zai",
]);

const aliases: Readonly<Record<string, string>> = {
	"azure-openai": "azure",
	bedrock: "amazon-bedrock",
	"cloudflare-ai-gateway": "cloudflare",
	"cloudflare-workers-ai": "cloudflare",
	"kimi-coding": "kimi",
	"minimax-cn": "minimax",
	moonshotai: "moonshot",
	"moonshotai-cn": "moonshot",
	"openai-codex": "openai",
	"opencode-go": "opencode",
	"vercel-ai-gateway": "vercel",
	"zai-coding-cn": "zai",
};

/** The mark of a provider id that names a family of plans (`qwen-token-plan-cn`, `xiaomi-token-plan-sgp`). */
const family = (id: string) => /^(qwen|xiaomi)-/.exec(id)?.[1];

/** Each of the owner's servers' kind, by its id, as the app last read them: a server's mark wherever its id shows. */
const kinds = new Map<string, ServerKind>();
const listeners = new Set<() => void>();
let version = 0;
export function knowServerKinds(servers: readonly { readonly id: string; readonly kind: ServerKind }[]) {
	let changed = false;
	for (const { id, kind } of servers)
		if (kinds.get(id) !== kind) {
			kinds.set(id, kind);
			changed = true;
		}
	if (!changed) return;
	version++;
	for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
const snapshot = () => version;

/** The server kinds with a mark of their own; the others are a server. */
const serverMarks: ReadonlySet<ServerKind> = new Set(["ollama", "lmstudio", "vllm"]);

function Mark({ mark, className }: { mark: string | undefined; className: string }) {
	return mark === undefined ? (
		<BotIcon aria-hidden="true" className={cn(className, "text-ink-2")} />
	) : (
		<img src={`/providers/${mark}.svg`} alt="" className={cn(className, "dark:invert")} />
	);
}

export function ProviderMark({
	provider,
	kind,
	className,
}: {
	provider: string;
	/** A server of the owner's: its kind decides its mark. */
	kind?: ServerKind | undefined;
	className?: string;
}) {
	useSyncExternalStore(subscribe, snapshot, snapshot);
	const size = cn("size-4 shrink-0", className);
	const backend = backendOf(provider);
	const server = kind ?? kinds.get(backend);
	if (server !== undefined || isCustomProvider(backend))
		return server !== undefined && serverMarks.has(server) ? (
			<Mark mark={server} className={size} />
		) : (
			<ServerIcon aria-hidden="true" className={cn(size, "text-ink-2")} />
		);
	const mark = aliases[backend] ?? family(backend) ?? backend;
	return <Mark mark={marks.has(mark) ? mark : undefined} className={size} />;
}

/** A server kind's mark, as the lists of kinds show it. */
export function ServerMark({ kind, className }: { kind: ServerKind; className?: string }) {
	return <ProviderMark provider={`custom-${kind}`} kind={kind} {...(className === undefined ? {} : { className })} />;
}
