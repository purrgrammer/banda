/**
 * The chat's timeline: runs of messages as bubbles, the owner's on the right, an agent's on the left, under its face and
 * name in a group (in a 1:1 chat the header already says who); day separators, the unread divider, jump to latest.
 * Cards sit in the agent's column, outside the bubbles.
 */
import { ArrowDownIcon, CheckIcon, CopyIcon, ListTreeIcon } from "lucide-react";
import { Children, createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Face } from "./Face.tsx";
import type { Who } from "./Row.tsx";

/** Whose run a bubble is in: the owner's, or an agent's. */
const Mine = createContext(false);

/** A run the agent is still at: its face moves and, when `onOpen` is given, opens the activity from the slot it sits in. */
export type RunWork = { readonly onOpen?: ((face: HTMLElement) => void) | undefined };

/**
 * A run's face. It stays one element from the working indicator to the reply, so the state change reaches the scene on
 * screen and the motion eases to rest. The button lies over the face, 44px to the touch; the slot is where focus can
 * still return once the work ended and the button went.
 */
function RunFace({ who, work }: { who: Who; work: RunWork | undefined }) {
	const slot = useRef<HTMLSpanElement>(null);
	const onOpen = work?.onOpen;
	return (
		<span
			ref={slot}
			tabIndex={-1}
			data-run-face={work === undefined ? "" : "working"}
			className="relative -mt-0.5 inline-flex shrink-0 self-start rounded-full outline-none"
		>
			<span aria-hidden={onOpen === undefined ? undefined : true} className="inline-flex">
				<Face face={who.face} name={who.name} size="message" state={work === undefined ? "idle" : "working"} />
			</span>
			{onOpen === undefined ? null : (
				<button
					type="button"
					aria-label={`${who.name} is working`}
					className="absolute -inset-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ink"
					onClick={() => {
						if (slot.current !== null) onOpen(slot.current);
					}}
				/>
			)}
		</span>
	);
}

/** A run of consecutive messages from one side. In a 1:1 chat the agent's run has no face or name, its time below. */
export function Run({
	who,
	time,
	children,
	compact = false,
	faced = false,
	work,
}: {
	/** The agent who spoke, or undefined for the owner. */
	who?: Who | undefined;
	time?: string | undefined;
	children?: ReactNode;
	/** A 1:1 chat: neither face nor name, which the header already shows. */
	compact?: boolean;
	/** A 1:1 run the working face stood on: it keeps the face, still without the name. */
	faced?: boolean;
	/** The agent is at work on this run: the face alone says so. */
	work?: RunWork | undefined;
}) {
	if (who === undefined)
		return (
			<div className="flex flex-col items-end gap-1 pl-12">
				<Mine.Provider value={true}>{children}</Mine.Provider>
				{time === undefined ? null : <span className="px-1 text-meta text-ink-2">{time}</span>}
			</div>
		);
	if (compact && !faced)
		return (
			<div className="flex flex-col items-start gap-1.5 pr-12">
				{children}
				{time === undefined ? null : <span className="px-1 text-meta text-ink-2">{time}</span>}
			</div>
		);
	// nothing said yet: the face alone, no name beside it
	const named = !compact && Children.toArray(children).length > 0;
	return (
		<div className={cn("flex gap-2.5", compact ? "pr-12" : "pr-6")}>
			<RunFace who={who} work={work} />
			<div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
				{named ? (
					<span className="flex items-baseline gap-2">
						<span className="text-body font-semibold text-ink">{who.name}</span>
						{time === undefined ? null : <span className="text-meta text-ink-2">{time}</span>}
					</span>
				) : null}
				{children}
				{compact && time !== undefined ? <span className="px-1 text-meta text-ink-2">{time}</span> : null}
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
	reaction,
	copy,
	onActivity,
}: {
	/** Whose it is; by default, its run's. */
	mine?: boolean;
	children: ReactNode;
	/** The emoji an agent reacted with, under the owner's message. */
	reaction?: string | undefined;
	/** The message's words as they were written: a quiet Copy on hover, focus or a long press. */
	copy?: string | undefined;
	/** Inspect the work behind this message, beside Copy. Off unless this surface supplies its recorded work. */
	onActivity?: (() => void) | undefined;
}) {
	const inMine = useContext(Mine);
	const mine = told ?? inMine;
	return (
		<MessageActions copy={copy} onActivity={onActivity} reaction={reaction} mine={mine}>
			<div
				data-message-bubble=""
				data-mine={mine ? "" : undefined}
				className={cn(
					"min-w-0 rounded-bubble px-3.5 py-2 text-body break-words [overflow-wrap:anywhere] [&_p+p]:mt-2",
					mine ? "bg-paper-2 text-ink" : "border border-line-soft bg-paper text-ink",
				)}
			>
				{children}
			</div>
		</MessageActions>
	);
}

