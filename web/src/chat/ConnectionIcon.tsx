import { useState } from "react";
import { cn } from "@/lib/cn";
import { GitHubMark } from "./Object.tsx";

const OFFICIAL_FAVICONS: Record<string, string> = {
	gmail: "https://mail.google.com/favicon.ico",
	calendar: "https://calendar.google.com/favicon.ico",
	drive: "https://drive.google.com/favicon.ico",
	docs: "https://docs.google.com/favicon.ico",
};

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
	const src = OFFICIAL_FAVICONS[name] ?? serverFavicon(url);
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
