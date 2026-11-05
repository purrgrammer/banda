/**
 * A line in the chat that no one said: an event (a routine ran), the state of things (the computer is starting), or a
 * failure, which names who, what and the fix. Centred, small, plain, led by a small icon of its kind; at most one
 * action, in words.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Line({
	children,
	icon: Icon,
	tone = "quiet",
	action,
	time,
	onClick,
	className,
}: {
	children: ReactNode;
	/** Its kind, small: a routine, the computer, a sign-in, a failure. */
	icon?: LucideIcon | undefined;
	tone?: "quiet" | "danger";
	/** One thing to do about it: "Sign in again", "Try again". */
	action?: { label: string; onClick?: () => void } | undefined;
	time?: string | undefined;
	/** The line itself opens what it is about (a routine's event opens the agent's routines). */
	onClick?: (() => void) | undefined;
	className?: string;
}) {
	const words = (
		<>
			{Icon === undefined ? null : <Icon aria-hidden="true" className="size-3.5 shrink-0" />}
			<span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
		</>
	);
	return (
		<p
			className={cn(
				"mx-auto flex max-w-[var(--measure)] flex-wrap items-center justify-center gap-x-1.5 px-4 text-center text-ui",
				tone === "danger" ? "text-danger" : "text-ink-2",
				className,
			)}
		>
			{onClick === undefined ? (
				words
			) : (
				<button
					type="button"
					onClick={onClick}
					className="inline-flex items-center gap-x-1.5 rounded-field px-1 hover:bg-paper-3 focus-visible:bg-paper-3"
				>
					{words}
				</button>
			)}
			{action === undefined ? null : (
				<>
					<span aria-hidden="true" className="text-ink-3">
						·
					</span>
					<button
						type="button"
						onClick={action.onClick}
						className="font-medium text-ink underline decoration-line underline-offset-[3px] hover:decoration-ink"
					>
						{action.label}
					</button>
				</>
			)}
			{time === undefined ? null : <span className="text-meta text-ink-2">{time}</span>}
		</p>
	);
}
