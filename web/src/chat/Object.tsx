/**
 * Objects: things in a connection the owner recognises, drawn by the daemon from its own reading. GitHub's four: a
 * pull request, an issue, a check run, and a notification drawn as its subject with why it came.
 */

import type { LucideIcon } from "lucide-react";
import {
	CalendarIcon,
	ChevronDownIcon,
	CircleCheckIcon,
	CircleDashedIcon,
	CircleDotIcon,
	CircleSlashIcon,
	CircleXIcon,
	EllipsisIcon,
	ExternalLinkIcon,
	GitMergeIcon,
	GitPullRequestDraftIcon,
	GitPullRequestIcon,
	MailIcon,
	VideoIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { Tile } from "./Cards.tsx";

export type PullRequest = {
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly state: "open" | "draft" | "merged" | "closed" | "unknown";
	readonly author: string;
	readonly branch: string;
	readonly checks: { readonly passed: number; readonly failed: number; readonly running: number } | null;
	readonly reviews: string;
	readonly added: number | null;
	readonly removed: number | null;
	readonly url?: string | undefined;
	/** When the reading is over an hour old. */
	readonly asOf?: string | undefined;
};

const STATE = {
	unknown: { icon: CircleDashedIcon, word: "State unavailable" },
	open: { icon: GitPullRequestIcon, word: "Open" },
	draft: { icon: GitPullRequestDraftIcon, word: "Draft" },
	merged: { icon: GitMergeIcon, word: "Merged" },
	closed: { icon: CircleXIcon, word: "Closed" },
} as const;

export function GitHubMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className={cn("size-4 fill-ink", className)}>
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
		</svg>
	);
}

export function PullRequestCard({ pr, actions }: { pr: PullRequest; actions?: ReactNode }) {
	const { icon: Icon, word } = STATE[pr.state];
	const { passed, failed, running } = pr.checks ?? { passed: 0, failed: 0, running: 0 };
	const checks =
		pr.checks === null
			? { icon: CircleDashedIcon, words: "Unavailable", tone: "text-ink-2" }
			: passed + failed + running === 0
				? { icon: CircleDashedIcon, words: "None reported", tone: "text-ink-2" }
				: failed > 0
					? { icon: CircleXIcon, words: `${failed} failing, ${passed} passed`, tone: "text-danger" }
					: running > 0
						? { icon: CircleDotIcon, words: `${running} running, ${passed} passed`, tone: "text-ink-2" }
						: { icon: CircleCheckIcon, words: `${passed} passed`, tone: "text-ink-2" };
	return (
		<Tile className="flex flex-col gap-2.5 p-3.5">
			<Where
				asOf={pr.asOf}
				url={pr.url}
				actions={
					actions === undefined ? (
						<ObjectMenu
							name={`${pr.repo} #${pr.number}`}
							details={[
								["Repository", pr.repo],
								["Author", pr.author],
								["Branch", pr.branch],
							]}
						/>
					) : (
						actions
					)
				}
			>
				{pr.repo} #{pr.number}
			</Where>
			<span className="text-body font-semibold text-ink [overflow-wrap:anywhere]">
				{pr.title || "Title unavailable"}
			</span>
			<span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-2">
				<StatePill icon={Icon} word={word} live={pr.state === "open" || pr.state === "merged"} />
				<span className="min-w-0 max-w-full truncate" title={pr.author}>
					{pr.author || "Author unavailable"}
				</span>
				<span className="tabular-nums">
					{pr.added === null || pr.removed === null ? (
						"Diff unavailable"
					) : (
						<>
							<span className="text-alive">+{pr.added}</span> <span className="text-danger">−{pr.removed}</span>
						</>
					)}
				</span>
			</span>
			{pr.branch ? (
				<span data-object-branch="" className="block min-w-0 max-w-full truncate font-code text-meta text-ink-2">
					{pr.branch}
				</span>
			) : null}
			<span className="flex flex-col gap-1 border-t border-line-soft pt-2.5 text-meta">
				<span className={cn("flex items-center gap-1.5", checks.tone)}>
					<checks.icon className="size-3.5" />
					Checks: {checks.words}
				</span>
				<span className="text-ink-2">Reviews: {pr.reviews || "Unavailable"}</span>
			</span>
		</Tile>
	);
}

