/**
 * Files, rich wherever they appear: sent by the owner or made by an agent. An image shows inline and zooms; a PDF its
 * first page and its page count; a document, a sheet or code a glimpse of what is in it (code coloured); audio and
 * video play. A tap opens the file whole. The glimpses are the daemon's, drawn from the bytes (`src/core/preview.ts`),
 * never code the box wrote; here they are only text.
 */
import { FileIcon, FileTextIcon, PauseIcon, PlayIcon, SheetIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import Zoom from "react-medium-image-zoom";
import "react-medium-image-zoom/dist/styles.css";
import { cn } from "@/lib/cn";
import { highlight, type Token } from "@/lib/highlight";

export type FileMeta = { readonly name: string; readonly size: string };

/** The card every file shares: what it shows, then its name and what it is; a tap opens it. */
function Card({
	children,
	file,
	detail,
	icon,
	className,
	onOpen,
}: {
	children?: ReactNode;
	file: FileMeta;
	detail?: string | undefined;
	icon: ReactNode;
	className?: string;
	onOpen?: (() => void) | undefined;
}) {
	return (
		<button
			type="button"
			aria-label={`Open ${file.name}`}
			onClick={onOpen}
			className={cn(
				"flex w-72 max-w-full flex-col overflow-hidden rounded-tile border border-line-soft bg-paper text-left",
				"transition-colors duration-[var(--duration-fast)] hover:border-line",
				className,
			)}
		>
			{children}
			<span className="flex w-full items-center gap-2.5 px-3 py-2.5">
				<span className="text-ink-2 [&_svg]:size-4">{icon}</span>
				<span className="flex min-w-0 flex-col">
					<span className="truncate text-ui font-medium text-ink">{file.name}</span>
					<span className="truncate text-meta text-ink-2">{[detail, file.size].filter(Boolean).join(" · ")}</span>
				</span>
			</span>
		</button>
	);
}

/** Code's lines coloured, once its language loads; undefined until then, or when it is not one coloured. */
export function useHighlighted(code: string, language: string | undefined): Token[][] | undefined {
	const [tokens, setTokens] = useState<Token[][] | undefined>(undefined);
	useEffect(() => {
		let gone = false;
		setTokens(undefined);
		void highlight(code, language).then(
			(lines) => {
				if (!gone) setTokens(lines);
			},
			() => {},
		);
		return () => {
			gone = true;
		};
	}, [code, language]);
	return tokens;
}

/** Lines of code: coloured tokens when there are some, else the text as it is. */
export function CodeLines({ code, tokens }: { code: string; tokens?: Token[][] | undefined }) {
	if (tokens === undefined) return <>{code}</>;
	return (
		<>
			{tokens.map((line, l) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a line's place is its number
				<span key={l} className="block min-h-[1lh]">
					{line.map((token, t) => (
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
			))}
		</>
	);
}

/** How wide an image shows in a message, at most: an attached one, and an artifact that is an image. */
export const MESSAGE_IMAGE_WIDTH = 280;

export function ImageFile({
	src,
	alt,
	width = 320,
	onOpen,
}: {
	src: string;
	alt: string;
	width?: number;
	/** A tap opens it somewhere of its own (an artifact, in its pane) in place of the zoom. */
	onOpen?: (() => void) | undefined;
}) {
	const image = <img src={src} alt={alt} className="block h-auto w-full" />;
	return (
		<span className="inline-block max-w-full overflow-hidden rounded-tile border border-line-soft" style={{ width }}>
			{onOpen === undefined ? (
				<Zoom zoomMargin={40} wrapElement="span" a11yNameButtonZoom={`Open ${alt}`} a11yNameButtonUnzoom="Close">
					{image}
				</Zoom>
			) : (
				<button type="button" aria-label={`Open ${alt}`} onClick={onOpen} className="block w-full cursor-pointer">
					{image}
				</button>
			)}
		</span>
	);
}

/** An image whose bytes are on their way: the room it will take. */
export function ImageLoading({ name }: { name: string }) {
	return (
		<span
			role="img"
			aria-label={`${name}, loading`}
			className="block h-40 w-60 max-w-full animate-pulse rounded-tile bg-paper-3 motion-reduce:animate-none"
		/>
	);
}

/**
 * A PDF: its first page (its words, as the daemon read them, on a page) and how many there are. A page with no words
 * to read (a scan, fonts the daemon cannot decode) is drawn as lines, under its title when it has one.
 */
export function PdfFile({
	file,
	pages,
	title,
	lines = [],
	onOpen,
}: {
	file: FileMeta;
	pages: number;
	title?: string | undefined;
	lines?: readonly string[];
	onOpen?: (() => void) | undefined;
}) {
	const detail = pages === 0 ? "PDF" : `PDF, ${pages === 1 ? "1 page" : `${pages} pages`}`;
	return (
		<Card file={file} detail={detail} icon={<FileTextIcon />} onOpen={onOpen}>
			<span className="flex h-40 w-full items-end justify-center overflow-hidden border-b border-line-soft bg-paper-2 px-8 pt-5">
				<span
					aria-hidden="true"
					className="flex h-full w-full flex-col gap-1 overflow-hidden rounded-t-[4px] bg-white px-4 pt-4 shadow-[0_0_0_1px_oklch(0_0_0/8%)]"
				>
					{title === undefined ? null : (
						<span className="line-clamp-2 shrink-0 text-[9px] leading-tight font-semibold break-words text-neutral-900">
							{title}
						</span>
					)}
					{lines.length > 0
						? lines.slice(0, 12).map((line, i) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: a page's lines, by position
									key={i}
									className="shrink-0 truncate text-[7px] leading-[9px] text-neutral-700"
								>
									{line}
								</span>
							))
						: [100, 92, 96, 70, 0, 94, 88, 97, 60].map((w, i) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: a drawing of lines, by position
									key={i}
									className={w === 0 ? "h-1 shrink-0" : "h-[3px] shrink-0 rounded-full bg-neutral-300"}
									style={{ width: `${w}%` }}
								/>
							))}
				</span>
			</span>
		</Card>
	);
}

/** A document or a text file: its first lines. */
export function DocumentFile({
	file,
	lines,
	kind = "Document",
	onOpen,
}: {
	file: FileMeta;
	lines: readonly string[];
	kind?: string;
	icon?: ReactNode;
	onOpen?: (() => void) | undefined;
}) {
	return (
		<Card file={file} detail={kind} icon={<FileTextIcon />} onOpen={onOpen}>
			{lines.length === 0 ? null : (
				<span className="flex w-full flex-col gap-1 border-b border-line-soft bg-paper-2 px-3.5 py-3 text-meta text-ink-2">
					{lines.slice(0, 4).map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the same line may come twice
						<span key={i} className="line-clamp-1 break-all">
							{line}
						</span>
					))}
				</span>
			)}
		</Card>
	);
}

