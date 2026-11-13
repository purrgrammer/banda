/**
 * A harness session in a chat, live from the shell: its card in place of the call that started it, the harness's own
 * asks while it waits on the owner (several may be open), and every step in a sheet. The owner's notes, answers and Stop go to the daemon.
 */
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { answerHarness, steerHarness, stopHarness } from "../areas/harnesses.ts";
import { type HarnessSessionView as CardView, HarnessCard, HarnessMenu, HarnessTranscript } from "../chat/Harness.tsx";
import type { HarnessAsk, HarnessSessionView } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import { chatAgents } from "../lib/navigation.ts";
import { useShell } from "../lib/shell.ts";
import { askWords, shownAsks } from "./harness-activity.ts";

const clock = (ms: number) => {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Ticks once a second while `on`, so a running session's time moves. */
function useNow(on: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!on) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [on]);
	return now;
}

const viewOf = (session: HarnessSessionView, now: number, agent: string | undefined): CardView => ({
	harness: session.service,
	task: session.task,
	...(agent === undefined ? {} : { agent }),
	...(session.continues === undefined ? {} : { continues: session.continues }),
	...(session.continuation === undefined ? {} : { continuation: session.continuation }),
	...(session.stoppedBy === undefined ? {} : { stoppedBy: session.stoppedBy }),
	...(session.provider === undefined ? {} : { provider: session.provider }),
	...(session.logo === undefined ? {} : { logo: session.logo }),
	folder: session.folder,
	...(session.root === undefined ? {} : { root: session.root }),
	dropped: session.dropped,
	state:
		session.state === "starting"
			? "working"
			: session.state === "failed"
				? "failed"
				: session.state === "waiting" && (session.asks ?? []).length === 0
					? "working"
					: session.state,
	// an open ask is what it waits on: the card's line says its kind in words; the command lives on the ask's card
	steps:
		(session.asks ?? []).length === 0
			? session.steps
			: [
					...session.steps,
					{ kind: "waiting", command: session.asks?.[0]?.command ?? "", ask: session.asks?.[0]?.kind ?? "other" },
				],
	elapsed: clock((session.ended ?? now) - session.at),
	...(session.outcome === undefined ? {} : { outcome: session.outcome }),
});

/** False until `key` has held still a moment: a button that just appeared or moved takes no click meant for another. */
function useSettled(key: string, ms = 600): boolean {
	const [settled, setSettled] = useState<string>();
	useEffect(() => {
		const timer = setTimeout(() => setSettled(key), ms);
		return () => clearTimeout(timer);
	}, [key, ms]);
	return settled === key;
}

type Answer = (id: string, allow: boolean) => unknown | Promise<unknown>;

