import { useState } from "react";
import { cn } from "@/lib/cn";
import { GitHubMark } from "./Object.tsx";

/** Marks banda ships for the services it knows: a service's own favicon address needs its sign-in and is no image. */
const SHIPPED_MARKS = new Set(["gmail", "calendar", "drive", "docs"]);

function serverFavicon(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
		return new URL("/favicon.ico", parsed.origin).href;
	} catch {
		return undefined;
	}
}

/** Official service marks where known; otherwise try the configured MCP origin's favicon and fall back to initials. */
export function ConnectionIcon({
	connection,
	url,
	className,
}: {
	connection: string;
	url?: string | undefined;
	className?: string | undefined;
}) {
	const name = connection.toLowerCase();
	const src = SHIPPED_MARKS.has(name) ? `/connections/${name}.png` : serverFavicon(url);
	const [failedSrc, setFailedSrc] = useState<string | undefined>();
	if (name === "github") return <GitHubMark {...(className === undefined ? {} : { className })} />;
	return (
		<span className={cn("relative inline-flex size-5 shrink-0 items-center justify-center", className)}>
			{src === undefined || failedSrc === src ? (
				<span className="text-meta font-semibold text-ink-2">{connection.slice(0, 1)}</span>
			) : (
				<img
					key={src}
					src={src}
					alt=""
					loading="lazy"
					referrerPolicy="no-referrer"
					className="size-full object-contain"
					onError={() => setFailedSrc(src)}
				/>
			)}
		</span>
	);
}