/** A sheet: its first rows, as a table, and how many it has. */
export function SheetFile({
	file,
	rows,
	total = rows.length,
	onOpen,
}: {
	file: FileMeta;
	rows: readonly (readonly string[])[];
	/** Every row it has, its header included. */
	total?: number;
	onOpen?: (() => void) | undefined;
}) {
	const [head, ...body] = rows;
	const count = Math.max(0, total - 1);
	return (
		<Card
			file={file}
			detail={`Sheet, ${count === 1 ? "1 row" : `${count.toLocaleString()} rows`}`}
			icon={<SheetIcon />}
			onOpen={onOpen}
		>
			<span className="block w-full overflow-hidden border-b border-line-soft bg-paper-2 px-2 py-2">
				<table className="w-full table-fixed border-collapse text-meta">
					<thead>
						<tr>
							{head?.slice(0, 4).map((cell, i) => (
								<th
									// biome-ignore lint/suspicious/noArrayIndexKey: a header's place is its column
									key={i}
									className="truncate border-b border-line-soft px-1.5 py-1 text-left font-medium text-ink-2"
								>
									{cell}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{body.slice(0, 3).map((row, r) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a row's place is its number
							<tr key={r}>
								{row.slice(0, 4).map((cell, i) => (
									<td
										// biome-ignore lint/suspicious/noArrayIndexKey: cells of a row, by column
										key={i}
										className="truncate px-1.5 py-1 text-ink tabular-nums"
									>
										{cell}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</span>
		</Card>
	);
}

/** Code: its first lines, in the machines' type, coloured. */
export function CodeFile({
	file,
	code,
	language,
	highlightAs,
	onOpen,
}: {
	file: FileMeta;
	code: string;
	/** Its language, as people name it ("Python"). */
	language: string;
	/** Its language, as the highlighter names it ("python"); by default `language`. */
	highlightAs?: string | undefined;
	onOpen?: (() => void) | undefined;
}) {
	const glimpse = code.split("\n").slice(0, 5).join("\n");
	const tokens = useHighlighted(glimpse, highlightAs ?? language);
	return (
		<Card file={file} detail={language} icon={<FileIcon />} onOpen={onOpen}>
			<pre className="m-0 w-full overflow-hidden border-b border-line-soft bg-paper-2 px-3.5 py-3 font-code text-meta leading-[1.15rem] text-ink">
				<CodeLines code={glimpse} tokens={tokens} />
			</pre>
		</Card>
	);
}

/** A file there is nothing to show of: its name and size, and a tap downloads or opens it. */
export function PlainFile({
	file,
	kind = "File",
	icon = <FileIcon />,
	onOpen,
}: {
	file: FileMeta;
	kind?: string;
	icon?: ReactNode;
	onOpen?: (() => void) | undefined;
}) {
	return <Card file={file} detail={kind} icon={icon} onOpen={onOpen} />;
}

/** Audio as the device plays it: the bytes are here, so its own controls work, keyboard and screen reader included. */
export function AudioPlayer({ file, src }: { file: FileMeta; src: string }) {
	return (
		<span className="flex w-72 max-w-full flex-col gap-1.5 rounded-tile border border-line-soft bg-paper px-2.5 py-2.5">
			{/* biome-ignore lint/a11y/useMediaCaption: what the owner or an agent recorded has no captions to give */}
			<audio controls preload="metadata" src={src} aria-label={file.name} className="h-9 w-full" />
			<span className="truncate px-1 text-meta text-ink-2">{[file.name, file.size].filter(Boolean).join(" · ")}</span>
		</span>
	);
}

/** Video as the device plays it, inline. */
export function VideoPlayer({ file, src }: { file: FileMeta; src: string }) {
	return (
		<span className="flex w-80 max-w-full flex-col overflow-hidden rounded-tile border border-line-soft bg-paper">
			{/* biome-ignore lint/a11y/useMediaCaption: what the owner or an agent recorded has no captions to give */}
			<video controls preload="metadata" playsInline src={src} aria-label={file.name} className="block w-full" />
			<span className="truncate px-3 py-2 text-meta text-ink-2">
				{[file.name, file.size].filter(Boolean).join(" · ")}
			</span>
		</span>
	);
}

/** Audio: play, how far, how long. */
export function AudioFile({
	file,
	duration,
	playing = false,
}: {
	file: FileMeta;
	duration: string;
	playing?: boolean;
}) {
	const bars = [3, 6, 9, 5, 11, 7, 13, 8, 5, 10, 14, 9, 6, 12, 7, 4, 9, 11, 6, 3, 8, 12, 7, 5];
	return (
		<div className="flex w-72 max-w-full items-center gap-3 rounded-tile border border-line-soft bg-paper px-2.5 py-2.5">
			<button
				type="button"
				aria-label={playing ? `Pause ${file.name}` : `Play ${file.name}`}
				className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-paper"
			>
				{playing ? <PauseIcon className="size-4" /> : <PlayIcon className="ml-0.5 size-4" />}
			</button>
			<span aria-hidden="true" className="flex h-6 flex-1 items-center gap-[2px]">
				{bars.map((h, i) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: a waveform, by position
						key={i}
						className={cn("w-[3px] rounded-full", i < 9 && playing ? "bg-ink" : "bg-ink-3")}
						style={{ height: h * 1.6 }}
					/>
				))}
			</span>
			<span className="shrink-0 text-meta text-ink-2 tabular-nums">{duration}</span>
		</div>
	);
}

/** Video: its first frame, and play. */
export function VideoFile({ file, duration, poster }: { file: FileMeta; duration: string; poster: string }) {
	return (
		<button
			type="button"
			aria-label={`Play ${file.name}, ${duration}`}
			className="relative block w-80 max-w-full overflow-hidden rounded-tile border border-line-soft"
		>
			<img src={poster} alt="" className="block aspect-video w-full object-cover" />
			<span className="absolute inset-0 flex items-center justify-center">
				<span className="flex size-12 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur">
					<PlayIcon className="ml-0.5 size-5" />
				</span>
			</span>
			<span className="absolute right-2 bottom-2 rounded-[5px] bg-black/55 px-1.5 py-0.5 text-meta text-white tabular-nums">
				{duration}
			</span>
		</button>
	);
}
