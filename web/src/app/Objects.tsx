/** Message refs are only names. Every displayed fact comes from the daemon's account-bound reading. */
import { EyeIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { EmailCard as EmailObject } from "../../../src/core/objects.ts";
import type { ObjectAsk, ObjectShown } from "../../../src/server/objects.ts";
import { Tile } from "../chat/Cards.tsx";
import { ObjectLoading, ObjectUnavailable } from "../chat/Loading.tsx";
import {
	CheckRunCard,
	ContactCard,
	DiscussionCard,
	EmailCard,
	EventCard,
	eventWhen,
	FileCard,
	fileModified,
	fileType,
	IssueCard,
	MessagesCard,
	NotificationCard,
	ObjectLink,
	ObjectMenu,
	ObjectReference,
	PullRequestCard,
	RepositoryCard,
} from "../chat/Object.tsx";
import { Named } from "../chat/Watch.tsx";
import { Markdown, MarkdownLinks } from "../components/Markdown.tsx";
import { api, gmailAttachment } from "../lib/api.ts";
import { sharedReads } from "../lib/object-reads.ts";
import { githubKey, idLinks, idOfLink, objectAsks } from "../lib/objects.ts";
import { type Shell, useShellPick } from "../lib/shell.ts";
import { sizeOf } from "../lib/size.ts";
import { ConnectFlowCard } from "./ConnectFlow.tsx";
import { FilePart } from "./FilePart.tsx";
import { watchActions } from "./watches.tsx";
import { hrefOf } from "./where.ts";

/** Read an object's card from the daemon, once for every line that names it. */
const readObject = sharedReads((chat, reference, agent) =>
	api<ObjectShown[]>("/objects", {
		method: "POST",
		body: JSON.stringify({ chat, asks: [{ ref: reference, ...(agent === undefined ? {} : { agent }) }] }),
	}).then((shown) => shown[0]),
);

/** The name of agent `id`, as the band shows it; the agent whose card it is by its given name. */
function whoFollows(id: string, agent: { readonly id: string; readonly name: string } | undefined): string {
	if (agent?.id === id) return agent.name;
	return id;
}

/**
 * An object named inline, as the owner's own references are drawn: the service's mark, its state and its linked
 * title, from the daemon's reading, read once for every line that names it (`readObject`) and again when a watch saw
 * it change; `fallback` (its name) until then, or when it cannot be read.
 */
export function FollowedObject({
	chat,
	agent,
	reference,
	fallback,
	strong = false,
}: {
	chat: number | undefined;
	agent?: { readonly id: string; readonly name: string } | undefined;
	/** The object: a link, or its canonical key as a card names it. */
	reference: string;
	fallback: string;
	/** In a quiet line (a watch's), the object stands out: primary text, its title a link. */
	strong?: boolean;
}) {
	const [shown, setShown] = useState<ObjectShown>();
	const agentId = agent?.id;
	const moved = useShellPick(watchesMoved);
	useEffect(() => {
		if (chat === undefined) return;
		let gone = false;
		void readObject(chat, reference, agentId, moved).then(
			(next) => {
				if (!gone) setShown(next);
			},
			() => {},
		);
		return () => {
			gone = true;
		};
	}, [chat, reference, agentId, moved]);
	const drawn =
		shown?.shown === "card" && shown.card.card !== "notification" ? (
			<ObjectLink object={shown.card} href={("url" in shown.card ? shown.card.url : undefined) ?? reference} />
		) : (
			<span data-object-inline="">{fallback}</span>
		);
	return strong ? <Named>{drawn}</Named> : drawn;
}

export function MessageObjects({
	chat,
	objects,
	agent,
}: {
	chat: number;
	objects?: readonly string[] | undefined;
	agent?: { readonly id: string; readonly name: string } | undefined;
}) {
	// only what the message shows: an object the prose names stays in the prose
	return <ObjectPreviews chat={chat} asks={objectAsks("", objects)} agent={agent} explicit={objects} />;
}

/** A link to an id, not an address, has nothing to open: its words. */
const wordsOfIds = (href: string, children: ReactNode) =>
	href.startsWith("object:") ? <span>{children}</span> : undefined;

/**
 * A message's prose, anyone's: an object it names stays inside the words as its icon and name, and opens its card when
 * clicked. Unreadable or unknown links remain usable; an id that names nothing readable is its words.
 */
export function MessageText({
	chat,
	text,
	agent,
	shown = [],
}: {
	chat: number;
	text: string;
	agent?: { readonly id: string; readonly name: string } | undefined;
	/** What the message shows as cards beneath it: named in the prose too, it stays the prose's words, read once. */
	shown?: readonly string[] | undefined;
}) {
	const asks = objectAsks(text).filter((ask) => !("ref" in ask) || !shown.includes(ask.ref));
	const request = JSON.stringify(asks.map((ask) => ({ ...ask, ...(agent === undefined ? {} : { agent: agent.id }) })));
	return asks.length === 0 ? (
		<MarkdownLinks.Provider value={wordsOfIds}>
			<Markdown>{idLinks(text)}</Markdown>
		</MarkdownLinks.Provider>
	) : (
		<ReadObjects
			key={`${chat}:${request}`}
			chat={chat}
			request={request}
			agent={agent}
			explicit={[]}
			inlineText={text}
		/>
	);
}

/** An object named in prose: its icon and name, which open its card; the card links out to the service. */
function InlineObject({
	chat,
	reading,
	agent,
	href,
}: {
	chat: number;
	reading: Extract<ObjectShown, { shown: "card" }>;
	agent: { readonly id: string; readonly name: string } | undefined;
	href: string;
}) {
	if (reading.card.card === "notification") return null;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="inline max-w-full cursor-pointer rounded-sm align-baseline underline decoration-dotted underline-offset-2"
					title={href}
				>
					<ObjectLink object={reading.card} href="" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] p-0">
				<ObjectReading chat={chat} shown={reading} agent={agent} />
			</PopoverContent>
		</Popover>
	);
}

