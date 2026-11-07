/**
 * A dialog that needs nothing more folds into one row of the feed, `<icon> <who> <action> <ref>`, so the chat stays
 * words: an allowed GitHub effect, a new agent, a permission, a change to an agent's file, a routine, an answered
 * question. The row opens back into the card it was. Rows in a stretch stack tight, like a log.
 */
import type { LucideIcon } from "lucide-react";
import {
	CalendarCheckIcon,
	CalendarClockIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleDotIcon,
	FilePenIcon,
	GitCommitHorizontalIcon,
	GitMergeIcon,
	GitPullRequestIcon,
	MessageCircleQuestionIcon,
	MessageSquareIcon,
	SendIcon,
	ShieldCheckIcon,
	TagIcon,
	TicketIcon,
	UserRoundPlusIcon,
	XIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Face } from "./Face.tsx";
import { Mention } from "./Feed.tsx";
import { ObjectLink } from "./Object.tsx";
import type { Who } from "./Row.tsx";

export type DoneKind =
	| "comment"
	| "issue"
	| "close"
	| "pull-request"
	| "merge"
	| "review"
	| "label"
	| "push"
	| "agent"
	| "permission"
	| "change"
	| "routine"
	| "answer"
	| "send"
	| "book"
	| "declined";

const KIND: Record<DoneKind, { icon: LucideIcon; tone: string }> = {
	comment: { icon: MessageSquareIcon, tone: "text-ink-2" },
	issue: { icon: CircleDotIcon, tone: "text-alive" },
	close: { icon: CircleCheckIcon, tone: "text-ink-2" },
	"pull-request": { icon: GitPullRequestIcon, tone: "text-alive" },
	merge: { icon: GitMergeIcon, tone: "text-ink" },
	review: { icon: CircleCheckIcon, tone: "text-alive" },
	label: { icon: TagIcon, tone: "text-ink-2" },
	push: { icon: GitCommitHorizontalIcon, tone: "text-ink-2" },
	agent: { icon: UserRoundPlusIcon, tone: "text-alive" },
	permission: { icon: ShieldCheckIcon, tone: "text-ink-2" },
	change: { icon: FilePenIcon, tone: "text-ink-2" },
	routine: { icon: CalendarCheckIcon, tone: "text-ink-2" },
	answer: { icon: MessageCircleQuestionIcon, tone: "text-ink-2" },
	send: { icon: SendIcon, tone: "text-ink-2" },
	book: { icon: TicketIcon, tone: "text-alive" },
	declined: { icon: XIcon, tone: "text-ink-3" },
};

/** A plain thing it was about: an agent, a site, a routine. */
export type DoneRef = {
	/** What it is about: "Mara", "flights.example", "Morning brief". */
	readonly where: string;
	/** Its title, quiet after it; dropped on a narrow row. */
	readonly title?: string | undefined;
};

/** An agent made or changed: its mention, face and name, a link to its chat. */
export type DoneAgent = {
	readonly agent: Who & { readonly id?: string | undefined };
	/** What changed, quiet after it; dropped on a narrow row. */
	readonly title?: string | undefined;
};

/** A routine set up or changed: a chip with its name that opens it in the agent's panel, its schedule quiet after. */
export type DoneRoutine = {
	readonly routine: { readonly title: string; readonly when?: string | undefined };
	readonly onOpen?: (() => void) | undefined;
};

/** A ref drawn by its caller (one read from the daemon once, say). */
export type DoneNode = { readonly node: ReactNode };

/** An object the daemon knows (a pull request, an issue, a check run): drawn as in a message, its mark, state and link. */
export type DoneObject = {
	readonly object: Parameters<typeof ObjectLink>[0]["object"];
	readonly href: string;
};