/** The same quiet controls on prose, file-only messages and object-only messages. */
export function MessageActions({
	children,
	copy,
	onActivity,
	reaction,
	mine = false,
}: {
	children: ReactNode;
	copy?: string | undefined;
	onActivity?: (() => void) | undefined;
	reaction?: string | undefined;
	/** The owner's: the controls sit on its left, the side facing the chat, never off its right edge. */
	mine?: boolean;
}) {
	const [pressed, setPressed] = useState(false);
	const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const release = () => clearTimeout(press.current);
	return (
		<div
			className={cn(
				"group/bubble relative flex max-w-[min(100%,var(--measure))] items-end gap-1",
				mine && "flex-row-reverse",
				reaction !== undefined && "mb-3",
			)}
			// A long press reveals the message's actions on touch; focus reveals them for keyboard users.
			onPointerDown={(event) => {
				if ((copy === undefined && onActivity === undefined) || event.pointerType !== "touch") return;
				press.current = setTimeout(() => {
					setPressed(true);
					setTimeout(() => setPressed(false), 4000);
				}, 450);
			}}
			onPointerUp={release}
			onPointerCancel={release}
			onPointerLeave={release}
		>
			{children}
			{onActivity ? (
				<div className="flex shrink-0 flex-col items-center gap-1">
					{copy === undefined || copy.trim() === "" ? null : (
						<CopyButton text={copy} shown={pressed} onDone={() => setPressed(false)} />
					)}
					<button
						type="button"
						aria-label="View activity"
						title="View activity"
						onClick={onActivity}
						className={cn(
							"flex size-7 shrink-0 items-center justify-center rounded-full bg-paper text-ink-2 ring-1 ring-line",
							"opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100 hover:text-ink focus-visible:opacity-100 motion-reduce:transition-none",
							pressed && "opacity-100",
						)}
					>
						<ListTreeIcon aria-hidden="true" className="size-3.5" />
					</button>
				</div>
			) : copy === undefined || copy.trim() === "" ? null : (
				<CopyButton text={copy} shown={pressed} onDone={() => setPressed(false)} />
			)}
			{reaction === undefined ? null : (
				<span
					role="img"
					aria-label={`reacted ${reaction}`}
					className="absolute -bottom-3 left-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-paper px-1 text-[14px] leading-none ring-1 ring-line"
				>
					{reaction}
				</span>
			)}
		</div>
	);
}

/**
 * Copy occupies its own in-flow column beside the bubble, above the run's timestamp. Its space is reserved even
 * while quiet, so hover, keyboard focus and a long press change visibility without moving the message or its time;
 * it says Copied for a moment, or Couldn't copy when the browser refuses.
 */
export function CopyButton({ text, shown = false, onDone }: { text: string; shown?: boolean; onDone?: () => void }) {
	const [said, setSaid] = useState<"copied" | "failed" | undefined>(undefined);
	const done = useRef(onDone);
	done.current = onDone;
	useEffect(() => {
		if (said === undefined) return;
		const timer = setTimeout(() => {
			setSaid(undefined);
			done.current?.();
		}, 1500);
		return () => clearTimeout(timer);
	}, [said]);
	const label = said === "copied" ? "Copied" : said === "failed" ? "Couldn't copy" : "Copy the message";
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={() =>
				void navigator.clipboard.writeText(text).then(
					() => setSaid("copied"),
					() => setSaid("failed"),
				)
			}
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-full bg-paper text-ink-2 ring-1 ring-line",
				"opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100 hover:text-ink focus-visible:opacity-100 motion-reduce:transition-none",
				(shown || said !== undefined) && "opacity-100",
			)}
		>
			{said === "copied" ? (
				<CheckIcon aria-hidden="true" className="size-3.5" />
			) : (
				<CopyIcon aria-hidden="true" className="size-3.5" />
			)}
			<span role="status" className="sr-only">
				{said === undefined ? "" : label}
			</span>
		</button>
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
