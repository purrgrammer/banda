/**
 * A harness session in a chat, live from the shell: its card in place of the call that started it, the harness's own
 * asks while it waits on the owner (several may be open), and every step in a sheet. The owner's notes, answers and Stop go to the daemon.
 */
import { useEffect, useState } from "react";
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
const askWords = (kind: string): { what: string; verb: string; no: string } =>
	kind === "execute"
		? { what: "Run a command", verb: "Run", no: "Don't run" }
		: kind === "edit" || kind === "delete" || kind === "move"
			? { what: "Change a file", verb: "Allow", no: "Don't" }
			: kind === "fetch"
				? { what: "Open a web page", verb: "Allow", no: "Don't" }
				: { what: "Do something", verb: "Allow", no: "Don't" };

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
			declineLabel={ask.deny?.name ?? "Cancel"}
			as={`${agentName ?? session.agent}'s task`}
			object={
				<>
					<p className="text-ui break-all text-ink-2">In {session.folder}</p>
					{ask.kind === "execute" ? (
						<Terminal command={ask.command} output="" />
					) : (
						<p className="text-ui break-words text-ink">{ask.title ?? ask.command}</p>
					)}
					{ask.detail === undefined ? null : ask.kind === "edit" || ask.kind === "delete" || ask.kind === "move" ? (
						<CodeBlock code={ask.detail} language="diff" title="What it would change" />
					) : (
						<p className="rounded-field bg-paper-2 px-3.5 py-2.5 text-ui break-words whitespace-pre-wrap text-ink-2">
							{ask.detail}
						</p>
					)}
				</>
			}
			onApprove={() => attempt("allow it", () => answerHarness(session.task, ask.id, true))}
			onDecline={() => attempt("refuse it", () => answerHarness(session.task, ask.id, false))}
		/>
	);
}

/**
 * A session in a transcript: the one the tool call `call` of chat `chat` started, or session `task` (a group shows its
 * members' running sessions by number, their calls being in the members' own chats).
 */
export function HarnessSessionPart(where: { chat: number; call: string } | { task: number }) {
	const { harnesses, agents, companion } = useShell();
	const session = harnesses?.sessions.find((one) =>
		"task" in where ? one.task === where.task : one.chat === where.chat && one.call === where.call,
	);
	const agent =
		companion === undefined ? undefined : chatAgents(agents, companion).find((one) => one.id === session?.agent)?.name;
	const live = session !== undefined && session.ended === undefined;
	const now = useNow(live);
	const [open, setOpen] = useState(false);
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
			{(session.asks ?? []).map((ask) => (
				<HarnessAskCard key={ask.id} session={session} ask={ask} agentName={agent} />
			))}
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]">
					<SheetHeader className="border-b border-line-soft pr-12">
						<SheetTitle>{session.service}</SheetTitle>
						<SheetDescription>Every step, as it happened.</SheetDescription>
					</SheetHeader>
					<div className="p-4">
						<HarnessTranscript session={view} onSteer={steer} />
					</div>
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
	const nameOf = (id: string | undefined) =>
		companion === undefined ? undefined : chatAgents(agents, companion).find((one) => one.id === id)?.name;
	const agent = nameOf(session?.agent);
	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]">
				<SheetHeader className="border-b border-line-soft pr-12">
					<SheetTitle>{session?.service ?? "Coding sessions"}</SheetTitle>
					<SheetDescription>Recorded work, notes and approvals.</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-3 p-4">
					{session === undefined ? (
						sessions.map((one) => (
							<HarnessCard
								key={one.task}
								session={viewOf(one, now, nameOf(one.agent))}
								onStop={() => void attempt("stop it", () => stopHarness(one.task))}
								onOpen={() => setSelected(one.task)}
								onSteer={(text) => void attempt("send your note", () => steerHarness(one.task, text))}
							/>
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
							{(session.asks ?? []).map((ask) => (
								<HarnessAskCard key={ask.id} session={session} ask={ask} agentName={agent} />
							))}
						</>
					)}
					{sessions.length === 0 ? <p>This session is no longer kept.</p> : null}
				</div>
			</SheetContent>
		</Sheet>
	);
}
