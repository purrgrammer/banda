/**
 * A harness session in a chat, live from the shell: its card in place of the call that started it, the harness's own
 * asks while it waits on the owner (several may be open), and every step in a sheet. The owner's notes, answers and Stop go to the daemon.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Terminal } from "@/components/ai-elements/terminal";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { answerHarness, steerHarness, stopHarness } from "../areas/harnesses.ts";
import { ApprovalCard } from "../chat/Approval.tsx";
import { type HarnessSessionView as CardView, HarnessCard, HarnessTranscript } from "../chat/Harness.tsx";
import type { HarnessAsk, HarnessSessionView } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import { chatAgents } from "../lib/navigation.ts";
import { useShell } from "../lib/shell.ts";
import { askSummary } from "./harness-activity.ts";

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
	state:
		session.state === "starting"
			? "working"
			: session.state === "failed"
				? "failed"
				: session.state === "waiting" && (session.asks ?? []).length === 0
					? "working"
					: session.state,
	// an open ask is what it waits on: the card's line says so
	steps:
		(session.asks ?? []).length === 0
			? session.steps
			: [...session.steps, { kind: "waiting", command: session.asks?.[0]?.command ?? "" }],
	elapsed: clock((session.ended ?? now) - session.at),
	...(session.outcome === undefined ? {} : { outcome: session.outcome }),
});

/** What an ask would do, in words, by its kind: the owner sees what they allow before they allow it. */
const askWords = (kind: string): { what: string; verb: string; no: string } => {
	const summary = askSummary(kind);
	const what = summary.charAt(0).toUpperCase() + summary.slice(1);
	return kind === "execute"
		? { what, verb: "Run", no: "Don't run" }
		: kind === "edit" || kind === "delete" || kind === "move"
			? { what, verb: "Allow", no: "Don't change" }
			: kind === "fetch"
				? { what, verb: "Allow", no: "Don't open" }
				: { what, verb: "Allow", no: "Don't allow" };
};

/**
 * A long command or diff behind a bounded, scrolling window and "Show all": a sheet with the whole of it (the full
 * screen on a phone). Nothing is cut: the owner can always reach everything they approve.
 */
