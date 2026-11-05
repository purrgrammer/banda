/**
 * Files an approval would write, as a reviewer reads them: how many and how many lines, a tree of their folders, and the
 * picked file whole, coloured, every line marked as one it adds. The bytes are the arguments the agent asked with,
 * shown as text; nothing here runs them.
 */
import { ChevronRightIcon, FileIcon, FolderIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/cn";
import { type FileChange, type FileTree, fileTree } from "@/lib/file-changes";
import { languageOf } from "@/lib/highlight";
import { useHighlighted } from "./Files.tsx";

const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;

function Added({ lines, className }: { lines: number; className?: string }) {
	return (
		<span className={cn("font-code text-meta text-sa-add tabular-nums", className)}>+{lines.toLocaleString()}</span>
	);
}

export function FileChanges({ files }: { files: readonly FileChange[] }) {
	const tree = useMemo(() => fileTree(files), [files]);
	const [picked, setPicked] = useState(files[0]?.path);
	const shown = files.find((file) => file.path === picked) ?? files[0];
	const total = files.reduce((sum, file) => sum + file.lines, 0);
	if (shown === undefined) return null;
	return (
		<section
			aria-label="Files"
			className="flex flex-col overflow-hidden rounded-tile border border-line-soft bg-paper text-ui"
		>
			<header className="flex items-center gap-2 border-b border-line-soft bg-paper-2 px-3 py-2">
				<span className="font-medium text-ink">{plural(files.length, "file")}</span>
				<Added lines={total} />
				<span className="text-meta text-ink-2">{total === 1 ? "line" : "lines"}</span>
			</header>
			<div className="grid min-h-0 grid-cols-1 sm:grid-cols-[minmax(10rem,14rem)_1fr]">
				<nav
					aria-label="File tree"
					className="max-h-48 overflow-y-auto border-b border-line-soft py-1 sm:max-h-[26rem] sm:border-r sm:border-b-0"
				>
					<Folder node={tree} depth={0} picked={shown.path} onPick={setPicked} />
				</nav>
				<FileContent file={shown} />
			</div>
		</section>
	);
}

function Folder({
	node,
	depth,
	picked,
	onPick,
}: {
	node: FileTree;
	depth: number;
	picked: string;
	onPick: (path: string) => void;
}) {
	const pad = { paddingLeft: `${0.75 + depth * 0.875}rem` };
	return (
		<>
			{node.dirs.map((dir) => (
				<Collapsible key={dir.name} defaultOpen>
					<CollapsibleTrigger
						className="group flex w-full items-center gap-1.5 py-1 pr-3 text-left text-ink-2 hover:bg-paper-2"
						style={pad}
					>
						<ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
						<FolderIcon className="size-3.5 shrink-0" />
						<span className="truncate">{dir.name}</span>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<Folder node={dir} depth={depth + 1} picked={picked} onPick={onPick} />
					</CollapsibleContent>
				</Collapsible>
			))}
			{node.files.map((file) => (
				<button
					key={file.path}
					type="button"
					aria-current={file.path === picked ? "true" : undefined}
					onClick={() => onPick(file.path)}
					title={file.path}
					className={cn(
						"flex w-full items-center gap-1.5 py-1 pr-3 text-left text-ink hover:bg-paper-2",
						file.path === picked && "bg-paper-2 font-medium",
					)}
					style={{ paddingLeft: `calc(${pad.paddingLeft} + 1.25rem)` }}
				>
					<FileIcon className="size-3.5 shrink-0 text-ink-2" />
					<span className="min-w-0 flex-1 truncate">{file.name}</span>
					<Added lines={file.lines} />
				</button>
			))}
		</>
	);
}

/** Bounded like the highlighter: a reviewer reads the first lines of a huge file here, never a frozen page. */
const MOST_LINES = 2000;

function FileContent({ file }: { file: FileChange }) {
	const text = useMemo(() => {
		const lines = file.content.split("\n");
		if (file.content.endsWith("\n")) lines.pop();
		return lines.slice(0, MOST_LINES);
	}, [file.content]);
	const tokens = useHighlighted(text.join("\n"), languageOf(file.path.split(".").at(-1)));
	return (
		<div className="flex min-w-0 flex-col">
			<div className="flex items-center gap-2 border-b border-line-soft px-3 py-1.5">
				<span className="min-w-0 flex-1 truncate font-code text-meta text-ink-2" title={file.path}>
					{file.path}
				</span>
				<Added lines={file.lines} />
			</div>
			{file.content === "" ? (
				<p className="px-3 py-3 text-meta text-ink-2">An empty file.</p>
			) : (
				<div className="max-h-[26rem] overflow-auto">
					<pre className="m-0 w-max min-w-full py-1 font-code text-meta leading-[1.15rem] text-ink">
						{text.map((line, n) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a line's place is its number
							<span key={n} className="flex bg-sa-add/8">
								<span className="sticky left-0 w-[3.25rem] shrink-0 bg-paper pr-2 text-right text-ink-2 select-none tabular-nums">
									{n + 1}
								</span>
								<span className="w-4 shrink-0 text-sa-add select-none">+</span>
								<span className="pr-3 whitespace-pre">
									{tokens?.[n] === undefined
										? line
										: tokens[n].map((token, t) => (
												<span
													// biome-ignore lint/suspicious/noArrayIndexKey: a token's place in its line
													key={t}
													style={token.color === undefined ? undefined : { color: token.color }}
													className={token.italic === true ? "italic" : undefined}
												>
													{token.content}
												</span>
											))}
								</span>
							</span>
						))}
					</pre>
					{file.lines > MOST_LINES ? (
						<p className="border-t border-line-soft px-3 py-2 text-meta text-ink-2">
							The first {MOST_LINES.toLocaleString()} of {file.lines.toLocaleString()} lines.
						</p>
					) : null}
				</div>
			)}
		</div>
	);
}
