/**
 * One line of text that, short of room, gives way in its head and keeps its end: a path's file name, a command's last
 * step, a trailing " · submit" (lib/ends.ts says where the end starts). The head ends in "…" first; only once it is gone
 * does the end itself cut. The whole text is its title, so a pointer still reads it all.
 */
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/cn";
import type { Ends } from "@/lib/ends";

// `pre`, not `nowrap`: the space where head meets end would otherwise collapse at the head's edge
const PART = "overflow-hidden text-ellipsis whitespace-pre";

export function KeepEnd({
	ends: { head, end },
	whole = head + end,
	shimmer = false,
	className,
}: {
	ends: Ends;
	/** The text before any cap, for the title; by default what it shows. */
	whole?: string;
	/** Working: a light sweeps across it, as across a working line. */
	shimmer?: boolean;
	className?: string;
}) {
	const part = (text: string, kept: boolean) => {
		// the head shrinks to its "…" before the end gives a character, so a cut never goes unmarked; the end never grows
		// past the line, less that mark
		const classes = cn(
			PART,
			kept ? (head === "" ? "max-w-full shrink-0" : "max-w-[calc(100%-1rem)] shrink-0") : "min-w-4",
		);
		return shimmer ? (
			<Shimmer as="span" className={classes}>
				{text}
			</Shimmer>
		) : (
			<span className={classes}>{text}</span>
		);
	};
	return (
		<span data-keep-end="" title={whole} className={cn("flex min-w-0", className)}>
			{head === "" ? null : part(head, false)}
			{end === "" ? null : part(end, true)}
		</span>
	);
}