/** No timers, retries or subscriptions: read once on mount, then only when the owner asks. */
export function ObjectPreviews({
	chat,
	asks,
	agent,
	explicit = [],
}: {
	chat: number;
	asks: readonly ObjectAsk[];
	agent?: { readonly id: string; readonly name: string } | undefined;
	explicit?: readonly string[] | undefined;
}) {
	const request = JSON.stringify(asks.map((ask) => ({ ...ask, ...(agent === undefined ? {} : { agent: agent.id }) })));
	return asks.length === 0 ? null : (
		<ReadObjects key={`${chat}:${request}`} chat={chat} request={request} agent={agent} explicit={explicit} />
	);
}

/** A number for each value the shell held, so a string can say which one a reader saw without spelling it out. */
const generations = new WeakMap<object, number>();
let generation = 0;
const generationOf = (value: object | undefined) => {
	if (value === undefined) return 0;
	const known = generations.get(value);
	if (known !== undefined) return known;
	generation++;
	generations.set(value, generation);
	return generation;
};

/**
 * What the watches have done, as one string: it changes when a followed object changed (the version of its reading,
 * never a look that found it the same), and when a watch comes, goes, ends, pauses, fails, changes what ends it or
 * what it follows, which its card says; and when the connections or the agents changed, since what a card may show
 * depends on who may read it. The cards named on screen are read again when it changes, and only then.
 */
const watchesMoved = (shell: Shell) =>
	JSON.stringify([
		generationOf(shell.capabilities),
		generationOf(shell.agents),
		(shell.watches ?? []).map((watch) => [
			watch.name,
			watch.object?.ref,
			watch.object?.version,
			watch.accepted?.watch?.until,
			watch.state,
			watch.done?.at,
		]),
	]);

