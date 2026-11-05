/** Message refs are only names. Every displayed fact comes from the daemon's account-bound reading. */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ObjectAsk, ObjectShown } from "../../../src/server/objects.ts";
import { Tile } from "../chat/Cards.tsx";
import { ObjectLoading, ObjectUnavailable } from "../chat/Loading.tsx";
import {
	CheckRunCard,
	IssueCard,
	NotificationCard,
	ObjectLink,
	ObjectMenu,
	ObjectReference,
	PullRequestCard,
} from "../chat/Object.tsx";
import { Markdown, MarkdownLinks } from "../components/Markdown.tsx";
import { api } from "../lib/api.ts";
import { githubKey, objectAsks } from "../lib/objects.ts";
import { ConnectFlow } from "./ConnectFlow.tsx";

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
	shown,
	agent,
	hideActions = false,
	onRefresh,
	busy,
}: {
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
	return <ReadingCard shown={shown} agent={agent} hideActions={hideActions} onRefresh={onRefresh} busy={busy} />;
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
	if (card.card !== "notification") rows.push(["Repository", card.repo]);
	if (card.card === "pull-request" || card.card === "issue") rows.push(["Title", card.title], ["Author", card.author]);
	if (card.card === "pull-request") rows.push(["Branch", card.branch]);
	if (card.card === "check-run") rows.push(["Check", card.name], ["Where", card.where ?? ""]);
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
	shown,
	agent,
	hideActions,
	onRefresh,
	busy,
}: {
	shown: Extract<ObjectShown, { shown: "card" }>;
	agent: { readonly id: string; readonly name: string } | undefined;
	hideActions: boolean;
	onRefresh: (() => void) | undefined;
	busy: boolean | undefined;
}) {
	const old = useOldReading(shown);
	const { card } = shown;
	const actions = hideActions ? null : (
		<ObjectMenu name={shown.name} details={readingDetails(shown)} onRefresh={onRefresh} busy={busy} />
	);
	const asOf = old
		? new Date(shown.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
		: undefined;
	return (
		<>
			{card.card === "pull-request" ? (
				<PullRequestCard pr={{ ...card, asOf }} actions={actions} />
			) : card.card === "issue" ? (
				<IssueCard issue={{ ...card, asOf }} actions={actions} />
			) : card.card === "check-run" ? (
				<CheckRunCard run={{ ...card, asOf }} actions={actions} />
			) : (
				<NotificationCard
					actions={actions}
					reason={card.reason}
					unread={card.unread}
					when={card.at === undefined ? "" : new Date(card.at).toLocaleString()}
				>
					{shown.subject !== undefined && shown.subject.shown !== "link" ? (
						<ObjectReading shown={shown.subject} agent={agent} hideActions />
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
