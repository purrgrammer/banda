/**
 * What opens in the panel (full screen on the phone): a file read in full (a PDF's first page and its count, an image
 * zoomed, text and code readable and coloured, a sheet as a table) and an artifact with its versions (a routine's
 * editor is `RoutineEditor.tsx`). Each replaces the panel's sections under a bar that leads back.
 */

import { DownloadIcon, HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";
import { Markdown } from "../components/Markdown.tsx";
import { CodeLines, ImageFile, useHighlighted } from "./Files.tsx";
import { PanelBar } from "./Panel.tsx";

export type OpenFile =
	| {
			readonly kind: "pdf";
			readonly name: string;
			readonly pages: number;
			readonly title?: string | undefined;
			/** The first page's words, as the daemon read them. */
			readonly lines: readonly string[];
	  }
	| { readonly kind: "image"; readonly name: string; readonly src: string }
	| {
			readonly kind: "text";
			readonly name: string;
			readonly text: string;
			/** Code, in the language the highlighter names ("python"); prose has none. */
			readonly language?: string | undefined;
			/** How many lines the file has, when more than shown. */
			readonly total?: number | undefined;
	  }
	| { readonly kind: "document"; readonly name: string; readonly lines: readonly string[] }
	| {
			readonly kind: "sheet";
			readonly name: string;
			readonly rows: readonly (readonly string[])[];
			/** Every row it has, its header included, when more than shown. */
			readonly total?: number | undefined;
	  }
	/** Nothing to show of it (or not yet): its card says so. */
	| { readonly kind: "none"; readonly name: string; readonly why: string; readonly retry?: (() => void) | undefined };

/** A file read in full, with Download, which opens it in the device's own apps. */
export function FileViewer({
	file,
	size,
	onBack,
	onDownload,
}: {
	file: OpenFile;
	size: string;
	onBack?: () => void;
	onDownload?: () => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelBar
				title={file.name}
				detail={size}
				{...(onBack === undefined ? {} : { onBack })}
				actions={
					<Button
						variant="ghost"
						size="icon-sm"
						className="text-ink-2"
						aria-label={`Download ${file.name}`}
						onClick={onDownload}
					>
						<DownloadIcon />
					</Button>
				}
			/>
			<div className="min-h-0 flex-1 overflow-auto bg-paper-2">
				<FileBody file={file} />
			</div>
		</div>
	);
}

/** A file's content, read whole: the viewer's body, and an artifact's that is not text. */
export function FileBody({ file }: { file: OpenFile }) {
	if (file.kind === "pdf") return <PdfPage file={file} />;
	if (file.kind === "image")
		return (
			<div className="flex justify-center p-4">
				<ImageFile src={file.src} alt={file.name} width={640} />
			</div>
		);
	if (file.kind === "text") return <TextBody file={file} />;
	if (file.kind === "document")
		return (
			<div className="flex flex-col gap-3 bg-paper p-4 text-body break-words text-ink">
				{file.lines.map((line, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a paragraph's place
					<p key={i}>{line}</p>
				))}
			</div>
		);
	if (file.kind === "sheet")
		return (
			<div className="overflow-x-auto">
				<SheetTable rows={file.rows} />
				{file.total !== undefined && file.total > file.rows.length ? (
					<More shown={file.rows.length - 1} total={file.total - 1} what="rows" />
				) : null}
			</div>
		);
	return (
		<div className="flex flex-col items-start gap-3 p-6">
			<p className="text-ui text-ink-2">{file.why}</p>
			{file.retry === undefined ? null : (
				<Button variant="outline" size="sm" onClick={file.retry}>
					Try again
				</Button>
			)}
		</div>
	);
}

/** What is not shown, and where the rest is. */
function More({ shown, total, what }: { shown: number; total?: number | undefined; what: string }) {
	if (total === undefined || total <= shown) return null;
	return (
		<p className="px-4 py-3 text-meta text-ink-2">
			The first {shown.toLocaleString()} of {total.toLocaleString()} {what}. Download the file for all of it.
		</p>
	);
}

function TextBody({ file }: { file: Extract<OpenFile, { kind: "text" }> }) {
	const tokens = useHighlighted(file.text, file.language === "markdown" ? undefined : file.language);
	const shown = file.text.split("\n").length;
	// a markdown file reads as the document it is, as an artifact does; its source is the download
	if (file.language === "markdown")
		return (
			<>
				<div className="banda-document bg-paper p-4 text-body text-ink">
					<Markdown>{file.text}</Markdown>
				</div>
				<More shown={shown} total={file.total} what="lines" />
			</>
		);
	return (
		<>
			<pre
				className={cn(
					"m-0 bg-paper p-4 break-words whitespace-pre-wrap text-ink",
					file.language === undefined ? "font-text text-body" : "font-code text-meta leading-[1.2rem]",
				)}
			>
				<CodeLines code={file.text} tokens={tokens} />
			</pre>
			<More shown={shown} total={file.total} what="lines" />
		</>
	);
}

/** A PDF's first page: its words as the daemon read them, on a page, and how many pages there are. */
function PdfPage({ file }: { file: Extract<OpenFile, { kind: "pdf" }> }) {
	return (
		<div className="flex flex-col items-center gap-3 p-4">
			<div
				role="document"
				aria-label="Page 1"
				className="flex aspect-[1/1.414] w-full flex-col gap-1 overflow-hidden rounded-[4px] bg-[oklch(1_0_0)] p-[8%] text-[oklch(0.25_0_0)] shadow-[0_0_0_1px_var(--line-soft),0_2px_8px_oklch(0_0_0/8%)]"
			>
				{file.title === undefined ? null : (
					<p className="mb-2 text-ui font-semibold break-words text-[oklch(0.2_0_0)]">{file.title}</p>
				)}
				{file.lines.length === 0 ? (
					<p className="text-meta text-[oklch(0.45_0_0)]">
						This page has no words banda can read: a scan, or a drawing. Download it to see it.
					</p>
				) : (
					file.lines.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a page's lines, by position
						<p key={i} className="text-meta leading-snug break-words">
							{line}
						</p>
					))
				)}
			</div>
			<p className="text-meta text-ink-2 tabular-nums">
				{file.pages <= 1 ? "1 page" : `Page 1 of ${file.pages}. Download it to read every page.`}
			</p>
		</div>
	);
}