function ReadObjects({
	chat,
	request,
	agent,
	explicit,
	inlineText,
}: {
	chat: number;
	request: string;
	agent: { readonly id: string; readonly name: string } | undefined;
	explicit: readonly string[];
	inlineText?: string;
}) {
	const initial = useRef<Promise<ObjectShown[]> | undefined>(undefined);
	const [shown, setShown] = useState<ObjectShown[] | undefined>();
	const [failure, setFailure] = useState<string>();
	const [busy, setBusy] = useState<number | "all" | undefined>("all");
	const load = (asks: readonly ObjectAsk[], refresh: boolean) =>
		api<ObjectShown[]>("/objects", { method: "POST", body: JSON.stringify({ chat, asks, refresh }) });
	useEffect(() => {
		let gone = false;
		initial.current ??= api<ObjectShown[]>("/objects", {
			method: "POST",
			body: JSON.stringify({ chat, asks: JSON.parse(request) }),
		});
		void initial.current.then(
			(next) => {
				if (!gone) {
					setShown(next);
					setBusy(undefined);
				}
			},
			() => {
				if (!gone) {
					setFailure("banda on this computer didn't answer. Try again to read the previews.");
					setBusy(undefined);
				}
			},
		);
		return () => {
			gone = true;
		};
	}, [chat, request]);
	// a card of a kind that can be followed shows its newest reading and who follows it: a change a watch saw reads the
	// kept reading again (from the daemon's store, not the service), so a card shown before never goes stale
	const moved = useShellPick(watchesMoved);
	const followable = shown?.some((one) => one.shown === "card" && one.follow !== undefined) === true;
	const seenMoved = useRef(moved);
	useEffect(() => {
		if (seenMoved.current === moved) return;
		seenMoved.current = moved;
		if (!followable) return;
		let gone = false;
		api<ObjectShown[]>("/objects", { method: "POST", body: JSON.stringify({ chat, asks: JSON.parse(request) }) }).then(
			(next) => {
				if (!gone) setShown(next);
			},
			() => {},
		);
		return () => {
			gone = true;
		};
	}, [moved, followable, chat, request]);
	const refresh = async (indices?: readonly number[]) => {
		if (busy !== undefined) return;
		setBusy(indices?.[0] ?? "all");
		setFailure(undefined);
		const asks = JSON.parse(request) as ObjectAsk[];
		try {
			const next = await load(indices === undefined ? asks : indices.map((index) => asks[index] as ObjectAsk), true);
			setShown((previous) =>
				indices === undefined ? next : previous?.map((value, i) => next[indices.indexOf(i)] ?? value),
			);
		} catch {
			setFailure("banda on this computer didn't answer. Try again to read the previews.");
		} finally {
			setBusy(undefined);
		}
	};
	if (inlineText !== undefined) {
		const asks = JSON.parse(request) as ObjectAsk[];
		return (
			<MarkdownLinks.Provider
				value={(link, children) => {
					const href = idOfLink(link);
					const key = githubKey(href);
					const index = asks.findIndex(
						(ask) => "ref" in ask && (ask.ref === href || (key !== undefined && githubKey(ask.ref) === key)),
					);
					const reading = shown?.[index];
					// an address goes where it was written; an id has nowhere to go but its card, which it opens
					if (reading?.shown === "card" && reading.card.card !== "notification")
						return /^https?:/i.test(href) ? (
							<ObjectLink object={reading.card} href={href} />
						) : (
							<InlineObject chat={chat} reading={reading} agent={agent} href={href} />
						);
					return wordsOfIds(link, children);
				}}
			>
				<Markdown>{idLinks(inlineText)}</Markdown>
			</MarkdownLinks.Provider>
		);
	}
	const seen = new Set<string>();
	return (
		<div
			className="flex w-full min-w-0 max-w-[var(--measure)] flex-col gap-2 [overflow-wrap:anywhere]"
			data-object-previews=""
		>
			{shown === undefined && busy !== undefined ? <ObjectLoading /> : null}
			{failure === undefined ? null : (
				<ObjectUnavailable
					what="Couldn't read the previews"
					why={failure}
					fix="Try again"
					onFix={() => void refresh()}
					busy={busy !== undefined}
				/>
			)}
			{shown?.map((one, index) => {
				if (one.shown === "link") {
					const ask = (JSON.parse(request) as ObjectAsk[])[index];
					const ref = ask !== undefined && "ref" in ask ? ask.ref : undefined;
					if (ref === undefined || !explicit.includes(ref) || seen.has(ref)) return null;
					seen.add(ref);
					return <ObjectReference key={ref} reference={ref} />;
				}
				const key = one.shown === "connect" ? `connect:${one.connection}` : `${one.key}:${one.account ?? ""}`;
				if (seen.has(key)) return null;
				seen.add(key);
				return (
					<div key={key} className="flex min-w-0 flex-col gap-1" data-object={key} aria-busy={busy === index}>
						<ObjectReading
							chat={chat}
							shown={one}
							agent={agent}
							busy={busy !== undefined}
							onRefresh={() => void refresh([index])}
						/>
						{one.shown === "card" || (one.shown === "failed" && one.off === true) ? null : (
							<Button
								variant="ghost"
								size="sm"
								className="self-end"
								disabled={busy !== undefined}
								aria-label={`${one.shown === "failed" ? "Retry" : "Refresh"} ${"name" in one ? one.name : "preview"}`}
								onClick={() =>
									void refresh(
										one.shown === "connect"
											? shown.flatMap((other, i) =>
													other.shown === "connect" && other.connection === one.connection ? [i] : [],
												)
											: [index],
									)
								}
							>
								{busy === index ? "Reading…" : one.shown === "failed" ? "Try again" : "Refresh preview"}
							</Button>
						)}
					</div>
				);
			})}
		</div>
	);
}