export function Done({
	kind,
	who,
	action,
	reference,
	note,
	time,
	card,
	open: initiallyOpen = false,
}: {
	kind: DoneKind;
	/** Who did it, in a group only; in a chat with one agent it goes unsaid, as on its messages. */
	who?: Who | undefined;
	/** Past tense, lower case: "commented on", "merged", "opened". Said first, it starts with a capital. */
	action: string;
	/** What it was about; none when the words already say it. */
	reference?: DoneRef | DoneObject | DoneAgent | DoneRoutine | DoneNode | undefined;
	/** Quiet words after it: how it was done ("as you edited it"). Dropped on a narrow row. */
	note?: string | undefined;
	time?: string | undefined;
	/** The card it folded from, shown again (settled, nothing left to do) when the row opens. */
	card?: ReactNode;
	open?: boolean;
}) {
	const [open, setOpen] = useState(initiallyOpen);
	const panel = useId();
	const { icon: Icon, tone } = KIND[kind];
	const declined = kind === "declined";
	const said = who === undefined ? action.charAt(0).toUpperCase() + action.slice(1) : action;
	const ref =
		reference === undefined ? null : "node" in reference ? (
			<span className="flex min-w-0 font-medium text-ink">{reference.node}</span>
		) : "routine" in reference ? (
			<span className="flex min-w-0 items-center gap-1.5">
				<button
					type="button"
					onClick={reference.onOpen}
					aria-label={`Open the routine ${reference.routine.title}`}
					className={cn(
						"inline-flex min-w-0 items-center gap-1 rounded-[6px] bg-paper-3 py-px pr-1.5 pl-1 font-medium text-ink",
						"hover:underline focus-visible:underline",
						declined && "text-ink-2 line-through decoration-ink-3",
					)}
				>
					<CalendarClockIcon aria-hidden="true" className="size-3.5 shrink-0" />
					<span className="truncate">{reference.routine.title}</span>
				</button>
				{reference.routine.when === undefined ? null : (
					<span className="hidden min-w-0 truncate text-ink-2 @sm:inline">{reference.routine.when}</span>
				)}
			</span>
		) : "agent" in reference ? (
			<span className="flex min-w-0 items-center gap-1.5">
				<span className="shrink-0">
					<Mention who={reference.agent} />
				</span>
				{reference.title === undefined ? null : (
					<span className="hidden min-w-0 truncate text-ink-2 @sm:inline">{reference.title}</span>
				)}
			</span>
		) : "object" in reference ? (
			<span className={cn("flex min-w-0 font-medium text-ink", declined && "text-ink-2 line-through decoration-ink-3")}>
				<ObjectLink object={reference.object} href={reference.href} />
			</span>
		) : (
			<span className="flex min-w-0 items-baseline gap-1.5">
				<span
					className={cn(
						"min-w-0 truncate font-medium text-ink",
						declined && "text-ink-2 line-through decoration-ink-3",
					)}
				>
					{reference.where}
				</span>
				{reference.title === undefined ? null : (
					<span className="hidden min-w-0 shrink-[99] truncate text-ink-2 @sm:inline">{reference.title}</span>
				)}
			</span>
		);
	return (
		<div data-done={kind} className="@container mx-auto flex w-full max-w-[var(--measure)] flex-col items-center">
			<div className="group/done flex min-h-8 max-w-full items-center gap-2 rounded-field px-1.5 text-ui hover:bg-paper-2">
				<Icon aria-hidden="true" className={cn("size-4 shrink-0", tone)} />
				<span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
					{who === undefined ? null : (
						<>
							<Face face={who.face} name={who.name} size="mention" />
							<span className="shrink-0 font-medium text-ink">{who.name}</span>
						</>
					)}
					<span className="min-w-0 truncate text-ink-2" title={said}>
						{said}
					</span>
					{ref}
					{note === undefined ? null : (
						<span className="hidden min-w-0 shrink-[99] truncate text-ink-2 @sm:inline">{note}</span>
					)}
				</span>
				{time === undefined ? null : (
					<span className="shrink-0 text-meta text-ink-2 tabular-nums max-sm:hidden">{time}</span>
				)}
				{card === undefined ? null : (
					<button
						type="button"
						aria-expanded={open}
						aria-controls={panel}
						aria-label={open ? "Fold" : "Show details"}
						onClick={() => setOpen(!open)}
						className="relative -mr-0.5 grid size-7 shrink-0 place-items-center rounded-field text-ink-2 hover:bg-paper-3 hover:text-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-2"
					>
						<ChevronRightIcon
							className={cn(
								"size-3.5 transition-transform duration-[var(--duration-base)] ease-out motion-reduce:transition-none",
								open && "rotate-90",
							)}
						/>
					</button>
				)}
			</div>
			{card === undefined ? null : (
				<Reveal open={open} id={panel}>
					<div className="pt-1 pb-2">{card}</div>
				</Reveal>
			)}
		</div>
	);
}

/** A stretch of rows: no space between, so a run of work reads as one log. */
export function DoneFeed({ children }: { children: ReactNode }) {
	return <div className="flex flex-col">{children}</div>;
}

/** The design's ease-out (tokens.css `--ease-out`): quick to start, long to settle. */
const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const EASE_OUT_CSS = `cubic-bezier(${EASE_OUT.join(", ")})`;

/**
 * Height is layout: it cannot reach the compositor, and the content below has to move with it. So it runs as a native
 * Web Animation (the browser ticks it, no JavaScript each frame), only for as long as it moves, clipped only while it
 * moves; and what it holds is contained, so its insides are not laid out again on every frame.
 */
function resize(element: HTMLElement, from: number, to: number, duration: number): Animation {
	element.style.overflow = "hidden";
	const animation = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
		duration,
		easing: EASE_OUT_CSS,
		fill: "both",
	});
	return animation;
}

/**
 * What a row opens: grows from nothing as it fades in, and shrinks back as it fades out before it leaves. Reversing
 * midway starts from where it is. Reduced motion: the height snaps and only the fade remains.
 */