/** The line every object starts with: the service, where the thing lives, and how old the reading is. */
function Where({
	children,
	asOf,
	url,
	actions,
}: {
	children: ReactNode;
	asOf?: string | undefined;
	url?: string | undefined;
	actions?: ReactNode;
}) {
	const href = safeObjectUrl(url);
	return (
		<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-2">
			<GitHubMark className="size-3.5 shrink-0" />
			<span data-object-location="" className="min-w-0 flex-1 truncate">
				{children}
			</span>
			<span className="ml-auto flex shrink-0 items-center gap-2">
				{href === undefined ? null : (
					<a
						href={href}
						target="_blank"
						rel="noopener noreferrer"
						aria-label="Open on GitHub"
						className="-m-1 rounded-field p-1 text-ink-2 hover:bg-paper-3 hover:text-ink"
					>
						<ExternalLinkIcon className="size-3.5" />
					</a>
				)}
				{actions}
			</span>
			{asOf === undefined ? null : <span className="w-full">as of {asOf}</span>}
		</span>
	);
}

/** Quiet manual actions and full reading details, reachable by touch or keyboard. */
export function ObjectMenu({
	name,
	details,
	onRefresh,
	busy = false,
}: {
	name: string;
	details: readonly (readonly [string, string])[];
	onRefresh?: (() => void) | undefined;
	busy?: boolean | undefined;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`Actions for ${name}`}>
					<EllipsisIcon />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
				{onRefresh === undefined ? null : (
					<>
						<DropdownMenuGroup>
							<DropdownMenuItem disabled={busy} onSelect={onRefresh}>
								Refresh preview
							</DropdownMenuItem>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
					</>
				)}
				<DropdownMenuLabel>Preview details</DropdownMenuLabel>
				<dl className="flex flex-col gap-2 px-2 py-1 text-meta [overflow-wrap:anywhere]">
					{details
						.filter(([, value]) => value !== "")
						.map(([label, value]) => (
							<div key={label}>
								<dt className="text-muted-foreground">{label}</dt>
								<dd>{value}</dd>
							</div>
						))}
				</dl>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Only service URLs shipped by a connection are clickable; no daemon-relative links, credentials or lookalike hosts. */
export function safeObjectUrl(value: string | undefined): string | undefined {
	try {
		const url = new URL(value ?? "");
		const clean = url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "";
		if (!clean) return undefined;
		if (url.hostname === "github.com") return url.href;
		return undefined;
	} catch {
		return undefined;
	}
}

/** A reference in the owner's words, not another card. Inherit the bubble's ink in either theme. */
export function ObjectLink({
	object,
	href,
}: {
	object:
		| (PullRequest & { card: "pull-request" })
		| (Issue & { card: "issue" })
		| (CheckRun & { card: "check-run" })
		| (EmailMessage & { card: "email" })
		| (CalendarEvent & { card: "event" });
	href: string;
}) {
	if (object.card === "event") {
		const url = calendarUrl(href) ?? calendarUrl(object.url);
		return (
			<span data-object-inline="" className="inline-flex max-w-full items-baseline gap-1 align-baseline">
				<CalendarIcon aria-hidden="true" className="size-3.5 shrink-0 self-center" />
				{url === undefined ? (
					<span
						className={cn("min-w-0 truncate", object.status === "cancelled" && "line-through")}
						title={object.title}
					>
						{object.title || "Event"}
					</span>
				) : (
					<a
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						className={cn("min-w-0 max-w-80 truncate underline", object.status === "cancelled" && "line-through")}
						title={object.title}
					>
						{object.title || "Event"}
					</a>
				)}
			</span>
		);
	}
	if (object.card === "email") {
		const url = safeObjectUrl(href);
		return (
			<span data-object-inline="" className="inline-flex max-w-full items-baseline gap-1 align-baseline">
				<MailIcon aria-hidden="true" className="size-3.5 shrink-0 self-center" />
				{url === undefined ? (
					<span className="min-w-0 truncate">{object.subject || "Email"}</span>
				) : (
					<a
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						className="min-w-0 max-w-80 truncate underline"
						title={object.subject}
					>
						{object.subject || "Email"}
					</a>
				)}
			</span>
		);
	}
	const state =
		object.card === "pull-request"
			? STATE[object.state]
			: object.card === "issue"
				? ISSUE_STATE[object.state]
				: CHECK_STATE[object.state];
	const name = object.card === "check-run" ? object.name : object.title;
	const location = object.card === "check-run" ? object.repo : `${object.repo} #${object.number}`;
	const url = safeObjectUrl(href);
	const label = name || location;
	return (
		<span data-object-inline="" className="inline-flex max-w-full items-baseline gap-1 align-baseline">
			<GitHubMark className="size-3.5 shrink-0 self-center fill-current" />
			<state.icon aria-hidden="true" className="size-3.5 shrink-0 self-center" />
			{url === undefined ? (
				<span className="min-w-0 truncate" title={label}>
					{label}
				</span>
			) : (
				<a
					href={url}
					target="_blank"
					rel="noopener noreferrer"
					className="min-w-0 max-w-80 truncate"
					title={label}
					aria-label={`${label} on GitHub`}
				>
					{label}
				</a>
			)}
		</span>
	);
}

export type EmailMessage = {
	readonly from: string;
	readonly to: string;
	readonly subject: string;
	readonly date: string;
	readonly snippet: string;
	readonly body: string;
	readonly attachmentManifest?: string;
	readonly unread: boolean;
	readonly url?: string;
	readonly asOf?: string;
};

/** A read-only email card. The daemon supplies plain text only; HTML and remote resources are never rendered. */
export function EmailCard({
	message,
	actions,
	attachments,
}: {
	message: EmailMessage;
	actions?: ReactNode;
	attachments?: ReactNode;
}) {
	const url = safeObjectUrl(message.url);
	return (
		<Tile className="flex flex-col gap-2.5 p-3.5">
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-2">
				<MailIcon aria-hidden="true" className="size-3.5 shrink-0" />
				{url === undefined ? (
					<span className="min-w-0 flex-1 truncate">{message.from || "Sender unavailable"}</span>
				) : (
					<a href={url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate underline">
						{message.from || "Sender unavailable"}
					</a>
				)}
				{message.asOf === undefined ? null : <span>as of {message.asOf}</span>}
				<span className="ml-auto shrink-0">{actions}</span>
			</div>
			<div className="flex min-w-0 items-start gap-2">
				{message.unread ? (
					<span role="img" aria-label="Unread" className="mt-2 size-2 shrink-0 rounded-full bg-ink" />
				) : null}
				<h3 className="min-w-0 flex-1 text-body font-semibold text-ink [overflow-wrap:anywhere]">
					{message.subject || "(No subject)"}
				</h3>
			</div>
			<span className="text-meta text-ink-2">
				{message.date}
				{message.to ? ` · To ${message.to}` : ""}
			</span>
			<p className="whitespace-pre-wrap text-body text-ink [overflow-wrap:anywhere]">
				{message.body || message.snippet || "No plain text body"}
			</p>
			{attachments}
		</Tile>
	);
}

export type CalendarEvent = {
	readonly title: string;
	readonly start: string;
	readonly end: string;
	readonly allDay: boolean;
	readonly timeZone: string;
	readonly location: string;
	readonly organizer: string;
	readonly who: string;
	readonly attendees: number | null;
	readonly response: "accepted" | "declined" | "tentative" | "needs-action" | "none";
	readonly status: "confirmed" | "tentative" | "cancelled";
	readonly description: string;
	readonly meet?: string | undefined;
	readonly url?: string | undefined;
	readonly asOf?: string | undefined;
};

/** Only Google Calendar's own pages open from an event; the daemon already kept them https. */
function calendarUrl(value: string | undefined): string | undefined {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" &&
			url.port === "" &&
			url.username === "" &&
			url.password === "" &&
			(url.hostname === "www.google.com" || url.hostname === "calendar.google.com")
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

/** A call's address may be any https host a calendar names; the link says which, so a lookalike is visible. */
function callUrl(value: string | undefined): URL | undefined {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" && url.username === "" && url.password === "" ? url : undefined;
	} catch {
		return undefined;
	}
}

const RESPONSE: Record<CalendarEvent["response"], string | undefined> = {
	accepted: "Going",
	declined: "Declined",
	tentative: "Maybe",
	"needs-action": "Not answered",
	none: undefined,
};

/** A date the calendar gives without a time is a day where the owner is, not a UTC midnight. */
function dayOf(value: string): Date | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match === null) return undefined;
	const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return Number.isNaN(day.getTime()) ? undefined : day;
}