function AskActions({ ask, place, onAnswer }: { ask: HarnessAsk; place: number; onAnswer: Answer }) {
	const words = askWords(ask.kind);
	const settled = useSettled(`${ask.id}:${place}`);
	const [busy, setBusy] = useState(false);
	const answer = async (allow: boolean) => {
		if (busy || !settled) return;
		setBusy(true);
		try {
			await onAnswer(ask.id, allow);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-wrap items-center gap-1">
			<Button size="sm" type="button" disabled={!settled || busy} onClick={() => void answer(true)}>
				{words.verb}
			</Button>
			<Button size="sm" type="button" variant="ghost" disabled={!settled || busy} onClick={() => void answer(false)}>
				{words.no}
			</Button>
		</div>
	);
}

/** Each permission opens the exact action. Its buttons only appear after the owner expands that request. */
function HarnessAskCard({
	ask,
	folder,
	place,
	onAnswer,
}: {
	ask: HarnessAsk;
	folder: string;
	place: number;
	onAnswer: Answer;
}) {
	const words = askWords(ask.kind);
	return (
		<Collapsible>
			<CollapsibleTrigger className="group flex min-h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-field px-1 text-left text-ui text-ink hover:bg-paper-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
				<span>{words.what}</span>
				<ChevronRightIcon
					aria-hidden="true"
					className="size-3.5 shrink-0 text-ink-2 group-data-[state=open]:rotate-90"
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="flex min-w-0 flex-col gap-2 px-1 pb-2">
				<p className="break-all text-meta text-ink-2">In {folder}</p>
				{ask.title === undefined || ask.title === ask.command ? null : (
					<p className="break-words text-ui">{ask.title}</p>
				)}
				<section
					aria-label="Full permission details"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the full permission
					tabIndex={0}
					className="max-h-48 overflow-y-auto overscroll-contain rounded-field bg-paper-2 p-2 focus-visible:outline-2 focus-visible:outline-focus"
				>
					<pre className="font-code text-meta whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{ask.command}</pre>
					{ask.detail === undefined || ask.detail === ask.command ? null : (
						<pre className="mt-2 border-t border-line-soft pt-2 font-code text-meta whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
							{ask.detail}
						</pre>
					)}
				</section>
				<AskActions ask={ask} place={place} onAnswer={onAnswer} />
			</CollapsibleContent>
		</Collapsible>
	);
}

export function HarnessAsks({ session, onAnswer }: { session: HarnessSessionView; onAnswer?: Answer }) {
	const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
	const asks = session.asks ?? [];
	if (asks.length === 0) return null;
	const { visible, folded } = shownAsks(asks, opened);
	const answer: Answer =
		onAnswer ??
		((id, allow) => attempt(allow ? "allow it" : "refuse it", () => answerHarness(session.task, id, allow)));
	return (
		<section className="divide-y divide-line-soft" aria-label="Coding permissions">
			{visible.map((ask) => (
				<HarnessAskCard
					key={ask.id}
					ask={ask}
					folder={session.folder}
					place={asks.findIndex((one) => one.id === ask.id)}
					onAnswer={answer}
				/>
			))}
			{folded.length === 0 ? null : (
				<Button
					variant="ghost"
					size="sm"
					type="button"
					className="w-full justify-start px-1 text-ink-2"
					onClick={() => {
						const next = folded[0];
						if (next !== undefined) setOpened((prior) => new Set(prior).add(next.id));
					}}
				>
					{folded.length} more {folded.length === 1 ? "request" : "requests"}
				</Button>
			)}
		</section>
	);
}

const permissionsFor = (session: HarnessSessionView) =>
	(session.asks?.length ?? 0) === 0 ? undefined : <HarnessAsks session={session} />;

/** The session the tool call `call` of chat `chat` started, if one did. */
export function HarnessSessionPart({ chat, call }: { chat: number; call: string }) {
	const { harnesses, agents, companion } = useShell();
	const session = harnesses?.sessions.find((one) => one.chat === chat && one.call === call);
	const agent =
		companion === undefined ? undefined : chatAgents(agents, companion).find((one) => one.id === session?.agent)?.name;
	const live = session !== undefined && session.ended === undefined;
	const now = useNow(live);
	const [open, setOpen] = useState(false);
	const titleRef = useRef<HTMLHeadingElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	if (session === undefined) return null;
	const view = viewOf(session, now, agent);
	const steer = (text: string) => void attempt("send your note", () => steerHarness(session.task, text));
	return (
		<>
			<HarnessCard
				session={view}
				permissions={permissionsFor(session)}
				onStop={() => void attempt("stop it", () => stopHarness(session.task))}
				onOpen={() => {
					// focus returns to the card that opened Steps
					opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
					setOpen(true);
				}}
			/>
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent
					className="flex h-full flex-col gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
					onOpenAutoFocus={(event) => {
						// the sheet opens on its title, not on the first Copy button of a Terminal
						event.preventDefault();
						titleRef.current?.focus();
					}}
					onCloseAutoFocus={(event) => {
						// no Radix trigger: closed, focus returns to the button that opened it
						event.preventDefault();
						opener.current?.focus();
					}}
				>
					<SheetHeader className="border-b border-line-soft pr-12">
						<SheetTitle
							ref={titleRef}
							tabIndex={-1}
							className="rounded-sm outline-none focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-focus"
						>
							{session.service}
						</SheetTitle>
						<SheetDescription>Every step, as it happened.</SheetDescription>
					</SheetHeader>
					<HarnessTranscript session={view} onSteer={steer} follow className="p-4" />
				</SheetContent>
			</Sheet>
		</>
	);
}

/** The header offers the same cards as the feed, then opens the selected session's steps. */
export function useHarnessMenu(sessions: readonly HarnessSessionView[], waiting: boolean) {
	const { harnesses, agents, companion } = useShell();
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<number>();
	const trigger = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (sessions.length === 0 && open) setOpen(false);
	}, [sessions.length, open]);
	const known = companion === undefined ? [] : chatAgents(agents, companion);
	const session = harnesses?.sessions.find((one) => one.task === selected);
	const now = useNow(open || (session !== undefined && session.ended === undefined));
	const nameOf = (one: HarnessSessionView) => known.find((agent) => agent.id === one.agent)?.name;
	return {
		open: () => setOpen(true),
		menu:
			sessions.length === 0 ? undefined : (
				<HarnessMenu
					count={sessions.length}
					waiting={waiting}
					open={open}
					onOpenChange={setOpen}
					triggerRef={trigger}
					onCloseAutoFocus={(event) => {
						if (selected !== undefined) event.preventDefault();
					}}
				>
					{sessions.map((one) => (
						<HarnessCard
							key={one.task}
							session={viewOf(one, now, nameOf(one))}
							permissions={permissionsFor(one)}
							onOpen={() => {
								setOpen(false);
								setSelected(one.task);
							}}
							onStop={() => void attempt("stop it", () => stopHarness(one.task))}
						/>
					))}
				</HarnessMenu>
			),
		details:
			session === undefined ? undefined : (
				<HarnessActivitySheet
					session={session}
					view={viewOf(session, now, nameOf(session))}
					onClose={() => setSelected(undefined)}
					returnFocus={() => trigger.current?.focus()}
				/>
			),
	};
}

function HarnessActivitySheet({
	session,
	view,
	onClose,
	returnFocus,
}: {
	session: HarnessSessionView;
	view: CardView;
	onClose: () => void;
	returnFocus: () => void;
}) {
	const titleRef = useRef<HTMLHeadingElement>(null);
	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<SheetContent
				className="gap-0 overflow-y-auto overscroll-contain data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					titleRef.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					returnFocus();
				}}
			>
				<SheetHeader className="border-b border-line-soft pr-12">
					<SheetTitle
						ref={titleRef}
						tabIndex={-1}
						className="rounded-sm outline-none focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-focus"
					>
						{session.service}
					</SheetTitle>
					<SheetDescription>Recorded work, notes and approvals.</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-3 p-4">
					<HarnessTranscript
						session={view}
						onSteer={(text) => void attempt("send your note", () => steerHarness(session.task, text))}
					/>
					{session.ended === undefined ? (
						<Button variant="destructive" onClick={() => void attempt("stop it", () => stopHarness(session.task))}>
							Stop {session.service}
						</Button>
					) : null}
					{(session.asks?.length ?? 0) === 0 ? null : (
						<HarnessCard session={view} permissions={permissionsFor(session)} />
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
