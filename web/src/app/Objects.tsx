/** Message refs are only names. Every displayed fact comes from the daemon's account-bound reading. */
import { EyeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { EmailCard as EmailObject } from "../../../src/core/objects.ts";
import type { ObjectAsk, ObjectShown } from "../../../src/server/objects.ts";
import { Tile } from "../chat/Cards.tsx";
import { ObjectLoading, ObjectUnavailable } from "../chat/Loading.tsx";
import {
	CheckRunCard,
	EmailCard,
	IssueCard,
	NotificationCard,
	ObjectLink,
	ObjectMenu,
	ObjectReference,
	PullRequestCard,
} from "../chat/Object.tsx";
import { Markdown, MarkdownLinks } from "../components/Markdown.tsx";
import { api, gmailAttachment, sizeOf } from "../lib/api.ts";
import { githubKey, objectAsks } from "../lib/objects.ts";
import { ConnectFlow } from "./ConnectFlow.tsx";
import { FilePart } from "./FilePart.tsx";
import { watchActions } from "./watches.tsx";

/** The name of agent `id`, as the band shows it; the agent whose card it is by its given name. */
function whoFollows(id: string, agent: { readonly id: string; readonly name: string } | undefined): string {
	if (agent?.id === id) return agent.name;
	return id;
}

/**
 * An object named inline, as the owner's own references are drawn: the service's mark, its state and its linked
 * title, from the daemon's reading, read once; `fallback` (its name) until then, or when it cannot be read.
 */
export function InlineObject({
	chat,
	agent,
	reference,
	fallback,
}: {
	chat: number | undefined;
	agent?: { readonly id: string; readonly name: string } | undefined;
	/** The object: a link, or its canonical key as a card names it. */
	reference: string;
	fallback: string;
}) {
	const [shown, setShown] = useState<ObjectShown>();
	const agentId = agent?.id;
	useEffect(() => {
		if (chat === undefined) return;
		let gone = false;
		const asks: ObjectAsk[] = [{ ref: reference, ...(agentId === undefined ? {} : { agent: agentId }) }];
		void api<ObjectShown[]>("/objects", { method: "POST", body: JSON.stringify({ chat, asks }) }).then(
			(next) => {
				if (!gone) setShown(next[0]);
			},
			() => {},
		);
		return () => {
			gone = true;
		};
	}, [chat, reference, agentId]);
	if (shown?.shown === "card" && shown.card.card !== "notification")
		return <ObjectLink object={shown.card} href={shown.card.url ?? reference} />;
	return <span data-object-inline="">{fallback}</span>;
}

export function MessageObjects({
	chat,
	text,
	objects,
	agent,
}: {
	chat: number;
	text: string;
	objects?: readonly string[] | undefined;
	agent?: { readonly id: string; readonly name: string } | undefined;
}) {
	return <ObjectPreviews chat={chat} asks={objectAsks(text, objects)} agent={agent} explicit={objects} />;
}

/** Owner references stay inside the prose. Unreadable/unknown links remain usable, never become cards. */
export function OwnerMessage({
	chat,
	text,
	agent,
}: {
	chat: number;
	text: string;
	agent?: { readonly id: string; readonly name: string } | undefined;
}) {
	const asks = objectAsks(text);
	const request = JSON.stringify(asks.map((ask) => ({ ...ask, ...(agent === undefined ? {} : { agent: agent.id }) })));
	return asks.length === 0 ? (
		<Markdown>{text}</Markdown>
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
				value={(href) => {
					const key = githubKey(href);
					const index = asks.findIndex(
						(ask) => "ref" in ask && (ask.ref === href || (key !== undefined && githubKey(ask.ref) === key)),
					);
					const reading = shown?.[index];
					if (reading?.shown !== "card" || reading.card.card === "notification") return undefined;
					return <ObjectLink object={reading.card} href={href} />;
				}}
			>
				<Markdown>{inlineText}</Markdown>
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
						{one.shown === "card" ? null : (
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
	if (shown.shown === "connect") return <ConnectFlow connection={shown.connection} agent={agent} />;
	if (shown.shown === "failed")
		return (
			<ObjectUnavailable
				what={`Couldn't read ${shown.name}`}
				why={`${shown.service}${shown.account ? ` as ${shown.account}` : ""}: ${shown.why}`}
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
	if (card.card === "pull-request" || card.card === "issue" || card.card === "check-run")
		rows.push(["Repository", card.repo]);
	if (card.card === "pull-request" || card.card === "issue") rows.push(["Title", card.title], ["Author", card.author]);
	if (card.card === "pull-request") rows.push(["Branch", card.branch]);
	if (card.card === "check-run") rows.push(["Check", card.name], ["Where", card.where ?? ""]);
	if (card.card === "email") rows.push(["From", card.from], ["To", card.to], ["Subject", card.subject]);
	return rows;
}

/** Age is display-only: one local wake at the boundary, never another service read. */
function useOldReading(shown: Extract<ObjectShown, { shown: "card" }>) {
	const [expiredAt, setExpiredAt] = useState<number>();
	const old = shown.old || expiredAt === shown.at || Date.now() - shown.at > 3_600_000;
	useEffect(() => {
		if (shown.old || Date.now() - shown.at > 3_600_000) return;
		const timer = setTimeout(() => setExpiredAt(shown.at), shown.at + 3_600_001 - Date.now());
		return () => clearTimeout(timer);
	}, [shown.at, shown.old]);
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
			) : card.card === "email" ? (
				<EmailCard
					message={{ ...card, ...(asOf === undefined ? {} : { asOf }) }}
					actions={actions}
					attachments={<EmailAttachments chat={chat} shown={shown} card={card} agent={agent} />}
				/>
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