/** When an event is, in the owner's own time: "Mon, Nov 9 · 10:00 – 11:30", or its days for an all-day event. */
export function eventWhen(event: Pick<CalendarEvent, "start" | "end" | "allDay">): string {
	const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
	if (event.allDay) {
		const start = dayOf(event.start);
		const after = dayOf(event.end);
		if (start === undefined) return event.start;
		const last = after === undefined ? start : new Date(after.getFullYear(), after.getMonth(), after.getDate() - 1);
		return last.getTime() <= start.getTime()
			? `${day.format(start)} · All day`
			: `${day.format(start)} – ${day.format(last)} · All day`;
	}
	const start = new Date(event.start);
	const end = new Date(event.end);
	if (Number.isNaN(start.getTime())) return event.start;
	const hour = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
	if (Number.isNaN(end.getTime())) return `${day.format(start)} · ${hour.format(start)}`;
	return start.toDateString() === end.toDateString()
		? `${day.format(start)} · ${hour.format(start)} – ${hour.format(end)}`
		: `${day.format(start)} ${hour.format(start)} – ${day.format(end)} ${hour.format(end)}`;
}

/** A read-only event card: when, where, who, and the owner's answer. The description is plain text the daemon bounded. */
export function EventCard({ event, actions }: { event: CalendarEvent; actions?: ReactNode }) {
	const cancelled = event.status === "cancelled";
	const declined = event.response === "declined";
	const answer = RESPONSE[event.response];
	const open = calendarUrl(event.url);
	const call = callUrl(event.meet);
	return (
		<Tile className={cn("flex flex-col gap-2.5 p-3.5", (cancelled || declined) && "bg-paper-2")}>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-2">
				<CalendarIcon aria-hidden="true" className="size-3.5 shrink-0" />
				<span data-event-when="" className="min-w-0 flex-1 [overflow-wrap:anywhere]">
					{eventWhen(event)}
				</span>
				{event.asOf === undefined ? null : <span>as of {event.asOf}</span>}
				<span className="ml-auto shrink-0">{actions}</span>
			</div>
			<h3
				className={cn(
					"text-body font-semibold [overflow-wrap:anywhere]",
					cancelled || declined ? "text-ink-2" : "text-ink",
					cancelled && "line-through",
				)}
			>
				{event.title || "(No title)"}
			</h3>
			{cancelled || answer !== undefined || event.status === "tentative" ? (
				<span className="flex flex-wrap items-center gap-2 text-meta">
					{cancelled ? <StatePill icon={CircleSlashIcon} word="Cancelled" live={false} /> : null}
					{!cancelled && event.status === "tentative" ? (
						<StatePill icon={CircleDashedIcon} word="Tentative" live={false} />
					) : null}
					{answer === undefined ? null : (
						<span data-event-response={event.response} className={cn(declined ? "text-ink-2" : "text-ink")}>
							{answer}
						</span>
					)}
				</span>
			) : null}
			{event.location || event.organizer || event.who ? (
				<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-meta">
					{(
						[
							["Where", event.location],
							["Organizer", event.organizer],
							["Guests", event.who],
						] as const
					)
						.filter(([, value]) => value !== "")
						.map(([label, value]) => (
							<div key={label} className="contents">
								<dt className="text-ink-2">{label}</dt>
								<dd className="text-ink [overflow-wrap:anywhere]">{value}</dd>
							</div>
						))}
				</dl>
			) : null}
			{event.description === "" ? null : (
				<Collapsible className="border-t border-line-soft pt-2">
					<CollapsibleTrigger asChild>
						<Button variant="ghost" size="xs" className="group -ml-2 text-ink-2">
							Description
							<ChevronDownIcon className="group-data-[state=open]:rotate-180" data-icon="inline-end" />
						</Button>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<p className="whitespace-pre-wrap pt-1 text-body text-ink [overflow-wrap:anywhere]">{event.description}</p>
					</CollapsibleContent>
				</Collapsible>
			)}
			{call === undefined && open === undefined ? null : (
				<span className="flex flex-wrap items-center gap-2">
					{call === undefined || cancelled ? null : (
						<Button asChild size="sm">
							<a href={call.href} target="_blank" rel="noopener noreferrer" title={call.href}>
								<VideoIcon />
								Join{call.hostname === "meet.google.com" ? "" : ` on ${call.hostname}`}
							</a>
						</Button>
					)}
					{open === undefined ? null : (
						<Button asChild size="sm" variant="ghost">
							<a href={open} target="_blank" rel="noopener noreferrer">
								<ExternalLinkIcon />
								Open in Google Calendar
							</a>
						</Button>
					)}
				</span>
			)}
		</Tile>
	);
}