export function ObjectReading({
	chat,
	shown,
	agent,
	hideActions = false,
	onRefresh,
	busy,
}: {
	chat: number;
	shown: ObjectShown;
	agent?: { readonly id: string; readonly name: string } | undefined;
	hideActions?: boolean;
	onRefresh?: (() => void) | undefined;
	busy?: boolean | undefined;
}) {
	if (shown.shown === "link") return null;
	if (shown.shown === "connect") return <ConnectFlowCard connection={shown.connection} agent={agent} />;
	if (shown.shown === "failed")
		return (
			<ObjectUnavailable
				what={
					shown.off === true
						? `${shown.name.charAt(0).toUpperCase()}${shown.name.slice(1)} can't be shown`
						: `Couldn't read ${shown.name}`
				}
				why={
					shown.off === true
						? shown.why
						: `${shown.service}${shown.account ? ` as ${shown.account}` : ""}: ${shown.why}`
				}
				{...(shown.off === true
					? {
							fix: "Details",
							onFix: () => {
								location.hash = hrefOf({ name: "connections", connection: shown.connection });
							},
						}
					: {})}
			/>
		);
	return (
		<ReadingCard chat={chat} shown={shown} agent={agent} hideActions={hideActions} onRefresh={onRefresh} busy={busy} />
	);
}