function SheetTable({ rows }: { rows: readonly (readonly string[])[] }) {
	const [head, ...body] = rows;
	return (
		<table className="w-full border-collapse bg-paper text-meta">
			<thead>
				<tr>
					{head?.map((cell, i) => (
						<th
							// biome-ignore lint/suspicious/noArrayIndexKey: a header's place is its column
							key={i}
							className="sticky top-0 border-b border-line bg-paper-2 px-3 py-2 text-left font-semibold whitespace-nowrap text-ink"
						>
							{cell}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{body.map((row, r) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a row's place is its number
					<tr key={r} className="border-b border-line-soft">
						{row.map((cell, i) => (
							<td
								// biome-ignore lint/suspicious/noArrayIndexKey: a cell's place is its column
								key={i}
								className="max-w-[20rem] truncate px-3 py-2 whitespace-nowrap text-ink tabular-nums"
							>
								{cell}
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}

export type Version = { readonly n: number; readonly when: string; readonly by: string };

/**
 * An artifact: the newest version, editable by the owner, or an older one read only, with Restore. Its versions are
 * one list; any can be restored byte for byte.
 */
export function ArtifactViewer({
	agent,
	title,
	versions,
	showing,
	editing = false,
	body,
}: {
	agent: string;
	title: string;
	versions: readonly Version[];
	/** The version on screen. */
	showing: number;
	editing?: boolean;
	body: string;
}) {
	const newest = versions[0]?.n ?? showing;
	const old = showing !== newest;
	const version = versions.find((one) => one.n === showing);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelBar
				title={title}
				detail={version === undefined ? undefined : `Version ${version.n} · ${version.by}, ${version.when}`}
				actions={
					<Button variant="ghost" size="icon-sm" className="text-ink-2" aria-label="Versions">
						<HistoryIcon />
					</Button>
				}
			/>
			{old ? (
				<div className="flex items-center gap-2 border-b border-line-soft bg-paper-2 px-4 py-2">
					<span className="flex-1 text-meta text-ink-2">An older version. The newest is {newest}.</span>
					<Button size="xs">Restore this</Button>
				</div>
			) : null}
			<div className="min-h-0 flex-1 overflow-auto p-4">
				{editing ? (
					<Textarea defaultValue={body} aria-label={title} className="min-h-full text-body" />
				) : (
					<div className="text-body whitespace-pre-line text-ink">{body}</div>
				)}
			</div>
			<div className="flex items-center gap-2 border-t border-line-soft px-4 py-3">
				{editing ? (
					<>
						<Button size="sm">Save</Button>
						<Button variant="ghost" size="sm">
							Cancel
						</Button>
						<span className="ml-auto text-meta text-ink-2">{agent} reads your changes as your words</span>
					</>
				) : old ? (
					<Button variant="outline" size="sm">
						Back to the newest
					</Button>
				) : (
					<Button variant="outline" size="sm">
						Edit
					</Button>
				)}
			</div>
		</div>
	);
}

/** The versions of an artifact, newest first: who made each and when. */
export function Versions({ versions, showing }: { versions: readonly Version[]; showing: number }) {
	return (
		<ul className="flex flex-col">
			{versions.map((version) => (
				<li key={version.n}>
					<button
						type="button"
						aria-current={version.n === showing}
						className={cn(
							"flex w-full items-center gap-3 rounded-field px-3 py-2 text-left hover:bg-paper-3",
							version.n === showing && "bg-paper-3",
						)}
					>
						<span className="w-6 text-meta tabular-nums text-ink-2">{version.n}</span>
						<span className="flex flex-1 flex-col">
							<span className="text-ui text-ink">{version.by}</span>
							<span className="text-meta text-ink-2">{version.when}</span>
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}