/** An explicit name is still a message when the daemon cannot recognise or authorise its preview. */
export function ObjectReference({ reference }: { reference: string }) {
	const href = safeObjectUrl(reference);
	return (
		<Tile className="p-3.5 [overflow-wrap:anywhere]">
			{href === undefined ? (
				<p className="text-body text-ink">{reference}</p>
			) : (
				<a href={href} target="_blank" rel="noopener noreferrer" className="text-body text-ink underline">
					{reference}
				</a>
			)}
			<p className="text-meta text-ink-2">Preview unavailable</p>
		</Tile>
	);
}

/** A state as a pill: filled ink when the thing is live, quiet when it is over. */
function StatePill({ icon: Icon, word, live }: { icon: LucideIcon; word: string; live: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium",
				live ? "bg-ink text-paper" : "bg-paper-3 text-ink",
			)}
		>
			<Icon className="size-3.5" />
			{word}
		</span>
	);
}

export type Issue = {
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly state: "open" | "completed" | "not-planned" | "unknown";
	readonly author: string;
	readonly labels: readonly string[];
	readonly comments: number | null;
	readonly url?: string | undefined;
	readonly assignee?: string | undefined;
	readonly asOf?: string | undefined;
};

const ISSUE_STATE = {
	unknown: { icon: CircleDashedIcon, word: "State unavailable", live: false },
	open: { icon: CircleDotIcon, word: "Open", live: true },
	completed: { icon: CircleCheckIcon, word: "Closed", live: false },
	"not-planned": { icon: CircleSlashIcon, word: "Not planned", live: false },
} as const;