type GmailAttachmentMeta = {
	readonly id: string;
	readonly name: string;
	readonly mimeType: string;
	readonly size: number;
	readonly sha?: string;
};
function attachmentsOf(card: Pick<EmailObject, "attachmentManifest">): GmailAttachmentMeta[] {
	try {
		const parsed: unknown = JSON.parse(card.attachmentManifest ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed.slice(0, 20).flatMap((item): GmailAttachmentMeta[] => {
			if (typeof item !== "object" || item === null) return [];
			const row = item as Record<string, unknown>;
			if (
				typeof row.id !== "string" ||
				row.id.length > 500 ||
				typeof row.name !== "string" ||
				typeof row.mimeType !== "string" ||
				typeof row.size !== "number" ||
				!Number.isSafeInteger(row.size) ||
				row.size < 0
			)
				return [];
			return [
				{
					id: row.id,
					name: row.name,
					mimeType: row.mimeType,
					size: row.size,
					...(typeof row.sha === "string" && /^[0-9a-f]{64}$/.test(row.sha) ? { sha: row.sha } : {}),
				},
			];
		});
	} catch {
		return [];
	}
}

function EmailAttachments({
	chat,
	shown,
	card,
	agent,
}: {
	chat: number;
	shown: Extract<ObjectShown, { shown: "card" }>;
	card: EmailObject;
	agent: { readonly id: string; readonly name: string } | undefined;
}) {
	const entries = attachmentsOf(card);
	if (entries.length === 0) return null;
	return (
		<div className="flex flex-col gap-1.5 border-t border-line pt-2">
			<p className="text-meta text-ink-2">Attachments</p>
			{entries.map((attachment) => (
				<EmailAttachmentItem key={attachment.id} chat={chat} shown={shown} attachment={attachment} agent={agent} />
			))}
		</div>
	);
}

function EmailAttachmentItem({
	chat,
	shown,
	attachment,
	agent,
}: {
	chat: number;
	shown: Extract<ObjectShown, { shown: "card" }>;
	attachment: GmailAttachmentMeta;
	agent: { readonly id: string; readonly name: string } | undefined;
}) {
	const [file, setFile] = useState(
		attachment.sha === undefined ? undefined : { sha: attachment.sha, name: attachment.name },
	);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const oversized = attachment.size > 10 * 1024 * 1024;
	const open = async () => {
		if (
			busy ||
			oversized ||
			file !== undefined ||
			shown.card.card !== "email" ||
			!/^[A-Za-z0-9_-]{1,200}$/.test(shown.name)
		)
			return;
		setBusy(true);
		setFailure(undefined);
		try {
			const saved = await gmailAttachment(chat, `gmail/${shown.name}`, attachment.id, {
				...(agent === undefined ? {} : { agent: agent.id }),
				...(shown.accountKey === undefined ? {} : { account: shown.accountKey }),
			});
			setFile({ sha: saved.sha, name: saved.name });
		} catch (error) {
			setFailure(error instanceof Error ? error.message : "Could not open this attachment.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<div className="flex min-w-0 items-center gap-2">
				<Button size="sm" variant="outline" disabled={busy || oversized} onClick={() => void open()}>
					{file !== undefined ? "Open file" : busy ? "Loading…" : oversized ? "Over 10 MB" : "Get attachment"}
				</Button>
				<span className="min-w-0 truncate text-meta text-ink" title={attachment.name}>
					{attachment.name}
				</span>
				<span className="shrink-0 text-meta text-ink-2">{sizeOf(attachment.size)}</span>
			</div>
			{failure === undefined ? null : (
				<p role="alert" className="text-meta text-danger">
					{failure}
				</p>
			)}
			{file === undefined ? null : <FilePart chat={chat} file={{ kind: "blob", ...file, image: false }} />}
		</div>
	);
}

function readingDetails(shown: Extract<ObjectShown, { shown: "card" }>): [string, string][] {
	const subject = shown.subject?.shown === "card" ? shown.subject : undefined;
	const card = subject?.card ?? shown.card;
	const rows: [string, string][] = [
		["Object", shown.name],
		[
			"Read as",
			shown.account === undefined ? `No account on ${shown.service}` : `${shown.account} on ${shown.service}`,
		],
		["Read at", new Date(shown.at).toLocaleString()],
	];
	if (subject !== undefined) {
		rows.push(["Subject read at", new Date(subject.at).toLocaleString()]);
		if (subject.account !== shown.account || subject.connection !== shown.connection)
			rows.push(["Subject read as", `${subject.account ?? "No account"} on ${subject.service}`]);
	}
	if (
		card.card === "pull-request" ||
		card.card === "issue" ||
		card.card === "check-run" ||
		card.card === "discussion" ||
		card.card === "repository"
	)
		rows.push(["Repository", card.repo]);
	if (card.card === "discussion") rows.push(["Title", card.title], ["Category", card.category]);
	if (card.card === "repository") rows.push(["Latest release", card.release ?? ""], ["Head", card.sha ?? ""]);
	if (card.card === "pull-request" || card.card === "issue") rows.push(["Title", card.title], ["Author", card.author]);
	if (card.card === "pull-request") rows.push(["Branch", card.branch]);
	if (card.card === "check-run") rows.push(["Check", card.name], ["Where", card.where ?? ""]);
	if (card.card === "email") rows.push(["From", card.from], ["To", card.to], ["Subject", card.subject]);
	if (card.card === "messages") rows.push([card.search ? "Search" : "Subject", card.title]);
	if (card.card === "event")
		rows.push(["When", eventWhen(card)], ["Location", card.location], ["Organizer", card.organizer]);
	if (card.card === "contact") rows.push(["Name", card.name], ["Email", card.emails], ["Company", card.organization]);
	if (card.card === "file")
		rows.push(["Owner", card.owner], ["Modified", fileModified(card.modified)], ["Type", fileType(card)]);
	return rows;
}

/**
 * Whether a card's reading is old: an hour and more since it was read. Age is display-only: one local timer at the
 * boundary, never another service read. Never old while a watch looks at the object (one that is active, neither
 * paused, done nor unable to look, while nothing is paused and the daemon is reached): the daemon keeps its reading
 * current, and the card says "as of" only when nobody can look (DESIGN.md "Watches").
 */
function useOldReading(shown: Extract<ObjectShown, { shown: "card" }>) {
	const [expiredAt, setExpiredAt] = useState<number>();
	const looking =
		useShellPick((shell) =>
			!shell.offline &&
			shell.control?.paused === undefined &&
			(shell.watches ?? []).some((watch) => watch.state === "active" && watch.object?.ref === shown.key)
				? "looking"
				: "",
		) === "looking";
	const old = !looking && (shown.old || expiredAt === shown.at || Date.now() - shown.at > 3_600_000);
	useEffect(() => {
		if (looking || shown.old || Date.now() - shown.at > 3_600_000) return;
		const timer = setTimeout(() => setExpiredAt(shown.at), shown.at + 3_600_001 - Date.now());
		return () => clearTimeout(timer);
	}, [shown.at, shown.old, looking]);
	return old;
}

function ReadingCard({
	chat,
	shown,
	agent,
	hideActions,
	onRefresh,
	busy,
}: {
	chat: number;
	shown: Extract<ObjectShown, { shown: "card" }>;
	agent: { readonly id: string; readonly name: string } | undefined;
	hideActions: boolean;
	onRefresh: (() => void) | undefined;
	busy: boolean | undefined;
}) {
	const old = useOldReading(shown);
	const { card } = shown;
	// Follow, when the kind can be followed and this agent does not yet; who follows it, when someone does
	const followedBy = shown.follow?.by ?? [];
	const mine = agent !== undefined && followedBy.some((each) => each.agent === agent.id);
	const follow =
		shown.follow === undefined || agent === undefined || mine
			? undefined
			: {
					ends: shown.follow.ends,
					onFollow: (until?: string) =>
						void watchActions.follow({ agent: agent.id, object: shown.key, ...(until === undefined ? {} : { until }) }),
				};
	const actions = hideActions ? null : (
		<ObjectMenu name={shown.name} details={readingDetails(shown)} onRefresh={onRefresh} follow={follow} busy={busy} />
	);
	const following =
		followedBy.length === 0 ? null : (
			<p className="flex items-center gap-1.5 px-1 text-meta text-ink-2" data-following="">
				<EyeIcon aria-hidden="true" className="size-3.5 shrink-0" />
				Following
				{followedBy.map(
					(each) => ` · ${whoFollows(each.agent, agent)}${each.until === undefined ? "" : ` until ${each.until}`}`,
				)}
			</p>
		);
	const asOf = old
		? new Date(shown.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
		: undefined;
	return (
		<>
			{card.card === "pull-request" ? (
				<>
					<PullRequestCard pr={{ ...card, asOf }} actions={actions} />
					{following}
				</>
			) : card.card === "issue" ? (
				<>
					<IssueCard issue={{ ...card, asOf }} actions={actions} />
					{following}
				</>
			) : card.card === "check-run" ? (
				<CheckRunCard run={{ ...card, asOf }} actions={actions} />
			) : card.card === "discussion" ? (
				<>
					<DiscussionCard discussion={{ ...card, asOf }} actions={actions} />
					{following}
				</>
			) : card.card === "repository" ? (
				<>
					<RepositoryCard repository={{ ...card, asOf }} actions={actions} />
					{following}
				</>
			) : card.card === "email" ? (
				<EmailCard
					message={{ ...card, ...(asOf === undefined ? {} : { asOf }) }}
					actions={actions}
					attachments={<EmailAttachments chat={chat} shown={shown} card={card} agent={agent} />}
				/>
			) : card.card === "messages" ? (
				<>
					<MessagesCard list={{ ...card, asOf }} actions={actions} />
					{following}
				</>
			) : card.card === "event" ? (
				<EventCard event={{ ...card, asOf }} actions={actions} />
			) : card.card === "contact" ? (
				<ContactCard person={{ ...card, asOf }} actions={actions} />
			) : card.card === "file" ? (
				<FileCard file={{ ...card, asOf }} actions={actions} />
			) : (
				<NotificationCard
					actions={actions}
					reason={card.reason}
					unread={card.unread}
					when={card.at === undefined ? "" : new Date(card.at).toLocaleString()}
				>
					{shown.subject !== undefined && shown.subject.shown !== "link" ? (
						<ObjectReading chat={chat} shown={shown.subject} agent={agent} hideActions />
					) : (
						<Tile className="p-3.5">
							<p className="text-body text-ink">{card.title || "Notification"}</p>
							<p className="text-meta text-ink-2">Subject preview unavailable</p>
						</Tile>
					)}
					{asOf === undefined ? null : <span className="text-meta text-ink-2">as of {asOf}</span>}
				</NotificationCard>
			)}
		</>
	);
}
