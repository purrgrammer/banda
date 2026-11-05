/**
 * Files by their blob: a chip that downloads it, and an image shown inline. Anything that names a blob renders through
 * these: a message's files, the owner's, and a `[name](sha256:<hex>)` link in markdown.
 */
import { DownloadIcon, FileIcon } from "lucide-react";
import { useEffect, useState } from "react";
import Zoom from "react-medium-image-zoom";
import "react-medium-image-zoom/dist/styles.css";
import { blobFile } from "../lib/api.ts";

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** Whether a file shows inline, by its name. */
export const isImage = (name: string) => IMAGE.test(name);

/** The blob a `sha256:` link names, or undefined when it names none. */
export function linkedBlob(href: string | undefined): string | undefined {
	const sha = href?.startsWith("sha256:") ? href.slice("sha256:".length) : undefined;
	return sha !== undefined && /^[0-9a-f]{64}$/.test(sha) ? sha : undefined;
}

/** A blob's object URL once fetched; undefined meanwhile, or when it cannot be. */
export function useBlobUrl(sha: string | undefined): string | undefined {
	const [url, setUrl] = useState<string>();
	useEffect(() => {
		if (sha === undefined) return;
		let gone = false;
		void blobFile(sha).then(
			(loaded) => {
				if (!gone) setUrl(loaded);
			},
			() => undefined,
		);
		return () => {
			gone = true;
		};
	}, [sha]);
	return url;
}

/** A file's chip: it downloads the file once its bytes are here, and only names it before. */
export function FileChip({ name, url }: { name: string; url?: string }) {
	const chip = "inline-flex h-8 max-w-full items-center gap-2 rounded-chip bg-sa-surface px-3 align-middle text-sm";
	return url === undefined ? (
		<span className={`${chip} text-sa-muted`}>
			<FileIcon aria-hidden="true" className="size-4 shrink-0" />
			<span className="truncate">{name}</span>
		</span>
	) : (
		<a
			href={url}
			download={name}
			title={`Download ${name}`}
			className={`${chip} no-underline transition-colors duration-hover hover:text-sa-accent`}
		>
			<DownloadIcon aria-hidden="true" className="size-4 shrink-0 text-sa-muted" />
			<span className="truncate">{name}</span>
		</a>
	);
}

/**
 * An image: shown at most 256 px tall (at least 32 px, so a tiny one still shows), its download beside its bottom edge.
 * A click zooms it from where it sits to fit the window, over the page; a click or Escape puts it back. `name` is
 * what it downloads as and what a screen reader says; it is not shown.
 */
export function ImageAttachment({
	name,
	url,
	download = "left",
}: {
	name: string;
	url: string;
	/** Which side of the image its download sits on: toward the middle of the column, away from the row's own side. */
	download?: "left" | "right";
}) {
	const save = (
		<a
			href={url}
			download={name}
			aria-label={`Download ${name}`}
			title="Download"
			className="flex size-8 shrink-0 items-center justify-center rounded-full text-sa-muted transition-colors duration-hover hover:bg-sa-surface hover:text-sa-text"
		>
			<DownloadIcon aria-hidden="true" className="size-4" />
		</a>
	);
	return (
		<span className="flex max-w-full items-end gap-1.5">
			{download === "left" ? save : null}
			<Zoom zoomMargin={40} wrapElement="span" a11yNameButtonZoom={`Open ${name}`} a11yNameButtonUnzoom="Close">
				<img
					src={url}
					alt={name}
					className="block max-h-64 min-h-8 max-w-full min-w-8 cursor-zoom-in rounded-card object-contain shadow-[inset_0_0_0_1px_var(--sa-border)] [image-rendering:pixelated]"
				/>
			</Zoom>
			{download === "right" ? save : null}
		</span>
	);
}

/** A blob by its sha: an image as an image (its download on `download`'s side), anything else as its chip. */
export function BlobFile({ sha, name, download }: { sha: string; name: string; download?: "left" | "right" }) {
	const url = useBlobUrl(sha);
	if (!isImage(name) || url === undefined) return <FileChip name={name} {...(url === undefined ? {} : { url })} />;
	return <ImageAttachment name={name} url={url} {...(download === undefined ? {} : { download })} />;
}
