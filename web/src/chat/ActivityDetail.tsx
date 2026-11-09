import { FileTextIcon, WrenchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CodeBlock } from "../components/ai-elements/code-block.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible.tsx";
import type { ChatPrompt } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { shortPreview, ToolIcon } from "./tool-presentation.tsx";

export function ModelContext({ prompt }: { prompt: ChatPrompt }) {
	return (
		<>
			<RawRow title="System prompt" icon={<FileTextIcon className="size-4" />}>
				<p className="whitespace-pre-wrap text-ui leading-relaxed text-ink-2">{prompt.system}</p>
			</RawRow>
			<section aria-label="Tools" className="flex min-w-0 flex-col gap-2">
				<RawRow title="Tools" icon={<WrenchIcon className="size-4" />} state={String(prompt.tools.length)}>
					{prompt.tools.map((tool) => (
						<RawRow
							key={tool.name}
							title={tool.name}
							icon={<ToolIcon name={tool.name} />}
							summary={shortPreview(tool.description)}
						>
							<p className="whitespace-pre-wrap text-ui text-ink-2">{tool.description}</p>
							<RawValue label="Parameters">{JSON.stringify(tool.parameters)}</RawValue>
						</RawRow>
					))}
				</RawRow>
			</section>
		</>
	);
}

/** Borderless expandable rows, shared by live activity and its specimen. */
export function RawRow({
	title,
	icon,
	summary,
	state,
	defaultOpen = false,
	children,
}: {
	title: string;
	icon: ReactNode;
	summary?: string | undefined;
	state?: string;
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	return (
		<Collapsible defaultOpen={defaultOpen} className="flex min-w-0 flex-col gap-3">
			<CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-field text-left text-ui hover:bg-paper-2">
				<span className="shrink-0 text-ink-2">{icon}</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
					<span data-raw-title="" className="truncate font-medium">
						{title}
					</span>
					{summary ? (
						<span
							data-tool-preview=""
							className="line-clamp-2 break-words text-meta text-ink-2 [overflow-wrap:anywhere]"
						>
							{summary}
						</span>
					) : null}
				</span>
				{state ? (
					<span className={cn("shrink-0 text-meta", state === "Failed" ? "text-danger" : "text-ink-2")}>{state}</span>
				) : null}
			</CollapsibleTrigger>
			<CollapsibleContent className="ml-6 flex min-w-0 flex-col gap-3">{children}</CollapsibleContent>
		</Collapsible>
	);
}

export function RawValue({ label, children }: { label: string; children: string }) {
	let code = children;
	let language: string | undefined;
	try {
		code = JSON.stringify(JSON.parse(children), null, 2);
		language = "json";
	} catch {
		/* Incomplete streamed JSON stays verbatim. */
	}
	return <CodeBlock title={label} code={code} language={language} />;
}
