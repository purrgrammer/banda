/** ai-elements CodeBlock, adapted to banda's shared Shiki highlighter, palette and wrapping phone layout. */
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { CodeLines, useHighlighted } from "@/chat/Files";
import { Button } from "@/components/ui/button";

export function CodeBlock({ code, language, title }: { code: string; language?: string | undefined; title: string }) {
	const tokens = useHighlighted(code, language);
	return (
		<div
			data-code-block={language ?? "text"}
			className="min-w-0 overflow-hidden rounded-field border border-line-soft bg-paper-2"
		>
			<div className="flex min-h-10 items-center justify-between gap-3 border-b border-line-soft px-3">
				<span className="text-meta text-ink-2">
					{title}
					{language ? ` · ${language}` : ""}
				</span>
				<CodeBlockCopyButton text={code} label={`Copy ${title.toLowerCase()}`} />
			</div>
			<pre className="max-w-full whitespace-pre-wrap break-words p-3 font-code text-meta leading-relaxed [overflow-wrap:anywhere]">
				<code>
					<CodeLines code={code} tokens={tokens} />
				</code>
			</pre>
		</div>
	);
}

export function CodeBlockCopyButton({ text, label }: { text: string; label: string }) {
	const [status, setStatus] = useState<"copied" | "failed" | undefined>(undefined);
	useEffect(() => {
		if (!status) return;
		const timer = setTimeout(() => setStatus(undefined), 1500);
		return () => clearTimeout(timer);
	}, [status]);
	return (
		<span className="flex items-center gap-1">
			<span role="status" className="text-meta text-ink-2">
				{status === "failed" ? "Couldn’t copy" : status === "copied" ? "Copied" : ""}
			</span>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={label}
				title={label}
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(text);
						setStatus("copied");
					} catch {
						setStatus("failed");
					}
				}}
			>
				{status === "copied" ? <CheckIcon /> : <CopyIcon />}
			</Button>
		</span>
	);
}