function Reveal({ open, id, children }: { open: boolean; id: string; children: ReactNode }) {
	const reduced = useReducedMotion() === true;
	const [mounted, setMounted] = useState(open);
	if (open && !mounted) setMounted(true);
	const frame = useRef<HTMLDivElement>(null);
	const running = useRef<Animation[]>([]);
	const shown = useRef(open);
	useLayoutEffect(() => {
		const element = frame.current;
		if (element === null || shown.current === open) return;
		shown.current = open;
		const moving = running.current.length > 0;
		const height = element.getBoundingClientRect().height;
		const opacity = Number(getComputedStyle(element).opacity);
		for (const animation of running.current) animation.cancel();
		const natural = element.scrollHeight;
		const sized = resize(element, moving ? height : open ? 0 : natural, open ? natural : 0, reduced ? 0 : 240);
		const faded = element.animate([{ opacity: moving ? opacity : open ? 0 : 1 }, { opacity: open ? 1 : 0 }], {
			duration: reduced ? 150 : open ? 240 : 160,
			easing: EASE_OUT_CSS,
			fill: "both",
		});
		const now = [sized, faded];
		running.current = now;
		Promise.all(now.map((animation) => animation.finished)).then(
			() => {
				running.current = [];
				if (!open) {
					setMounted(false);
					return;
				}
				for (const animation of now) animation.cancel();
				element.style.overflow = "";
			},
			() => {
				// Cancelled by a reversal, which took over from here.
			},
		);
	}, [open, reduced]);
	return mounted ? (
		<div ref={frame} id={id} className="w-full">
			<div className="[contain:layout_style]">{children}</div>
		</div>
	) : null;
}

/**
 * A live card that folds into its row once it is settled. The result ("Commented · 10:52") holds a beat so the owner
 * sees it land, whatever their motion setting; then the card fades as its frame closes to the row's height, and the
 * row arrives from just above. Unsettled again (a retry), the card comes back, retargeting from wherever the fold is.
 * Reduced motion: no fold, the card and row crossfade and the height snaps.
 */
export function Settling({
	settled,
	card,
	row,
	hold = 700,
	fresh = true,
}: {
	settled: boolean;
	/** Seen open on this page, so its settling folds as the owner watches. False: already the row when it mounts. */
	fresh?: boolean;
	card: ReactNode;
	row: ReactNode;
	/** How long the settled card shows its result before folding. */
	hold?: number;
}) {
	const reduced = useReducedMotion() === true;
	const [folded, setFolded] = useState(settled && !fresh);
	useEffect(() => {
		if (!settled) {
			setFolded(false);
			return;
		}
		const timer = setTimeout(() => setFolded(true), hold);
		return () => clearTimeout(timer);
	}, [settled, hold]);
	// Height is driven only across the swap, then handed back to the content ("auto"), so a row opening its card inside
	// grows on its own animation instead of being chased by this one. The frame's last height comes from its observer,
	// which has not yet seen the new content when the swap commits: that is the height to start from.
	const frame = useRef<HTMLDivElement>(null);
	const inner = useRef<HTMLDivElement>(null);
	const last = useRef(0);
	const running = useRef<Animation | null>(null);
	useLayoutEffect(() => {
		const element = frame.current;
		if (element === null) return;
		last.current = element.offsetHeight;
		const observer = new ResizeObserver(() => {
			last.current = element.offsetHeight;
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const shown = useRef(folded);
	useLayoutEffect(() => {
		if (shown.current === folded) return;
		shown.current = folded;
		const element = frame.current;
		const content = inner.current;
		if (element === null || content === null) return;
		running.current?.cancel();
		const from = last.current;
		const to = content.offsetHeight;
		const release = () => {
			element.style.height = "";
			element.style.overflow = "";
		};
		if (reduced || from === to) {
			release();
			return;
		}
		const sized = resize(element, from, to, 280);
		running.current = sized;
		sized.finished.then(
			() => {
				sized.cancel();
				release();
			},
			() => {
				// Cancelled by the next swap, which took over from here.
			},
		);
	}, [folded, reduced]);
	return (
		<div ref={frame}>
			<div ref={inner} className="relative [contain:layout_style]">
				<AnimatePresence mode="popLayout" initial={false}>
					{folded ? (
						<motion.div
							key="row"
							initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(-6px)" }}
							animate={reduced ? { opacity: 1 } : { opacity: 1, transform: "translateY(0px)" }}
							transition={reduced ? { duration: 0.15 } : { duration: 0.22, ease: EASE_OUT, delay: 0.06 }}
						>
							{row}
						</motion.div>
					) : (
						<motion.div
							key="card"
							style={{ transformOrigin: "top center" }}
							initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(0.985)" }}
							animate={reduced ? { opacity: 1 } : { opacity: 1, transform: "scale(1)" }}
							exit={
								reduced
									? { opacity: 0, transition: { duration: 0.15 } }
									: { opacity: 0, transform: "scale(0.97)", transition: { duration: 0.16, ease: EASE_OUT } }
							}
							transition={reduced ? { duration: 0.15 } : { duration: 0.2, ease: EASE_OUT }}
						>
							{card}
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		</div>
	);
}
