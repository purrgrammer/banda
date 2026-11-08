/**
 * Objects: things in a connection the owner recognises, drawn by the daemon from its own reading. GitHub's: a pull
 * request, an issue, a check run, a discussion, a repository, and a notification drawn as its subject with why it came.
 */

import type { LucideIcon } from "lucide-react";
import {
	BookMarkedIcon,
	CalendarIcon,
	ChevronDownIcon,
	CircleCheckIcon,
	CircleDashedIcon,
	CircleDotIcon,
	CircleSlashIcon,
	CircleXIcon,
	CornerDownRightIcon,
	EllipsisIcon,
	ExternalLinkIcon,
	FileIcon,
	FileTextIcon,
	FileTypeIcon,
	FolderIcon,
	GitCommitHorizontalIcon,
	GitMergeIcon,
	GitPullRequestDraftIcon,
	GitPullRequestIcon,
	ImageIcon,
	MailIcon,
	MailsIcon,
	MessagesSquareIcon,
	PhoneIcon,
	PresentationIcon,
	SearchIcon,
	SheetIcon,
	TagIcon,
	UserRoundIcon,
	VideoIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { sizeOf } from "../lib/size.ts";
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

/** One pull request or issue a repository's card names: the newest of each. */
export type Opened = {
	readonly number: number;
	readonly title: string;
	readonly author: string;
	readonly state: "open" | "draft" | "merged" | "closed";
};

export type Repository = {
	/** `owner/repo`. */
	readonly repo: string;
	/** The newest published release's tag, and when (ms). */
	readonly release?: string | undefined;
	readonly released?: number | undefined;
	/** The default branch's head: its first line, short sha and when (ms). */
	readonly commit?: string | undefined;
	readonly sha?: string | undefined;
	readonly committed?: number | undefined;
	readonly pull?: Opened | undefined;
	readonly issue?: Opened | undefined;
	readonly url?: string | undefined;
	readonly asOf?: string | undefined;
};

const OPENED_ISSUE = { open: CircleDotIcon, draft: CircleDotIcon, merged: CircleCheckIcon, closed: CircleCheckIcon };
const day = (at: number | undefined) =>
	at === undefined ? undefined : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });

