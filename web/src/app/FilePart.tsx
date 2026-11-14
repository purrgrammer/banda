/**
 * A file in a message, as the daemon drew it from its bytes (`GET …/preview`): an image inline, a PDF's first page, a
 * sheet's rows, a document's or code's first lines, audio and video playing. A tap opens it whole in a sheet (full
 * screen on the phone) with Download. A preview that cannot load says so, with Try again; the file still downloads.
 */
import { useCallback, useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
	AudioPlayer,
	CodeFile,
	DocumentFile,
	type FileMeta,
	ImageFile,
	ImageLoading,
	MESSAGE_IMAGE_WIDTH,
	PdfFile,
	PlainFile,
	SheetFile,
	VideoPlayer,
} from "../chat/Files.tsx";
import { FileViewer, type OpenFile } from "../chat/Viewer.tsx";
import {
	blobFile,
	blobPreview,
	type FilePreview,
	image,
	type Preview,
	sentFile,
	sentPreview,
	typedUrl,
} from "../lib/api.ts";
import type { SegmentFile } from "../lib/chat.ts";
import { useReturnFocus } from "../lib/return-focus.ts";
import { sizeOf } from "../lib/size.ts";

/** A language as people name it, by the highlighter's id. */
const LANGUAGE_NAMES: Record<string, string> = {
	typescript: "TypeScript",
	tsx: "TypeScript",
	javascript: "JavaScript",
	jsx: "JavaScript",
	json: "JSON",
	python: "Python",
	shellscript: "Shell script",
	go: "Go",
	rust: "Rust",
	java: "Java",
	kotlin: "Kotlin",
	swift: "Swift",
	c: "C",
	cpp: "C++",
	csharp: "C#",
	ruby: "Ruby",
	php: "PHP",
	lua: "Lua",
	r: "R",
	sql: "SQL",
	yaml: "YAML",
	toml: "TOML",
	html: "HTML",
	css: "CSS",
	xml: "XML",
	markdown: "Markdown",
	diff: "Changes",
	dockerfile: "Dockerfile",
};
export const languageName = (id: string) => LANGUAGE_NAMES[id] ?? "Code";

/** The file's bytes as a URL the page may show or play: files need the token, so an element cannot fetch one itself. */
function bytesOf(chat: number, file: SegmentFile): Promise<string> {
	return file.kind === "blob"
		? blobFile(file.sha)
		: file.kind === "sent"
			? sentFile(chat, file.call, file.n)
			: image(chat, file.item, file.n);
}

const previewOf = (chat: number, file: SegmentFile, full: boolean): Promise<FilePreview> | undefined =>
	file.kind === "blob"
		? blobPreview(file.sha, file.name, full)
		: file.kind === "sent"
			? sentPreview(chat, file.call, file.n, full)
			: undefined;

type Loaded<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed"; why: string };

/** Load once per key; `retry` loads again. */
export function useLoad<T>(
	key: string | undefined,
	load: () => Promise<T> | undefined,
): Loaded<T> & { retry: () => void } {
	const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading" });
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the key names what is loaded
	useEffect(() => {
		if (key === undefined) return;
		let gone = false;
		setLoaded({ state: "loading" });
		const pending = load();
		if (pending === undefined) return;
		pending.then(
			(value) => {
				if (!gone) setLoaded({ state: "ready", value });
			},
			(error: unknown) => {
				if (!gone) setLoaded({ state: "failed", why: error instanceof Error ? error.message : String(error) });
			},
		);
		return () => {
			gone = true;
		};
	}, [key, attempt]);
	const retry = useCallback(() => setAttempt((n) => n + 1), []);
	return { ...loaded, retry };
}

const keyOf = (chat: number, file: SegmentFile) =>
	file.kind === "blob"
		? file.sha
		: file.kind === "sent"
			? `${chat}/${file.call}/${file.n}`
			: `${chat}/${file.item}/${file.n}`;

/** A file's bytes, once loaded, as a URL of its own media type: an image shows, audio and video play. */
function useBytes(chat: number, file: SegmentFile, mimeType: string | undefined, wanted: boolean) {
	const ready = file.kind !== "sent" || file.ready;
	const key = wanted && ready ? `${keyOf(chat, file)}:${mimeType ?? ""}` : undefined;
	return useLoad(key, () =>
		bytesOf(chat, file).then((url) => (mimeType === undefined || file.image ? url : typedUrl(url, mimeType))),
	);
}

/** Save a file as the device saves a download. */
async function download(chat: number, file: SegmentFile) {
	const url = await bytesOf(chat, file);
	const link = document.createElement("a");
	link.href = url;
	link.download = file.name;
	link.click();
}

