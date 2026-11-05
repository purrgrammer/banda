/**
 * ai-elements Terminal, adapted to banda's palette. Shell output is ANSI-free at the box boundary already.
 * No clear action or nested auto-scroll: these are recorded facts and the transcript owns following the stream.
 */
import { TerminalIcon } from "lucide-react";
import { CodeLines, useHighlighted } from "@/chat/Files";
import { CodeBlockCopyButton } from "./code-block";

export function Terminal({
	command,
	output,
	isStreaming = false,
}: {
	command: string;
	output: string;
	isStreaming?: boolean;
}) {
	const tokens = useHighlighted(command, "bash");
	return (
		<div data-terminal="" className="min-w-0 overflow-hidden rounded-field border border-line-soft bg-paper-2">
			<div className="flex min-h-10 items-center justify-between gap-3 border-b border-line-soft px-3">
				<span className="flex items-center gap-2 text-meta text-ink-2">
					<TerminalIcon aria-hidden="true" className="size-4" />
					Terminal{isStreaming ? " · Running" : ""}
				</span>
				<CodeBlockCopyButton text={`$ ${command}\n${output}`} label="Copy terminal" />
			</div>
			<div className="flex flex-col gap-3 p-3 font-code text-meta leading-relaxed">
				<pre className="max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
					<code>
						<CodeLines code={command} tokens={tokens} />
					</code>
				</pre>
				<pre
					data-terminal-output=""
					className="max-w-full whitespace-pre-wrap break-words text-ink-2 [overflow-wrap:anywhere]"
				>
					{output}
					{isStreaming ? (
						<span aria-hidden="true" className="ml-1 inline-block h-3 w-1.5 bg-ink-2 motion-safe:animate-pulse" />
					) : null}
				</pre>
			</div>
		</div>
	);
}
