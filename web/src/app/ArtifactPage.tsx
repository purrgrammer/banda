/**
 * An artifact in the main pane, at its own address (`#/artifact/<id>`, `?v=<n>` for a version): what an agent made,
 * read whole. Text and markdown read as a document, editable on the newest version (the owner's edit is a version of
 * its own, which the agent reads as their words); an image shows; a page renders in a sandbox of its own origin, never
 * the daemon's; anything else downloads. Any older version opens read only, with Restore.
 */
import { ChevronLeftIcon, DownloadIcon, FileTextIcon, HistoryIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { WebPreview, WebPreviewBody, WebPreviewNavigation, WebPreviewUrl } from "@/components/ai-elements/web-preview";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { CodeLines, useHighlighted } from "../chat/Files.tsx";
import { PaneHeader, type PaneParent } from "../chat/Header.tsx";
import { ChatLoading } from "../chat/Loading.tsx";
import { FileBody } from "../chat/Viewer.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { type ArtifactView, api, blobFile, blobPreview, type Preview } from "../lib/api.ts";
import { boxNote, byWords, pageDocument, parseCsv, versionNote } from "../lib/artifacts.ts";
import { fileName } from "../lib/chat.ts";
import { languageOf } from "../lib/highlight.ts";
import { openFileOf } from "./FilePart.tsx";

const TEXT = new Set(["markdown", "text", "table", "page"]);
const KIND: Record<string, string> = {
	markdown: "Document",
	text: "Text",
	table: "Table",
	page: "Page",
	image: "Image",
	pdf: "PDF",
	file: "File",
};
export const kindWords = (kind: string) => KIND[kind] ?? "File";

export function ArtifactPage({
	id,
	phone,
	v,
	nameOf,
	sourceOf,
	onBack,
	onVersion,
}: {
	id: string;
	phone: boolean;
	v?: number | undefined;
	/** The name of the agent of a chat. */
	nameOf: (chat: number) => string;
	sourceOf: (chat: number) => PaneParent | undefined;
	/** Back to the chat that made it, when known. */
	onBack: (chat?: number) => void;
	onVersion: (n: number | undefined) => void;
}) {
	const [artifact, setArtifact] = useState<ArtifactView | undefined>(undefined);
	const [missing, setMissing] = useState(false);
	const [text, setText] = useState<string | undefined>(undefined);
	const [url, setUrl] = useState<string | undefined>(undefined);
	const [editing, setEditing] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	/** What the daemon drew of a version that is neither text nor an image (a PDF, a sheet, a document). */
	const [drawn, setDrawn] = useState<Preview | undefined>(undefined);
	/** Reading it failed for a reason other than its absence: said, with Try again. */
	const [unread, setUnread] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const load = () =>
		api<ArtifactView>(`/artifacts/${id}`).then(setArtifact, (failed: unknown) => {
			if (/no such|not found|404/i.test(failed instanceof Error ? failed.message : "")) setMissing(true);
			else setUnread(true);
		});
	// biome-ignore lint/correctness/useExhaustiveDependencies: read again for another artifact, or to try again
	useEffect(() => {
		setUnread(false);
		void load();
	}, [id, attempt]);
	const newest = artifact?.versions.at(-1)?.n;
	const n = v ?? newest;
	const version = artifact?.versions.find((one) => one.n === n);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` reads it again
	useEffect(() => {
		if (artifact === undefined || version === undefined) return;
		let gone = false;
		setText(undefined);
		setUrl(undefined);
		setDrawn(undefined);
		setUnread(false);
		const failed = () => !gone && setUnread(true);
		if (TEXT.has(artifact.kind))
			void api<{ text: string }>(`/artifacts/${id}/versions/${version.n}/text`).then(
				(got) => !gone && setText(got.text),
				failed,
			);
		else if (artifact.kind === "image") void blobFile(version.sha).then((made) => !gone && setUrl(made), failed);
		else
			void blobPreview(version.sha, fileName(artifact.path), true).then(
				(got) => !gone && setDrawn(got.preview),
				failed,
			);
		return () => {
			gone = true;
		};
	}, [artifact, version, id, attempt]);

	if (missing)
		return (
			<Frame title="Not found" phone={phone} onBack={() => onBack()}>
				<p className="p-6 text-ui text-ink-2">This artifact was removed, or never was.</p>
			</Frame>
		);
	const retry = (
		<div className="flex flex-col items-start gap-3 p-6">
			<p role="alert" className="text-ui text-ink-2">
				Couldn't read it: banda on this computer didn't answer.
			</p>
			<Button variant="outline" size="sm" onClick={() => setAttempt((was) => was + 1)}>
				Try again
			</Button>
		</div>
	);
	if (artifact === undefined || version === undefined)
		return (
			<Frame title="Artifact" phone={phone} onBack={() => onBack()}>
				{unread ? (
					retry
				) : (
					<div className="p-6">
						<ChatLoading />
					</div>
				)}
			</Frame>
		);
	const old = version.n !== newest;
	const name = nameOf(version.chat ?? artifact.chat);
	const by = (one: typeof version) => byWords(one, nameOf(one.chat ?? artifact.chat));
	const note = versionNote(version);
	const kept = version.by === "owner" ? boxNote(version, name) : undefined;
	const save = async (next: string) => {
		setError(undefined);
		try {
			setArtifact(
				await api<ArtifactView>(`/artifacts/${id}/versions`, {
					method: "POST",
					body: JSON.stringify({ text: next, base: newest }),
				}),
			);
			setEditing(false);
			onVersion(undefined);
		} catch (failed) {
			setError((failed as Error).message);
		}
	};
	const restore = async () => {
		setError(undefined);
		try {
			setArtifact(
				await api<ArtifactView>(`/artifacts/${id}/restore`, {
					method: "POST",
					body: JSON.stringify({ n: version.n, base: newest }),
				}),
			);
			onVersion(undefined);
		} catch (failed) {
			setError((failed as Error).message);
		}
	};
	return (
		<Frame
			title={artifact.title}
			parent={sourceOf(artifact.chat)}
			phone={phone}
			onBack={() => onBack(artifact.chat)}
			detail={`${kindWords(artifact.kind)} · version ${version.n}${old ? ` of ${newest}` : ""} · by ${by(version)}${
				note === undefined ? "" : ` · ${note}`
			}`}
			actions={
				<>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon-sm" className="text-ink-2" aria-label="Versions">
								<HistoryIcon />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-auto">
							{[...artifact.versions].reverse().map((one) => (
								<DropdownMenuItem key={one.n} onSelect={() => onVersion(one.n === newest ? undefined : one.n)}>
									<span className="w-6 tabular-nums text-ink-2">{one.n}</span>
									<span className="whitespace-nowrap">
										<span className="capitalize">{by(one)}</span>
										<span className="text-ink-2">
											{" · "}
											{new Date(one.at).toLocaleString([], {
												day: "numeric",
												month: "short",
												hour: "2-digit",
												minute: "2-digit",
											})}
										</span>
									</span>
									{one.n === n ? <span className="ml-auto pl-3 text-meta text-ink-2">Shown</span> : null}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
					<Button
						variant="ghost"
						size="icon-sm"
						className="text-ink-2"
						aria-label="Download"
						onClick={() =>
							void blobFile(version.sha).then((made) => {
								const link = document.createElement("a");
								link.href = made;
								link.download = artifact.path.split("/").at(-1) ?? "artifact";
								link.click();
							})
						}
					>
						<DownloadIcon />
					</Button>
				</>
			}
		>
			{kept === undefined ? null : (
				<p className="border-b border-line-soft bg-paper-2 px-4 py-2 text-meta text-ink-2">{kept}</p>
			)}
			{old ? (
				<div className="flex items-center gap-2 border-b border-line-soft bg-paper-2 px-4 py-2">
					<span className="flex-1 text-meta text-ink-2">An older version. The newest is {newest}.</span>
					<Button variant="ghost" size="xs" onClick={() => onVersion(undefined)}>
						Open the newest
					</Button>
					<Button size="xs" onClick={() => void restore()}>
						Restore this
					</Button>
				</div>
			) : null}
			{artifact.kind === "page" && !unread && text !== undefined ? (
				<>
					{error === undefined ? null : (
						<p role="alert" className="border-b border-line-soft px-4 py-2 text-ui text-danger">
							{error}
						</p>
					)}
					<PagePreview title={artifact.title} path={artifact.path} text={text} />
				</>
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto max-w-[44rem] px-5 py-6">
						{unread ? (
							retry
						) : TEXT.has(artifact.kind) ? (
							text === undefined ? (
								<ChatLoading />
							) : editing ? (
								<Editor text={text} onSave={(next) => void save(next)} onCancel={() => setEditing(false)} />
							) : artifact.kind === "page" ? null : artifact.kind === "table" ? (
								<Table rows={parseCsv(text)} />
							) : artifact.kind === "markdown" ? (
								<div className="banda-document text-body text-ink">
									<Markdown>{text}</Markdown>
								</div>
							) : (
								<Code text={text} path={artifact.path} />
							)
						) : artifact.kind === "image" ? (
							url === undefined ? (
								<ChatLoading />
							) : (
								<img
									src={url}
									alt={artifact.title}
									className="mx-auto max-h-[75vh] rounded-tile border border-line-soft"
								/>
							)
						) : drawn === undefined ? (
							<ChatLoading />
						) : (
							<div className="overflow-hidden rounded-tile border border-line-soft bg-paper-2">
								<FileBody file={openFileOf(artifact.title, drawn)} />
							</div>
						)}
						{error === undefined ? null : (
							<p role="alert" className="mt-4 text-ui text-danger">
								{error}
							</p>
						)}
					</div>
				</div>
			)}
			{TEXT.has(artifact.kind) && artifact.kind !== "page" && !old && !editing ? (
				<div className="mx-auto flex w-full max-w-[44rem] gap-2 border-t border-line-soft px-5 py-3">
					<Button variant="outline" size="sm" onClick={() => setEditing(true)}>
						Edit
					</Button>
					<span className="self-center text-meta text-ink-2">
						Your edit is a version of its own; {name} reads it as yours.
					</span>
				</div>
			) : null}
		</Frame>
	);
}

/**
 * A page, the whole pane: ai-elements' web-preview, its bar naming the file (never a location the frame loads), and
 * full screen on request. The frame is the component's: sandboxed, its own policy first, never the daemon's origin.
 */
function PagePreview({ title, path, text }: { title: string; path: string; text: string }) {
	const [whole, setWhole] = useState(false);
	const shown = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const changed = () => setWhole(document.fullscreenElement === shown.current && shown.current !== null);
		document.addEventListener("fullscreenchange", changed);
		return () => document.removeEventListener("fullscreenchange", changed);
	}, []);
	const toggle = () => {
		if (document.fullscreenElement !== null) void document.exitFullscreen();
		else void shown.current?.requestFullscreen?.();
	};
	return (
		<WebPreview ref={shown} url={path.split("/").at(-1) ?? path} className="min-h-0 flex-1 bg-paper">
			<WebPreviewNavigation className="border-line-soft">
				<WebPreviewUrl className="bg-paper-2 text-ink-2" />
				{document.fullscreenEnabled ? (
					<Button
						variant="ghost"
						size="icon-sm"
						className="text-ink-2"
						aria-label={whole ? "Leave full screen" : "Full screen"}
						onClick={toggle}
					>
						{whole ? <Minimize2Icon /> : <Maximize2Icon />}
					</Button>
				) : null}
			</WebPreviewNavigation>
			<WebPreviewBody title={title} document={pageDocument(text)} />
		</WebPreview>
	);
}

/** A text artifact: code coloured by its file's language, prose as it is. */
function Code({ text, path }: { text: string; path: string }) {
	const language = languageOf(path.split(".").at(-1));
	const tokens = useHighlighted(text, language);
	return (
		<pre className="m-0 font-code text-ui break-words whitespace-pre-wrap text-ink">
			<CodeLines code={text} tokens={tokens} />
		</pre>
	);
}

function Table({ rows }: { rows: string[][] }) {
	const [head = [], ...body] = rows;
	// a column of numbers reads right-aligned
	const numeric = head.map((_, i) => body.length > 0 && body.every((row) => /^-?[\d.,\s%]*$/.test(row[i] ?? "")));
	return (
		<div className="overflow-x-auto rounded-tile border border-line-soft">
			<table className="w-full border-collapse text-ui">
				<thead className="bg-paper-2 text-left">
					<tr>
						{head.map((cell, i) => (
							<th
								// biome-ignore lint/suspicious/noArrayIndexKey: a cell is its place
								key={i}
								className={`border-b border-line-soft px-3 py-2 font-semibold text-ink ${numeric[i] ? "text-right" : ""}`}
							>
								{cell}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{body.map((row, r) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a row is its place
						<tr key={r} className="border-b border-line-soft last:border-0">
							{row.map((cell, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: a column is its place
								<td key={i} className={`px-3 py-2 align-top text-ink ${numeric[i] ? "text-right tabular-nums" : ""}`}>
									{cell}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Editor({ text, onSave, onCancel }: { text: string; onSave: (text: string) => void; onCancel: () => void }) {
	const [value, setValue] = useState(text);
	return (
		<div className="flex flex-col gap-3">
			<Textarea
				value={value}
				autoFocus
				onFocus={(event) => event.currentTarget.setSelectionRange(value.length, value.length)}
				onChange={(event) => setValue(event.target.value)}
				className="min-h-[50vh] text-body"
				aria-label="The text"
			/>
			<span className="flex gap-2">
				<Button size="sm" disabled={value === text} onClick={() => onSave(value)}>
					Save
				</Button>
				<Button variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
			</span>
		</div>
	);
}

function Frame({
	title,
	parent,
	phone,
	detail,
	actions,
	onBack,
	children,
}: {
	title: string;
	parent?: PaneParent | undefined;
	phone: boolean;
	detail?: string;
	actions?: React.ReactNode;
	onBack: () => void;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-1 flex-col bg-paper">
			<PaneHeader
				title={title}
				parent={parent}
				icon={<FileTextIcon />}
				phone={phone}
				detail={detail === undefined ? null : <p className="truncate text-meta text-ink-2">{detail}</p>}
				trailing={actions}
				navigation={
					<Button variant="ghost" size="icon-sm" aria-label="Back to the chat" className="text-ink-2" onClick={onBack}>
						<ChevronLeftIcon className="size-5" />
					</Button>
				}
			/>
			{children}
		</div>
	);
}
