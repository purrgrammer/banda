/**
 * The chat's timeline: runs of messages as bubbles, the owner's on the right, an agent's on the left, under its face and
 * name in a group (in a 1:1 chat the header already says who); day separators, the unread divider, jump to latest.
 * Cards sit in the agent's column, outside the bubbles.
 */
import { ArrowDownIcon, CheckIcon, CopyIcon, EllipsisIcon, ListTreeIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { Face } from "./Face.tsx";
import type { Who } from "./Row.tsx";

/** Whose run a bubble is in: the owner's, or an agent's. */
const Mine = createContext(false);

const timeStyle = "text-[0.6875rem] leading-none tabular-nums text-ink-2";

/** A run of consecutive messages from one side. In a 1:1 chat the header names the agent. */
export function Run({
	who,
	time,
	children,
	compact = false,
}: {
	/** The agent who spoke, or undefined for the owner. */
	who?: Who | undefined;
	time?: string | undefined;
	children: ReactNode;
	/** A 1:1 chat: neither face nor name, which the header already shows. */
	compact?: boolean;
}) {
	const mine = who === undefined;
	if (mine || compact)
		return (
			<div
				data-compact-agent-run={mine ? undefined : ""}
				className={cn(
					"flex w-full max-w-[44rem] flex-col",
					mine ? "items-end self-end ps-12" : "items-start self-start pe-12",
				)}
			>
				<div
					className={cn("relative flex w-fit max-w-full flex-col", mine ? "items-end gap-1" : "items-start gap-1.5")}
				>
					{time === undefined ? null : (
						<span
							className={cn(
								timeStyle,
								"absolute top-2.5 whitespace-nowrap",
								mine ? "end-full me-1" : "start-full ms-1",
							)}
						>
							{time}
						</span>
					)}
					<Mine.Provider value={mine}>{children}</Mine.Provider>
				</div>
			</div>
		);
	return (
		<div className="flex gap-2.5 pr-6">
			<Face face={who.face} name={who.name} size="message" className="-mt-0.5" />
			<div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
				<span className="flex items-baseline gap-2">
					<span className="text-body font-semibold text-ink">{who.name}</span>
					{time === undefined ? null : <span className={timeStyle}>{time}</span>}
				</span>
				{children}
			</div>
		</div>
	);
}

/** Whether what is being drawn sits in the owner's run. */
export const useMine = () => useContext(Mine);

/** One message's words. The owner's bubble is ink, so theirs stand apart; an agent's is framed by a hairline. */
export function Bubble({
	mine: told,
	children,
	className,
	reaction,
	copy,
	onActivity,
}: {
	/** Whose it is; by default, its run's. */
	mine?: boolean;
	children: ReactNode;
	className?: string;
	/** The emoji an agent reacted with, at the owner's bubble's lower-left corner. */
	reaction?: string | undefined;
	/** The message's words as they were written, available through Copy. */
	copy?: string | undefined;
	/** Inspect the work behind this message, beside Copy. Off unless this surface supplies its recorded work. */
	onActivity?: (() => void) | undefined;
}) {
	const inMine = useContext(Mine);
	const mine = told ?? inMine;
	return (
		<MessageActions copy={copy} onActivity={onActivity} mine={mine}>
			<div
				data-message-bubble=""
				data-mine={mine ? "" : undefined}
				className={cn(
					"relative min-w-0 rounded-2xl px-3 pt-1.5 pb-2.5 text-body break-words [overflow-wrap:anywhere] [&_p+p]:mt-2",
					mine ? "bg-paper-2 text-ink" : "border border-line-soft bg-paper text-ink",
					className,
				)}
			>
				{children}
				{reaction === undefined ? null : (
					<span
						role="img"
						aria-label={`reacted ${reaction}`}
						title={reaction}
						className="absolute -bottom-1 left-1 z-10 h-3.5 min-w-3.5 max-w-[calc(100%-0.25rem)] truncate rounded-full bg-paper px-0.5 text-center text-[10px] leading-3.5 ring-1 ring-line-soft ring-inset"
					>
						{reaction}
					</span>
				)}
			</div>
		</MessageActions>
	);
}

/** The same quiet controls on prose, file-only messages and object-only messages. */
export function MessageActions({
	children,
	copy,
	onActivity,
	mine = false,
}: {
	children: ReactNode;
	copy?: string | undefined;
	onActivity?: (() => void) | undefined;
	/** The owner's: the controls sit on its left, the side facing the chat, never off its right edge. */
	mine?: boolean;
}) {
	const hasCopy = copy !== undefined && copy.trim() !== "";
	const hasActions = hasCopy || onActivity !== undefined;
	const trigger = useRef<HTMLButtonElement>(null);
	const openingActivity = useRef(false);
	const [feedback, setFeedback] = useState<"Copied" | "Couldn't copy">();
	useEffect(() => {
		if (feedback === undefined) return;
		const timer = setTimeout(() => setFeedback(undefined), 1500);
		return () => clearTimeout(timer);
	}, [feedback]);
	return (
		<div
			className={cn(
				"group/bubble relative flex max-w-[min(100%,var(--measure))] items-center gap-1",
				mine && "flex-row-reverse",
			)}
		>
			{children}
			{hasActions ? (
				<DropdownMenu modal={false}>
					<DropdownMenuTrigger asChild>
						<Button
							ref={trigger}
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label="Message actions"
							data-message-transcript={onActivity === undefined ? undefined : ""}
							className={cn(
								"text-ink-2 motion-reduce:transition-none",
								feedback === undefined &&
									"pointer-fine:opacity-0 group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100 data-[state=open]:opacity-100",
							)}
						>
							{feedback === "Copied" ? <CheckIcon aria-hidden="true" /> : <EllipsisIcon aria-hidden="true" />}
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align={mine ? "end" : "start"}
						onCloseAutoFocus={(event) => {
							if (!openingActivity.current) return;
							event.preventDefault();
							openingActivity.current = false;
							trigger.current?.focus({ preventScroll: true });
							onActivity?.();
						}}
					>
						{hasCopy ? (
							<DropdownMenuItem
								className="pointer-coarse:min-h-11"
								onSelect={async () => {
									try {
										await navigator.clipboard.writeText(copy);
										setFeedback("Copied");
									} catch {
										setFeedback("Couldn't copy");
									}
								}}
							>
								<CopyIcon aria-hidden="true" />
								Copy
							</DropdownMenuItem>
						) : null}
						{onActivity === undefined ? null : (
							<DropdownMenuItem
								className="pointer-coarse:min-h-11"
								onSelect={() => {
									openingActivity.current = true;
								}}
							>
								<ListTreeIcon aria-hidden="true" />
								Activity &amp; transcript
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
					<span role="status" className="sr-only">
						{feedback}
					</span>
				</DropdownMenu>
			) : null}
		</div>
	);
}

/**
 * A mention: the agent's face and name, a link to its chat, set in the line as words are. The link is an inline block
 * whose baseline is its name's, so the name sits on the sentence's baseline at the line's own height; the face is
 * sized from the text and centred on its capitals (`Face` size `text`), so it stays within the words' height at any
 * size. It moves to the next line whole, and a name too long for the line ends in an ellipsis (`clip`, not `hidden`,
 * so the block keeps the name's baseline).
 */
export function Mention({ who }: { who: Who & { readonly id?: string | undefined } }) {
	return (
		<a
			href={`#/a/${who.id ?? who.name.toLowerCase()}`}
			className="inline-block max-w-full overflow-x-clip text-ellipsis whitespace-nowrap align-baseline font-semibold text-ink no-underline hover:underline"
		>
			<Face face={who.face} name={who.name} size="text" className="mr-[0.25em]" />
			{who.name}
		</a>
	);
}

export function DaySeparator({ children }: { children: ReactNode }) {
	return <p className="py-2 text-center text-meta font-medium text-ink-2">{children}</p>;
}

/** Where the owner last read: what follows is new. */
export function UnreadDivider({ count }: { count: number }) {
	return (
		<p className="flex items-center gap-3 py-1">
			<span aria-hidden="true" className="h-px flex-1 bg-ink/30" />
			<span className="text-meta font-semibold text-ink">{count} new</span>
			<span aria-hidden="true" className="h-px flex-1 bg-ink/30" />
		</p>
	);
}

/** Scrolled up: back to the newest, with how many came meanwhile. */
export function JumpToLatest({ count }: { count?: number }) {
	return (
		<button
			type="button"
			className="inline-flex h-8 items-center gap-1.5 rounded-full bg-paper px-3 text-meta font-medium text-ink shadow-composer"
		>
			<ArrowDownIcon className="size-3.5" />
			{count === undefined ? "Latest" : `${count} new`}
		</button>
	);
}