export function FilePart({ chat, file }: { chat: number; file: SegmentFile }) {
	const [open, setOpen] = useState(false);
	const ready = file.kind !== "sent" || file.ready;
	const drawn = useLoad(file.image || !ready ? undefined : keyOf(chat, file), () => previewOf(chat, file, false));
	const kind = drawn.state === "ready" ? drawn.value.preview.kind : undefined;
	const media = kind === "audio" || kind === "video";
	const bytes = useBytes(
		chat,
		file,
		drawn.state === "ready" ? drawn.value.mimeType : undefined,
		file.image || (media && drawn.state === "ready"),
	);
	if (file.image)
		return bytes.state === "ready" ? (
			<ImageFile src={bytes.value} alt={file.name} width={MESSAGE_IMAGE_WIDTH} />
		) : bytes.state === "failed" ? (
			<PlainFile file={{ name: file.name, size: "" }} kind="Image, couldn't load · Try again" onOpen={bytes.retry} />
		) : (
			<ImageLoading name={file.name} />
		);
	if (!ready || drawn.state === "loading")
		return <PlainFile file={{ name: file.name, size: "" }} kind={ready ? "Opening…" : "Sending…"} />;
	if (drawn.state === "failed")
		return (
			<PlainFile
				file={{ name: file.name, size: "" }}
				kind="No preview: couldn't reach banda · Try again"
				onOpen={drawn.retry}
			/>
		);
	const { value } = drawn;
	const meta: FileMeta = { name: file.name, size: sizeOf(value.size) };
	if (media && bytes.state === "ready")
		return kind === "audio" ? (
			<AudioPlayer file={meta} src={bytes.value} />
		) : (
			<VideoPlayer file={meta} src={bytes.value} />
		);
	return (
		<>
			<Glimpse meta={meta} preview={value.preview} onOpen={() => setOpen(true)} />
			<FileSheet
				open={open}
				onOpenChange={setOpen}
				chat={chat}
				file={file}
				size={meta.size}
				onDownload={() => void download(chat, file)}
			/>
		</>
	);
}

/** The card a preview draws. */
export function Glimpse({ meta, preview, onOpen }: { meta: FileMeta; preview: Preview; onOpen?: () => void }) {
	switch (preview.kind) {
		case "pdf":
			return <PdfFile file={meta} pages={preview.pages} title={preview.title} lines={preview.lines} onOpen={onOpen} />;
		case "sheet":
			return <SheetFile file={meta} rows={preview.rows} total={preview.total} onOpen={onOpen} />;
		case "document":
			return <DocumentFile file={meta} lines={preview.lines} onOpen={onOpen} />;
		case "text":
			return preview.language === undefined ? (
				<DocumentFile file={meta} lines={preview.lines} kind="Text" onOpen={onOpen} />
			) : (
				<CodeFile
					file={meta}
					code={preview.lines.join("\n")}
					language={languageName(preview.language)}
					highlightAs={preview.language}
					onOpen={onOpen}
				/>
			);
		case "image":
			return <PlainFile file={meta} kind="Image" {...(onOpen === undefined ? {} : { onOpen })} />;
		case "audio":
			return <PlainFile file={meta} kind="Audio" {...(onOpen === undefined ? {} : { onOpen })} />;
		case "video":
			return <PlainFile file={meta} kind="Video" {...(onOpen === undefined ? {} : { onOpen })} />;
		default:
			return <PlainFile file={meta} {...(onOpen === undefined ? {} : { onOpen })} />;
	}
}

/** What a full preview opens as. */
export function openFileOf(name: string, preview: Preview): OpenFile {
	switch (preview.kind) {
		case "pdf":
			return { kind: "pdf", name, pages: preview.pages, title: preview.title, lines: preview.lines };
		case "sheet":
			return { kind: "sheet", name, rows: preview.rows, total: preview.total };
		case "document":
			return { kind: "document", name, lines: preview.lines };
		case "text":
			return { kind: "text", name, text: preview.lines.join("\n"), language: preview.language, total: preview.total };
		default:
			return { kind: "none", name, why: "This file has no preview here. Download it to open it in your apps." };
	}
}

/** The file whole, in a sheet: the daemon's full preview, with Download. */
function FileSheet({
	open,
	onOpenChange,
	chat,
	file,
	size,
	onDownload,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	chat: number;
	file: SegmentFile;
	size: string;
	onDownload: () => void;
}) {
	// opened from state (the file's card), with no Radix trigger: closed, focus returns to the card
	const returnFocus = useReturnFocus(open);
	const whole = useLoad(open ? `${keyOf(chat, file)}:full` : undefined, () => previewOf(chat, file, true));
	const shown: OpenFile =
		whole.state === "ready"
			? openFileOf(file.name, whole.value.preview)
			: whole.state === "failed"
				? { kind: "none", name: file.name, why: "Couldn't open it: banda didn't answer.", retry: whole.retry }
				: { kind: "none", name: file.name, why: "Opening…" };
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				showCloseButton={false}
				onCloseAutoFocus={returnFocus}
				className="w-full gap-0 bg-paper p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
			>
				<SheetTitle className="sr-only">{file.name}</SheetTitle>
				<SheetDescription className="sr-only">The file, and Download</SheetDescription>
				<FileViewer file={shown} size={size} onBack={() => onOpenChange(false)} onDownload={onDownload} />
			</SheetContent>
		</Sheet>
	);
}