function Clamped({ text, title, children }: { text: string; title: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	if (text.split("\n").length <= 12) return <>{children}</>;
	return (
		<>
			<div className="max-h-80 overflow-y-auto overscroll-contain rounded-field">{children}</div>
			<Button variant="outline" size="sm" className="self-start" onClick={() => setOpen(true)}>
				Show all
			</Button>
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent className="flex h-full flex-col gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]">
					<SheetHeader className="border-b border-line-soft pr-12">
						<SheetTitle>{title}</SheetTitle>
						<SheetDescription>All of it, before you decide.</SheetDescription>
					</SheetHeader>
					<div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
				</SheetContent>
			</Sheet>
		</>
	);
}

/** One of the harness's open asks: what it would do, all of it the owner must see, Allow or not. */
function HarnessAskCard({
	session,
	ask,
	agentName,
}: {
	session: HarnessSessionView;
	ask: HarnessAsk;
	agentName?: string | undefined;
}) {
	const words = askWords(ask.kind);
	return (
		<ApprovalCard
			agent={session.service}
			what={words.what}
			verb={ask.allow?.name ?? words.verb}
			declineLabel={ask.deny?.name ?? words.no}
			as={`${agentName ?? session.agent}'s task`}
			object={
				<>
					<p className="text-ui break-all text-ink-2">In {session.folder}</p>
					{ask.kind === "execute" ? (
						<Clamped text={ask.command} title={words.what}>
							<Terminal command={ask.command} output="" />
						</Clamped>
					) : (
						<p className="text-ui break-words text-ink">{ask.title ?? ask.command}</p>
					)}
					{ask.detail === undefined ? null : ask.kind === "edit" || ask.kind === "delete" || ask.kind === "move" ? (
						<Clamped text={ask.detail} title="What it would change">
							<CodeBlock code={ask.detail} language="diff" title="What it would change" />
						</Clamped>
					) : (
						<Clamped text={ask.detail} title={words.what}>
							<p className="rounded-field bg-paper-2 px-3.5 py-2.5 text-ui break-words whitespace-pre-wrap text-ink-2">
								{ask.detail}
							</p>
						</Clamped>
					)}
				</>
			}
			onApprove={() => attempt("allow it", () => answerHarness(session.task, ask.id, true))}
			onDecline={() => attempt("refuse it", () => answerHarness(session.task, ask.id, false))}
		/>
	);
}

/**
 * The harness's open asks: the oldest whole, the rest folded to one line, each reviewed whole before it can be
 * approved. There is no approve-all.
 */
export function HarnessAsks({ session, agentName }: { session: HarnessSessionView; agentName?: string | undefined }) {
	const [shown, setShown] = useState(1);
	const asks = session.asks ?? [];
	if (asks.length === 0) return null;
	const visible = asks.slice(0, Math.max(1, Math.min(shown, asks.length)));
	const rest = asks.slice(visible.length);
	return (
		<>
			{visible.map((ask) => (
				<HarnessAskCard key={ask.id} session={session} ask={ask} agentName={agentName} />
			))}
			{rest.length === 0 ? null : (
				<Button variant="outline" size="sm" className="self-start" onClick={() => setShown((count) => count + 1)}>
					{rest.length} more waiting · {rest.map((ask) => askSummary(ask.kind)).join(" · ")}
				</Button>
			)}
		</>
	);
}

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
	if (session === undefined) return null;
	const view = viewOf(session, now, agent);
	const steer = (text: string) => void attempt("send your note", () => steerHarness(session.task, text));
	return (
		<>
			<HarnessCard
				session={view}
				onStop={() => void attempt("stop it", () => stopHarness(session.task))}
				onOpen={() => setOpen(true)}
				onSteer={steer}
			/>
			<HarnessAsks session={session} agentName={agent} />
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent
					className="flex h-full flex-col gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
					onOpenAutoFocus={(event) => {
						// the sheet opens on its title, not on the first Copy button of a Terminal
						event.preventDefault();
						titleRef.current?.focus();
					}}
				>
					<SheetHeader className="border-b border-line-soft pr-12">
						<SheetTitle ref={titleRef} tabIndex={-1} className="outline-none">
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

/** Current delegated work, reachable from the header even when its chat card has scrolled away. */
export function HarnessActivitySheet({ tasks, onClose }: { tasks: readonly number[]; onClose: () => void }) {
	const { harnesses, agents, companion } = useShell();
	const sessions = tasks.flatMap((task) => {
		const session = harnesses?.sessions.find((one) => one.task === task);
		return session === undefined ? [] : [session];
	});
	const [selected, setSelected] = useState<number | undefined>(tasks.length === 1 ? tasks[0] : undefined);
	const session = sessions.find((one) => one.task === selected);
	const now = useNow(sessions.some((one) => one.ended === undefined));
	const agent =
		companion === undefined ? undefined : chatAgents(agents, companion).find((one) => one.id === session?.agent)?.name;
	const titleRef = useRef<HTMLHeadingElement>(null);
	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<SheetContent
				className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					titleRef.current?.focus();
				}}
			>
				<SheetHeader className="border-b border-line-soft pr-12">
					<SheetTitle ref={titleRef} tabIndex={-1} className="outline-none">
						{session?.service ?? "Coding sessions"}
					</SheetTitle>
					<SheetDescription>Recorded work, notes and approvals.</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-3 p-4">
					{session === undefined ? (
						sessions.map((one) => (
							<Button
								key={one.task}
								variant="outline"
								className="h-auto justify-start whitespace-normal text-left"
								onClick={() => setSelected(one.task)}
							>
								{one.service} · session {one.task} ·{" "}
								{(one.asks?.length ?? 0) > 0 ? "Waiting on you" : one.ended === undefined ? "Working" : "Finished"}
							</Button>
						))
					) : (
						<>
							{tasks.length > 1 ? (
								<Button variant="ghost" onClick={() => setSelected(undefined)}>
									All coding sessions
								</Button>
							) : null}
							<HarnessTranscript
								session={viewOf(session, now, agent)}
								onSteer={(text) => void attempt("send your note", () => steerHarness(session.task, text))}
							/>
							{session.ended === undefined ? (
								<Button variant="outline" onClick={() => void attempt("stop it", () => stopHarness(session.task))}>
									Stop {session.service}
								</Button>
							) : null}
							<HarnessAsks session={session} agentName={agent} />
						</>
					)}
					{sessions.length === 0 ? <p>This session is no longer kept.</p> : null}
				</div>
			</SheetContent>
		</Sheet>
	);
}