export function IssueCard({ issue, actions }: { issue: Issue; actions?: ReactNode }) {
	const state = ISSUE_STATE[issue.state];
	return (
		<Tile className="flex flex-col gap-2.5 p-3.5">
			<Where
				asOf={issue.asOf}
				url={issue.url}
				actions={
					actions === undefined ? (
						<ObjectMenu
							name={`${issue.repo} #${issue.number}`}
							details={[
								["Repository", issue.repo],
								["Author", issue.author],
							]}
						/>
					) : (
						actions
					)
				}
			>
				{issue.repo} #{issue.number}
			</Where>
			<span className="text-body font-semibold text-ink [overflow-wrap:anywhere]">
				{issue.title || "Title unavailable"}
			</span>
			<span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-meta text-ink-2">
				<StatePill {...state} />
				<span>{issue.author ? `opened by ${issue.author}` : "Author unavailable"}</span>
				{[...new Set(issue.labels)].map((label) => (
					<span key={label} className="rounded-full border border-line px-2 py-px text-ink-2">
						{label}
					</span>
				))}
			</span>
			<span className="flex flex-wrap gap-3 border-t border-line-soft pt-2.5 text-meta text-ink-2">
				<span>{issue.assignee === undefined ? "Assignee not reported" : `Assigned to ${issue.assignee}`}</span>
				<span className="tabular-nums">
					{issue.comments === null
						? "Comments unavailable"
						: `${issue.comments} ${issue.comments === 1 ? "comment" : "comments"}`}
				</span>
			</span>
		</Tile>
	);
}

