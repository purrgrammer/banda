/**
 * Chat surfaces for artifacts, browser views, questions and sign-in handoffs.
 */
import {
	BookOpenIcon,
	CheckIcon,
	CircleSlashIcon,
	ClockIcon,
	ExternalLinkIcon,
	FileTextIcon,
	GlobeIcon,
	MonitorIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { pathEnds } from "@/lib/ends";
import { Bubble } from "./Feed.tsx";
import { KeepEnd } from "./KeepEnd.tsx";

/** The frame every card shares: a hairline, the tile radius, the measure. */
export function Tile({
	children,
	className,
	...data
}: {
	children: ReactNode;
	className?: string;
	[attribute: `data-${string}`]: string | undefined;
}) {
	return (
		// the measure, not the column's share: a chat column shrinks each entry to its content, so a card whose content got
		// smaller (an approval once answered) would shrink with it
		<div
			data-tile=""
			{...data}
			className={cn("w-[var(--measure)] max-w-full rounded-tile border border-line-soft bg-paper", className)}
		>
			{children}
		</div>
	);
}

export function ArtifactCard({
	title,
	kind,
	version,
	onOpen,
}: {
	title: string;
	kind: string;
	version: string;
	onOpen?: () => void;
}) {
	return (
		<Tile className="flex items-center gap-3 p-3">
			<span className="flex size-10 shrink-0 items-center justify-center rounded-field bg-paper-3 text-ink-2">
				<FileTextIcon className="size-5" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-ui font-semibold text-ink">{title}</span>
				<span className="truncate text-meta text-ink-2">
					{kind} · {version}
				</span>
			</span>
			<Button variant="outline" size="sm" onClick={onOpen}>
				Open
			</Button>
		</Tile>
	);
}

/** The browser while the agent uses it: small, live, with a way in. `screen` draws the live page; `shot` a still. */
export function ViewCard({
	host,
	title,
	shot,
	screen,
	live = true,
	onOpen,
	onTakeOver,
}: {
	host: string;
	title: string;
	shot?: string | undefined;
	screen?: ReactNode;
	live?: boolean;
	onOpen?: () => void;
	onTakeOver?: () => void;
}) {
	return (
		<Tile className="w-80 max-w-full overflow-hidden">
			<span className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
				<MonitorIcon className="size-3.5 shrink-0 text-ink-2" />
				<span className="min-w-0 truncate text-meta text-ink-2">{host}</span>
				{live ? (
					<span className="ml-auto flex shrink-0 items-center gap-1.5 text-meta font-medium text-ink">
						<span className="size-1.5 animate-pulse rounded-full bg-alive" />
						Live
					</span>
				) : null}
			</span>
			<button
				type="button"
				onClick={onOpen}
				aria-label={`Open ${title}`}
				className="block aspect-[16/10] w-full overflow-hidden bg-paper-2"
			>
				{screen ??
					(shot === undefined ? null : (
						<img src={shot} alt={`${title}, as the agent sees it`} className="block h-full w-full object-cover" />
					))}
			</button>
			<span className="flex items-center gap-2 px-3 py-2">
				<span className="min-w-0 truncate text-meta text-ink-2">{title}</span>
				<Button variant="ghost" size="xs" className="ml-auto" onClick={onTakeOver}>
					Take over
				</Button>
				<Button variant="outline" size="xs" onClick={onOpen}>
					Open
				</Button>
			</span>
		</Tile>
	);
}

export type QuestionState =
	| { readonly kind: "open" }
	| { readonly kind: "answered"; readonly answer: string }
	/** The owner answered in a message of their own, not on the card. */
	| { readonly kind: "answered"; readonly inChat: true }
	| { readonly kind: "dismissed" }
	/** No answer came in time, or its run stopped first; `words` says which, as the store recorded it. */
	| { readonly kind: "expired" | "cancelled"; readonly words: string };

/** A question: its choices as buttons, or an answer typed in the composer; it may be dismissed, or go unanswered. */
export function QuestionCard({
	question,
	choices,
	state = { kind: "open" },
	onChoose,
	onDismiss,
}: {
	question: string;
	choices: readonly string[];
	state?: QuestionState;
	onChoose?: (choice: string) => void;
	onDismiss?: () => void;
}) {
	return (
		<Bubble mine={false} className="flex flex-col gap-2 [&_p+p]:mt-0">
			<p>{question}</p>
			{state.kind === "open" ? (
				<>
					<div className="flex flex-wrap gap-1.5">
						{choices.map((choice) => (
							// a long choice (a link, a token) wraps inside its button rather than pushing the card off the screen
							<Button
								key={choice}
								size="sm"
								variant="outline"
								onClick={() => onChoose?.(choice)}
								className="h-auto min-h-8 max-w-full py-1.5 text-left whitespace-normal [overflow-wrap:anywhere]"
							>
								{choice}
							</Button>
						))}
					</div>
					<p className="flex items-center gap-1.5 text-meta text-ink-2">
						Or type your answer below
						<span aria-hidden="true" className="text-ink-3">
							·
						</span>
						<button
							type="button"
							onClick={onDismiss}
							className="underline decoration-line underline-offset-[3px] hover:text-ink"
						>
							Not now
						</button>
					</p>
				</>
			) : state.kind === "answered" ? (
				// the answer wraps under its words on a narrow card, and a long link or token breaks rather than leaving it
				<p className="flex items-start gap-1.5 text-ui text-ink-2">
					<CheckIcon className="mt-0.5 size-4 shrink-0 text-ink" />
					{"inChat" in state ? (
						<span className="min-w-0">You answered in the chat</span>
					) : (
						<span className="min-w-0 [overflow-wrap:anywhere]">
							You answered <span className="font-medium whitespace-pre-line text-ink">{state.answer}</span>
						</span>
					)}
				</p>
			) : state.kind === "dismissed" ? (
				<p className="text-ui text-ink-2">You let this one go.</p>
			) : (
				<p className="flex items-start gap-1.5 text-ui text-ink-2">
					{state.kind === "expired" ? (
						<ClockIcon className="mt-0.5 size-4 shrink-0" />
					) : (
						<CircleSlashIcon className="mt-0.5 size-4 shrink-0" />
					)}
					<span className="min-w-0 [overflow-wrap:anywhere]">{state.words}</span>
				</p>
			)}
		</Bubble>
	);
}

/** A page the owner must finish: a sign-in, a passkey, a CAPTCHA. */
export function SignInCard({ agent, site }: { agent: string; site: string }) {
	return (
		<Tile className="flex items-center gap-3 p-3.5">
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="text-ui font-semibold text-ink">Sign in to {site}</span>
				<span className="text-meta text-ink-2">{agent} waits while you do; it never sees your password.</span>
			</span>
			<Button size="sm">
				Open <ExternalLinkIcon />
			</Button>
		</Tile>
	);
}

/**
 * What a stretch of browsing opened (`Browsed`), or of reading the web read (`Read`), where it happened: the page
 * last, a link, and how many more.
 */
export function Browsed({ pages, verb = "Browsed" }: { pages: readonly string[]; verb?: "Browsed" | "Read" }) {
	const Icon = verb === "Read" ? BookOpenIcon : GlobeIcon;
	const [first, ...rest] = pages;
	if (first === undefined) return null;
	let shown = first;
	try {
		const url = new URL(first);
		shown = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
	} catch {}
	// short of room the path gives way in its middle: the host and the page itself stay
	return (
		<span className="flex max-w-full items-center gap-2 rounded-full border border-line-soft px-3 py-1.5 text-meta text-ink-2">
			<Icon aria-hidden="true" className="size-3.5 shrink-0" />
			<span className="shrink-0">{verb}</span>
			<a
				href={first}
				target="_blank"
				rel="noreferrer noopener"
				className="flex min-w-0 text-ink underline decoration-line underline-offset-[3px] hover:decoration-ink"
			>
				<KeepEnd ends={pathEnds(shown)} whole={first} />
			</a>
			{rest.length === 0 ? null : <span className="shrink-0">+{rest.length} more</span>}
		</span>
	);
}