/** A repository: what is newest in it, one line each; what it lacks is said, never left blank. */
export function RepositoryCard({ repository, actions }: { repository: Repository; actions?: ReactNode }) {
	const { pull, issue } = repository;
	const PullIcon = pull === undefined ? GitPullRequestIcon : STATE[pull.state].icon;
	const IssueIcon = issue === undefined ? CircleDotIcon : OPENED_ISSUE[issue.state];
	const rows: { key: string; icon: LucideIcon; words: ReactNode; title?: string | undefined }[] = [
		{
			key: "release",
			icon: TagIcon,
			words:
				repository.release === undefined ? (
					"No releases"
				) : (
					<>
						Released <span className="font-code text-ink">{repository.release}</span>
						{repository.released === undefined ? null : ` · ${day(repository.released)}`}
					</>
				),
		},
		{
			key: "commit",
			icon: GitCommitHorizontalIcon,
			title: repository.commit,
			words:
				repository.commit === undefined ? (
					"No commits"
				) : (
					<>
						{repository.sha === undefined ? null : <span className="font-code text-ink-2">{repository.sha} </span>}
						<span className="text-ink">{repository.commit}</span>
						{repository.committed === undefined ? null : ` · ${day(repository.committed)}`}
					</>
				),
		},
		{
			key: "pull",
			icon: PullIcon,
			title: pull?.title,
			words:
				pull === undefined ? (
					"No pull requests"
				) : (
					<>
						<span className="tabular-nums">#{pull.number}</span> <span className="text-ink">{pull.title}</span>
						{pull.author === "" ? null : ` · ${pull.author}`}
					</>
				),
		},
		{
			key: "issue",
			icon: IssueIcon,
			title: issue?.title,
			words:
				issue === undefined ? (
					"No issues"
				) : (
					<>
						<span className="tabular-nums">#{issue.number}</span> <span className="text-ink">{issue.title}</span>
						{issue.author === "" ? null : ` · ${issue.author}`}
					</>
				),
		},
	];
	return (
		<Tile className="flex flex-col gap-2.5 p-3.5">
			<Where
				asOf={repository.asOf}
				url={repository.url}
				actions={
					actions === undefined ? (
						<ObjectMenu name={repository.repo} details={[["Repository", repository.repo]]} />
					) : (
						actions
					)
				}
			>
				Repository
			</Where>
			<span className="flex min-w-0 items-center gap-2">
				<BookMarkedIcon aria-hidden="true" className="size-4 shrink-0 text-ink-2" />
				<span className="min-w-0 truncate text-body font-semibold text-ink" title={repository.repo}>
					{repository.repo}
				</span>
			</span>
			<span className="flex flex-col gap-1.5 border-t border-line-soft pt-2.5 text-meta text-ink-2">
				{rows.map((row) => (
					<span key={row.key} data-repository-row={row.key} className="flex min-w-0 items-center gap-1.5">
						<row.icon aria-hidden="true" className="size-3.5 shrink-0" />
						<span className="min-w-0 truncate" title={row.title}>
							{row.words}
						</span>
					</span>
				))}
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

/**
 * How an object can be followed from its card (DESIGN.md "Watches"): the words for what ends a watch; none for a kind
 * nothing ends (a contact), followed until the owner stops it.
 */
export type FollowOffer = {
	/** None: it never ends (a search), and is followed until the owner stops it. */
	readonly ends: readonly string[];
	/** Follow it, until the end named, or any of them. */
	readonly onFollow: (until?: string) => void;
};

/** Quiet manual actions and full reading details, reachable by touch or keyboard. */
export function ObjectMenu({
	name,
	details,
	onRefresh,
	follow,
	busy = false,
}: {
	name: string;
	details: readonly (readonly [string, string])[];
	onRefresh?: (() => void) | undefined;
	/** Offered when the kind can be followed and no watch of this agent follows it yet. */
	follow?: FollowOffer | undefined;
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
				{onRefresh === undefined && follow === undefined ? null : (
					<>
						<DropdownMenuGroup>
							{onRefresh === undefined ? null : (
								<DropdownMenuItem disabled={busy} onSelect={onRefresh}>
									Refresh preview
								</DropdownMenuItem>
							)}
							{follow === undefined
								? null
								: follow.ends.length === 0
									? [
											<DropdownMenuItem key="follow" disabled={busy} onSelect={() => follow.onFollow()}>
												Follow
											</DropdownMenuItem>,
										]
									: [
											...follow.ends.map((end) => (
												<DropdownMenuItem key={end} disabled={busy} onSelect={() => follow.onFollow(end)}>
													Follow until {end}
												</DropdownMenuItem>
											)),
											...(follow.ends.length > 1
												? [
														<DropdownMenuItem key="any" disabled={busy} onSelect={() => follow.onFollow()}>
															Follow until {follow.ends.join(" or ")}
														</DropdownMenuItem>,
													]
												: []),
										]}
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

/** A Gmail address worth linking: `mail.google.com` over https, nothing else. */
function gmailUrl(value: string | undefined): string | undefined {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" &&
			url.port === "" &&
			url.username === "" &&
			url.password === "" &&
			url.hostname === "mail.google.com"
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

/** A Slack page worth linking: the team's own host, `<team>.slack.com`, over https, nothing else. */
export function slackUrl(value: string | undefined): string | undefined {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" &&
			url.port === "" &&
			url.username === "" &&
			url.password === "" &&
			/^[a-z0-9-]{1,63}\.slack\.com$/.test(url.hostname)
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * An object named inline is a link wherever it has an address, drawn the same whatever the service: the words, a
 * subtle underline that darkens on hover; without an address, the words alone.
 */
// a title's width is capped short of a phone's screen, so what follows it on a line (a colon, a time) stays beside it
const INLINE_LINK =
	"min-w-0 max-w-[min(20rem,calc(100vw-6rem))] truncate underline decoration-line underline-offset-2 hover:decoration-ink";
const INLINE_TEXT = "min-w-0 max-w-[min(20rem,calc(100vw-6rem))] truncate";

/** A reference in the owner's words, not another card. Inherit the bubble's ink in either theme. */
export function ObjectLink({
	object,
	href,
}: {
	object:
		| (PullRequest & { card: "pull-request" })
		| (Issue & { card: "issue" })
		| (CheckRun & { card: "check-run" })
		| (Discussion & { card: "discussion" })
		| (Repository & { card: "repository" })
		| (EmailMessage & { card: "email" })
		| (Messages & { card: "messages" })
		| (CalendarEvent & { card: "event" })
		| (Person & { card: "contact" })
		| (DriveFile & { card: "file" });
	href: string;
}) {
	if (object.card === "messages") {
		const slack = object.service === "slack";
		// a link to a reply names its thread (one object, one card), but the reference says the reply, in its own words
		const linked = slack && object.place === "thread" ? slackLinked(href) : undefined;
		const reply = linked?.reply ? object.messages.find((each) => each.id === linked.ts) : undefined;
		const Icon = slack
			? linked?.reply
				? CornerDownRightIcon
				: slackListIcon(object)
			: object.search
				? SearchIcon
				: MailsIcon;
		const title = linked?.reply ? reply?.text || `Reply in ${object.channel ?? "a thread"}` : object.title;
		const url = slack ? (slackUrl(href) ?? slackUrl(object.url)) : (gmailUrl(href) ?? gmailUrl(object.url));
		return (
			<span
				data-object-inline=""
				{...(linked?.reply ? { "data-slack-reply": "" } : {})}
				className="inline-flex max-w-full items-baseline gap-1 align-baseline"
			>
				{slack ? <SlackMark className="self-center" /> : null}
				{Icon === undefined ? null : <Icon aria-hidden="true" className="size-3.5 shrink-0 self-center" />}
				{url === undefined ? (
					<span className={INLINE_TEXT} title={title}>
						{title}
					</span>
				) : (
					<a href={url} target="_blank" rel="noopener noreferrer" className={INLINE_LINK} title={title}>
						{title}
					</a>
				)}
			</span>
		);
	}
	if (object.card === "file") {
		const Icon = FILE_KIND[object.kind].icon;
		const url = driveUrl(href) ?? driveUrl(object.url);
		const name = object.name || "File";
		return (
			<span data-object-inline="" className="inline-flex max-w-full items-baseline gap-1 align-baseline">
				<Icon aria-hidden="true" className="size-3.5 shrink-0 self-center" />
				{url === undefined ? (
					<span className={INLINE_TEXT} title={name}>
						{name}
					</span>
				) : (
					<a href={url} target="_blank" rel="noopener noreferrer" className={INLINE_LINK} title={name}>
						{name}
					</a>
				)}
			</span>
		);
	}
	if (object.card === "contact") {
		const url =
			object.service === "slack"
				? (slackUrl(href) ?? slackUrl(object.url))
				: (contactsUrl(href) ?? contactsUrl(object.url));
		return (
			<span data-object-inline="" className="inline-flex max-w-full items-baseline gap-1 align-baseline">
				{object.service === "slack" ? <SlackMark className="self-center" /> : null}
				<UserRoundIcon aria-hidden="true" className="size-3.5 shrink-0 self-center" />
				{url === undefined ? (
					<span className={INLINE_TEXT} title={object.name}>
						{object.name}
					</span>
				) : (
					<a href={url} target="_blank" rel="noopener noreferrer" className={INLINE_LINK} title={object.name}>
						{object.name}
					</a>
				)}
			</span>
		);
	}
	if (object.card === "event") {
		const url = calendarUrl(href) ?? calendarUrl(object.url);
		const struck = object.status === "cancelled" && "line-through";
		return (
			<span data-object-inline="" className="inline-flex max-w-full items-baseline gap-1 align-baseline">
				<CalendarIcon aria-hidden="true" className="size-3.5 shrink-0 self-center" />
				{url === undefined ? (
					<span className={cn(INLINE_TEXT, struck)} title={object.title}>
						{object.title || "Event"}
					</span>
				) : (
					<a
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						className={cn(INLINE_LINK, struck)}
						title={object.title}
					>
						{object.title || "Event"}
					</a>
				)}
			</span>
		);
	}
	if (object.card === "email") {
		const url = gmailUrl(href) ?? gmailUrl(object.url);
		return (
			<span data-object-inline="" className="inline-flex max-w-full items-baseline gap-1 align-baseline">
				<MailIcon aria-hidden="true" className="size-3.5 shrink-0 self-center" />
				{url === undefined ? (
					<span className={INLINE_TEXT} title={object.subject}>
						{object.subject || "Email"}
					</span>
				) : (
					<a href={url} target="_blank" rel="noopener noreferrer" className={INLINE_LINK} title={object.subject}>
						{object.subject || "Email"}
					</a>
				)}
			</span>
		);
	}
	const state =
		object.card === "repository"
			? { icon: BookMarkedIcon }
			: object.card === "pull-request"
				? STATE[object.state]
				: object.card === "issue"
					? ISSUE_STATE[object.state]
					: object.card === "discussion"
						? DISCUSSION_STATE[object.state]
						: CHECK_STATE[object.state];
	const name = object.card === "check-run" ? object.name : object.card === "repository" ? object.repo : object.title;
	const location =
		object.card === "check-run" || object.card === "repository" ? object.repo : `${object.repo} #${object.number}`;
	const url = safeObjectUrl(href);
	const label = name || location;
	return (
		<span data-object-inline="" className="inline-flex max-w-full items-baseline gap-1 align-baseline">
			<GitHubMark className="size-3.5 shrink-0 self-center fill-current" />
			<state.icon aria-hidden="true" className="size-3.5 shrink-0 self-center" />
			{url === undefined ? (
				<span className={INLINE_TEXT} title={label}>
					{label}
				</span>
			) : (
				<a
					href={url}
					target="_blank"
					rel="noopener noreferrer"
					className={INLINE_LINK}
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
	const url = gmailUrl(message.url);
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

export type Messages = {
	readonly title: string;
	/** A search's: its title is the query. */
	readonly search: boolean;
	/** The newest few, newest first. */
	readonly messages: readonly {
		readonly id: string;
		readonly from: string;
		readonly subject: string;
		readonly date: string;
		/** A Slack message's words; an email has its subject. */
		readonly text?: string | undefined;
	}[];
	readonly total: number | null;
	/** Where it opens: in Gmail, the conversation or the search; in Slack, the thread or the channel. */
	readonly url?: string | undefined;
	readonly asOf?: string | undefined;
	/** A Slack thread, channel (its topic and members) or search. */
	readonly service?: "slack" | undefined;
	readonly place?: "thread" | "channel" | undefined;
	/** A thread's channel, `#general`, when the title is the thread's first message. */
	readonly channel?: string | undefined;
	readonly topic?: string | undefined;
	readonly members?: number | null | undefined;
};

/** When a Slack message was written, as a short local time: today's by the clock, an older one by its day. */
export function slackWhen(iso: string, now = new Date()): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "";
	const sameDay = at.toDateString() === now.toDateString();
	return sameDay
		? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: at.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * The message a Slack link points at, and whether it is a reply: a reply's link carries its thread's first message as
 * `thread_ts`, and names a message other than it.
 */
function slackLinked(href: string): { readonly ts: string; readonly reply: boolean } | undefined {
	const url = slackUrl(href);
	if (url === undefined) return undefined;
	const parsed = new URL(url);
	const packed = /\/p(\d{9,11})(\d{6})$/.exec(parsed.pathname);
	if (packed === null) return undefined;
	const ts = `${packed[1]}.${packed[2]}`;
	const root = parsed.searchParams.get("thread_ts");
	return { ts, reply: root !== null && root !== ts };
}

/** Slack's own mark, beside a type icon, so a reference or a card reads as Slack's at a glance. */
export function SlackMark({ className }: { className?: string }) {
	return <img src="/connections/slack.svg" alt="" aria-hidden="true" className={cn("size-3.5 shrink-0", className)} />;
}

/**
 * The icon beside Slack's mark for a list's kind: a thread's bubbles, a search's glass; a channel has none, since its
 * name carries its hash.
 */
const slackListIcon = (list: Pick<Messages, "search" | "place">): LucideIcon | undefined =>
	list.search ? SearchIcon : list.place === "channel" ? undefined : MessagesSquareIcon;

/**
 * A Slack channel as a place, not a transcript: Slack's mark, its name with how many are in it on one line, its topic
 * beneath, and Open in Slack, laid out as a Drive file's card is. Its messages are read for the agent and for a watch,
 * never listed here.
 */
function SlackChannelCard({ list, actions }: { list: Messages; actions?: ReactNode }) {
	const url = slackUrl(list.url);
	const members =
		list.members === null || list.members === undefined
			? undefined
			: `${list.members} member${list.members === 1 ? "" : "s"}`;
	return (
		<Tile className="flex flex-col gap-2.5 p-3.5" data-slack-card="channel">
			<div className="flex min-w-0 items-start gap-2.5">
				<SlackMark className="mt-0.5 size-5" />
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
						<h3 className="min-w-0 text-body font-semibold text-ink [overflow-wrap:anywhere]">{list.title}</h3>
						{members === undefined ? null : <span className="shrink-0 text-meta text-ink-2">{members}</span>}
					</div>
					{list.topic ? <p className="text-meta text-ink-2 [overflow-wrap:anywhere]">{list.topic}</p> : null}
				</div>
				{list.asOf === undefined ? null : <span className="shrink-0 text-meta text-ink-2">as of {list.asOf}</span>}
				<span className="shrink-0">{actions}</span>
			</div>
			{url === undefined ? null : (
				<span className="flex flex-wrap items-center gap-2">
					<Button asChild size="sm" variant="ghost" className="-ml-2">
						<a href={url} target="_blank" rel="noopener noreferrer">
							<ExternalLinkIcon />
							Open in Slack
						</a>
					</Button>
				</span>
			)}
		</Tile>
	);
}

/** Slack's messages together, read-only: a thread under its first words in its channel, or a search under its query. */
function SlackMessagesCard({ list, actions }: { list: Messages; actions?: ReactNode }) {
	if (!list.search && list.place === "channel") return <SlackChannelCard list={list} actions={actions} />;
	const Icon = slackListIcon(list);
	const more = list.total === null ? 0 : list.total - list.messages.length;
	const url = slackUrl(list.url);
	const where = list.search ? "Messages matching" : `Thread${list.channel ? ` in ${list.channel}` : ""}`;
	return (
		<Tile className="flex flex-col gap-2.5 p-3.5" data-slack-card={list.search ? "search" : (list.place ?? "thread")}>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-2">
				<SlackMark />
				{Icon === undefined ? null : <Icon aria-hidden="true" className="size-3.5 shrink-0" />}
				<span className="min-w-0 flex-1 truncate">{where}</span>
				{list.asOf === undefined ? null : <span>as of {list.asOf}</span>}
				<span className="ml-auto shrink-0">{actions}</span>
			</div>
			<h3
				className={cn(
					"min-w-0 text-body font-semibold text-ink [overflow-wrap:anywhere]",
					list.search && "font-mono font-normal",
					list.place === "thread" && "line-clamp-2",
				)}
			>
				{list.title}
			</h3>
			{list.messages.length === 0 ? (
				<p className="text-meta text-ink-2">{list.search ? "No messages match yet" : "No messages"}</p>
			) : (
				<ul className="flex flex-col divide-y divide-border">
					{list.messages.map((message) => (
						<li key={message.id} className="flex min-w-0 flex-col gap-0.5 py-1.5 first:pt-0 last:pb-0">
							<span className="flex min-w-0 items-baseline gap-2 text-meta text-ink-2">
								<span className="min-w-0 flex-1 truncate" title={message.from}>
									{message.from || "Someone"}
								</span>
								<span className="shrink-0">{slackWhen(message.date)}</span>
							</span>
							<span className="min-w-0 text-body text-ink line-clamp-2 [overflow-wrap:anywhere]" title={message.text}>
								{message.text || "(No text)"}
							</span>
						</li>
					))}
				</ul>
			)}
			{more > 0 || url !== undefined ? (
				<span className="flex flex-wrap items-center gap-2">
					{more > 0 ? (
						<span className="text-meta text-ink-2">{list.search ? `About ${more} more` : `${more} more`}</span>
					) : null}
					{url === undefined ? null : (
						<Button asChild size="sm" variant="ghost" className="ml-auto">
							<a href={url} target="_blank" rel="noopener noreferrer">
								<ExternalLinkIcon />
								Open in Slack
							</a>
						</Button>
					)}
				</span>
			) : null}
		</Tile>
	);
}

/** Emails together, read-only: a conversation under its subject, or a search under its query, the newest few first. */
export function MessagesCard({ list, actions }: { list: Messages; actions?: ReactNode }) {
	if (list.service === "slack") return <SlackMessagesCard list={list} actions={actions} />;
	const Icon = list.search ? SearchIcon : MailsIcon;
	const more = list.total === null ? 0 : list.total - list.messages.length;
	return (
		<Tile className="flex flex-col gap-2.5 p-3.5">
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-2">
				<Icon aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="min-w-0 flex-1 truncate">{list.search ? "Mail matching" : "Conversation"}</span>
				{list.asOf === undefined ? null : <span>as of {list.asOf}</span>}
				<span className="ml-auto shrink-0">{actions}</span>
			</div>
			<h3
				className={cn(
					"min-w-0 text-body font-semibold text-ink [overflow-wrap:anywhere]",
					list.search && "font-mono font-normal",
				)}
			>
				{list.title}
			</h3>
			{list.messages.length === 0 ? (
				<p className="text-meta text-ink-2">{list.search ? "No mail matches yet" : "No messages"}</p>
			) : (
				<ul className="flex flex-col divide-y divide-border">
					{list.messages.map((message) => (
						<li key={message.id} className="flex min-w-0 flex-col gap-0.5 py-1.5 first:pt-0 last:pb-0">
							<span className="flex min-w-0 items-baseline gap-2 text-meta text-ink-2">
								<span className="min-w-0 flex-1 truncate" title={message.from}>
									{message.from || "Sender unavailable"}
								</span>
								<span className="shrink-0">{message.date}</span>
							</span>
							<span className="min-w-0 truncate text-body text-ink" title={message.subject}>
								{message.subject || "(No subject)"}
							</span>
						</li>
					))}
				</ul>
			)}
			{more > 0 ? (
				<span className="text-meta text-ink-2">{list.search ? `About ${more} more` : `${more} earlier`}</span>
			) : null}
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
/** The video call services a Join button may open; a link from an invitation to any other host is not one. */
const CALL_HOSTS = ["meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com", "webex.com", "whereby.com"];

export function callUrl(value: string | undefined): URL | undefined {
	try {
		const url = new URL(value ?? "");
		const known = CALL_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
		return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && known
			? url
			: undefined;
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
	const answer = cancelled ? undefined : RESPONSE[event.response];
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

export type Person = {
	readonly name: string;
	/** Comma-separated, the primary first. */
	readonly emails: string;
	readonly phones: string;
	readonly organization: string;
	readonly title: string;
	/** From the people the owner has emailed, not a saved contact. */
	readonly other: boolean;
	readonly photo?: string | undefined;
	readonly url?: string | undefined;
	readonly asOf?: string | undefined;
	/** A person in Slack: their handle, status and time zone, and whether they are of another team. */
	readonly service?: "slack" | undefined;
	readonly handle?: string | undefined;
	readonly status?: string | undefined;
	readonly timezone?: string | undefined;
	readonly outside?: boolean | undefined;
};

/** Only Google Contacts' own pages open from a person. */
function contactsUrl(value: string | undefined): string | undefined {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" &&
			url.port === "" &&
			url.username === "" &&
			url.password === "" &&
			url.hostname === "contacts.google.com"
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

const initialsOf = (name: string) =>
	(name.split("@")[0] ?? "")
		.split(/[\s._-]+/)
		.filter((word) => /^\p{L}/u.test(word))
		.slice(0, 2)
		.map((word) => [...word][0]?.toUpperCase())
		.join("");

const listOf = (value: string) =>
	value
		.split(",")
		.map((each) => each.trim())
		.filter(Boolean);

/** A read-only person card: who, where they work, and their addresses and numbers as links that start an email or call. */
export function ContactCard({ person, actions }: { person: Person; actions?: ReactNode }) {
	const slack = person.service === "slack";
	const open = slack ? slackUrl(person.url) : contactsUrl(person.url);
	const work = [slack ? person.handle : undefined, person.title, person.organization].filter(Boolean).join(" · ");
	const about = slack ? [person.status, person.timezone].filter(Boolean).join(" · ") : "";
	const initials = initialsOf(person.name);
	return (
		<Tile className="flex flex-col gap-2.5 p-3.5">
			<div className="flex min-w-0 items-center gap-3">
				<Avatar size="lg">
					{person.photo === undefined ? null : <AvatarImage src={person.photo} alt="" referrerPolicy="no-referrer" />}
					<AvatarFallback>{initials || <UserRoundIcon aria-hidden="true" className="size-4" />}</AvatarFallback>
				</Avatar>
				<div className="flex min-w-0 flex-1 flex-col">
					<h3 className="text-body font-semibold text-ink [overflow-wrap:anywhere]">{person.name}</h3>
					{work === "" ? null : <span className="text-meta text-ink-2 [overflow-wrap:anywhere]">{work}</span>}
				</div>
				{person.asOf === undefined ? null : <span className="text-meta text-ink-2">as of {person.asOf}</span>}
				<span className="shrink-0 self-start">{actions}</span>
			</div>
			{person.emails || person.phones ? (
				<ul className="flex flex-col gap-1 text-meta">
					{listOf(person.emails).map((email) => (
						<li key={email} className="flex min-w-0 items-center gap-2">
							<MailIcon aria-hidden="true" className="size-3.5 shrink-0 text-ink-2" />
							{/^[^\s@,;?&#/]+@[^\s@,;?&#/]+$/.test(email) ? (
								<a href={`mailto:${email}`} className="min-w-0 text-ink underline [overflow-wrap:anywhere]">
									{email}
								</a>
							) : (
								<span className="min-w-0 text-ink [overflow-wrap:anywhere]">{email}</span>
							)}
						</li>
					))}
					{listOf(person.phones).map((phone) => (
						<li key={phone} className="flex min-w-0 items-center gap-2">
							<PhoneIcon aria-hidden="true" className="size-3.5 shrink-0 text-ink-2" />
							<a
								href={`tel:${phone.replace(/[^\d+*#]/g, "")}`}
								className="min-w-0 text-ink underline [overflow-wrap:anywhere]"
							>
								{phone}
							</a>
						</li>
					))}
				</ul>
			) : null}
			{about === "" ? null : <span className="text-meta text-ink-2 [overflow-wrap:anywhere]">{about}</span>}
			{person.other ? (
				<span data-contact-other="" className="text-meta text-ink-2">
					From people you've emailed
				</span>
			) : null}
			{person.outside === true ? (
				<span data-contact-outside="" className="text-meta text-ink-2">
					From another team
				</span>
			) : null}
			{open === undefined ? null : (
				<span className="flex flex-wrap items-center gap-2">
					<Button asChild size="sm" variant="ghost">
						<a href={open} target="_blank" rel="noopener noreferrer">
							<ExternalLinkIcon />
							{slack ? "Open in Slack" : "Open in Google Contacts"}
						</a>
					</Button>
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

export type Discussion = {
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly state: "open" | "answered" | "closed" | "unknown";
	readonly category: string;
	/** Known once its comments were read: when it is followed. */
	readonly comments: number | null;
	readonly url?: string | undefined;
	readonly asOf?: string | undefined;
};

const DISCUSSION_STATE = {
	unknown: { icon: CircleDashedIcon, word: "State unavailable", live: false },
	open: { icon: MessagesSquareIcon, word: "Open", live: true },
	answered: { icon: CircleCheckIcon, word: "Answered", live: true },
	closed: { icon: CircleSlashIcon, word: "Closed", live: false },
} as const;

export function DiscussionCard({ discussion, actions }: { discussion: Discussion; actions?: ReactNode }) {
	const state = DISCUSSION_STATE[discussion.state];
	return (
		<Tile className="flex flex-col gap-2.5 p-3.5">
			<Where
				asOf={discussion.asOf}
				url={discussion.url}
				actions={
					actions === undefined ? (
						<ObjectMenu
							name={`${discussion.repo} discussion #${discussion.number}`}
							details={[
								["Repository", discussion.repo],
								["Category", discussion.category],
							]}
						/>
					) : (
						actions
					)
				}
			>
				{discussion.repo} · discussion #{discussion.number}
			</Where>
			<span className="text-body font-semibold text-ink [overflow-wrap:anywhere]">
				{discussion.title || "Title unavailable"}
			</span>
			<span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-meta text-ink-2">
				<StatePill {...state} />
				{discussion.category === "" ? null : (
					<span className="min-w-0 max-w-full truncate rounded-full border border-line px-2 py-px">
						{discussion.category}
					</span>
				)}
				{discussion.comments === null ? null : (
					<span className="tabular-nums">
						{discussion.comments} {discussion.comments === 1 ? "comment" : "comments"}
					</span>
				)}
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

export type DriveFile = {
	readonly name: string;
	readonly kind: "doc" | "sheet" | "slides" | "pdf" | "folder" | "image" | "file";
	readonly mimeType: string;
	readonly owner: string;
	readonly modified: string;
	readonly size: number | null;
	readonly description: string;
	readonly url?: string | undefined;
	readonly asOf?: string | undefined;
};

const FILE_KIND: Record<DriveFile["kind"], { readonly icon: LucideIcon; readonly word: string; readonly app: string }> =
	{
		doc: { icon: FileTextIcon, word: "Google Doc", app: "Google Docs" },
		sheet: { icon: SheetIcon, word: "Google Sheet", app: "Google Sheets" },
		slides: { icon: PresentationIcon, word: "Google Slides", app: "Google Slides" },
		pdf: { icon: FileTypeIcon, word: "PDF", app: "Google Drive" },
		folder: { icon: FolderIcon, word: "Folder", app: "Google Drive" },
		image: { icon: ImageIcon, word: "Image", app: "Google Drive" },
		file: { icon: FileIcon, word: "File", app: "Google Drive" },
	};

/** Only Google's own pages for a file open from it; the daemon already kept them https. */
function driveUrl(value: string | undefined): string | undefined {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" &&
			url.port === "" &&
			url.username === "" &&
			url.password === "" &&
			(url.hostname === "docs.google.com" || url.hostname === "drive.google.com")
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

/** When a file changed, in the owner's own time: "Today, 10:32", "Nov 3" or "Nov 3, 2024". */
export function fileModified(value: string, now = new Date()): string {
	const at = new Date(value);
	if (value === "" || Number.isNaN(at.getTime())) return value;
	if (at.toDateString() === now.toDateString())
		return `Today, ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at)}`;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
	}).format(at);
}

/** What kind of file it is, in words: "Google Doc", "PDF", or a binary's own type. */
/** Google's own file kinds without a card kind of their own, by the last part of their type. */
const GOOGLE_KIND: { readonly [kind: string]: string } = {
	drawing: "Google Drawing",
	form: "Google Form",
	site: "Google Site",
	map: "Google My Map",
	jam: "Jamboard",
	script: "Apps Script",
	shortcut: "Shortcut",
};

export const fileType = (file: Pick<DriveFile, "kind" | "mimeType">) => {
	if (file.kind !== "file" || file.mimeType === "") return FILE_KIND[file.kind].word;
	const google = /^application\/vnd\.google-apps\.([a-z]+)$/.exec(file.mimeType)?.[1];
	return google === undefined ? file.mimeType : (GOOGLE_KIND[google] ?? "Google file");
};

/** A read-only file card: what it is, whose, when it changed. The description is plain text the daemon bounded. */
export function FileCard({ file, actions }: { file: DriveFile; actions?: ReactNode }) {
	const kind = FILE_KIND[file.kind];
	const open = driveUrl(file.url);
	const facts = [
		fileType(file),
		file.owner,
		file.modified === "" ? "" : `Modified ${fileModified(file.modified)}`,
		file.size === null || file.kind === "folder" ? "" : sizeOf(file.size),
	].filter((each) => each !== "");
	return (
		<Tile className="flex flex-col gap-2.5 p-3.5">
			<div className="flex min-w-0 items-start gap-2.5">
				<kind.icon aria-hidden="true" data-file-kind={file.kind} className="mt-0.5 size-5 shrink-0 text-ink-2" />
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<h3 className="text-body font-semibold text-ink [overflow-wrap:anywhere]">{file.name || "(Untitled)"}</h3>
					<span className="text-meta text-ink-2 [overflow-wrap:anywhere]">{facts.join(" · ")}</span>
				</div>
				{file.asOf === undefined ? null : <span className="shrink-0 text-meta text-ink-2">as of {file.asOf}</span>}
				<span className="shrink-0">{actions}</span>
			</div>
			{file.description === "" ? null : (
				<p className="whitespace-pre-wrap text-meta text-ink [overflow-wrap:anywhere]">{file.description}</p>
			)}
			{open === undefined ? null : (
				<span className="flex flex-wrap items-center gap-2">
					<Button asChild size="sm" variant="ghost" className="-ml-2">
						<a href={open} target="_blank" rel="noopener noreferrer">
							<ExternalLinkIcon />
							Open in {kind.app}
						</a>
					</Button>
				</span>
			)}
		</Tile>
	);
}