export type CheckRun = {
	readonly repo: string;
	readonly pr?: number;
	readonly where?: string | undefined;
	readonly url?: string | undefined;
	readonly name: string;
	readonly state: "queued" | "running" | "passed" | "failed" | "unknown" | "cancelled" | "skipped" | "neutral";
	/** The step that failed, or runs now. */
	readonly step?: string | undefined;
	readonly took?: string | undefined;
	/** The end of the failing step's log: the daemon's reading, a few lines. */
	readonly log?: readonly string[] | undefined;
	readonly asOf?: string | undefined;
};

const CHECK_STATE = {
	unknown: { icon: CircleDashedIcon, word: "State unavailable", tone: "text-ink-2" },
	cancelled: { icon: CircleSlashIcon, word: "Cancelled", tone: "text-ink-2" },
	skipped: { icon: CircleSlashIcon, word: "Skipped", tone: "text-ink-2" },
	neutral: { icon: CircleDashedIcon, word: "Neutral", tone: "text-ink-2" },
	queued: { icon: CircleDashedIcon, word: "Queued", tone: "text-ink-2" },
	running: { icon: CircleDotIcon, word: "Running", tone: "text-ink" },
	passed: { icon: CircleCheckIcon, word: "Passed", tone: "text-ink" },
	failed: { icon: CircleXIcon, word: "Failed", tone: "text-danger" },
} as const;

export function CheckRunCard({ run, actions }: { run: CheckRun; actions?: ReactNode }) {
	const state = CHECK_STATE[run.state];
	return (
		<Tile className="flex flex-col gap-2.5 p-3.5">
			<Where
				asOf={run.asOf}
				url={run.url}
				actions={
					actions === undefined ? (
						<ObjectMenu
							name={run.name}
							details={[
								["Repository", run.repo],
								["Check", run.name],
								["Where", run.where ?? ""],
							]}
						/>
					) : (
						actions
					)
				}
			>
				{run.repo}
				{run.pr === undefined ? "" : ` #${run.pr}`} · {run.where ?? "checks"}
			</Where>
			<span className="flex items-center gap-2">
				<state.icon
					className={cn(
						"size-4 shrink-0",
						state.tone,
						run.state === "running" && "animate-pulse motion-reduce:animate-none",
					)}
				/>
				<span className="min-w-0 flex-1 truncate font-code text-ui font-medium text-ink">{run.name}</span>
				<span className={cn("text-meta font-medium", state.tone)}>{state.word}</span>
			</span>
			{run.step === undefined && run.took === undefined ? null : (
				<span className="text-meta text-ink-2">
					{[run.step === undefined ? undefined : `${run.state === "running" ? "Now" : "At"}: ${run.step}`, run.took]
						.filter(Boolean)
						.join(" · ")}
				</span>
			)}
			{run.log === undefined ? null : (
				<pre className="m-0 overflow-x-auto rounded-field bg-paper-2 px-3 py-2.5 font-code text-meta leading-relaxed text-ink">
					{run.log.join("\n")}
				</pre>
			)}
		</Tile>
	);
}

/** Why a notification came, in GitHub's terms, said plainly. */
export type Reason = "review-requested" | "mention" | "assigned" | "ci" | "comment" | "activity";
const REASON: Record<Reason, string> = {
	activity: "New activity",
	"review-requested": "Your review was requested",
	mention: "You were mentioned",
	assigned: "You were assigned",
	ci: "A check failed on your pull request",
	comment: "New comments",
};

/** A notification is its subject, under why it came; unread until the owner or the agent marks it done. */
export function NotificationCard({
	reason,
	when,
	unread = true,
	actions,
	children,
}: {
	reason: Reason;
	when: string;
	unread?: boolean;
	actions?: ReactNode;
	/** The subject: a pull request, an issue, a check run. */
	children: ReactNode;
}) {
	return (
		<div className="flex w-full max-w-[var(--measure)] flex-col gap-1.5">
			<span className="flex flex-wrap items-center gap-2 px-1 text-meta text-ink-2">
				{unread ? <span role="img" aria-label="Unread" className="size-1.5 rounded-full bg-ink" /> : null}
				<span className={cn(unread && "font-medium text-ink")}>{REASON[reason]}</span>
				{when === "" ? null : <span>· {when}</span>}
				<span className="ml-auto shrink-0">{actions}</span>
			</span>
			{children}
		</div>
	);
}
