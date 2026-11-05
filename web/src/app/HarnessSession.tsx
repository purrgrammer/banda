/**
 * A harness session in a chat, live from the shell: its card in place of the call that started it, the harness's own
 * asks while it waits on the owner (several may be open), and every step in a sheet. The owner's notes, answers and Stop go to the daemon.
 */
import { useEffect, useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Terminal } from "@/components/ai-elements/terminal";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { answerHarness, steerHarness, stopHarness } from "../areas/harnesses.ts";
import { ApprovalCard } from "../chat/Approval.tsx";
import { type HarnessSessionView as CardView, HarnessCard, HarnessTranscript } from "../chat/Harness.tsx";
import type { HarnessAsk, HarnessSessionView } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
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

const viewOf = (session: HarnessSessionView, now: number): CardView => ({
	harness: session.service,
	...(session.provider === undefined ? {} : { provider: session.provider }),
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
function HarnessAskCard({ session, ask }: { session: HarnessSessionView; ask: HarnessAsk }) {
	const words = askWords(ask.kind);
	return (
		<ApprovalCard
			agent={session.service}
			what={`${words.what} in ${session.folder}`}
			verb={words.verb}
			declineLabel={words.no}
			as={`${session.agent}'s task`}
			object={
				<>
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

/** The session the tool call `call` of chat `chat` started, if one did. */
export function HarnessSessionPart({ chat, call }: { chat: number; call: string }) {
	const { harnesses } = useShell();
	const session = harnesses?.sessions.find((one) => one.chat === chat && one.call === call);
	const live = session !== undefined && session.ended === undefined;
	const now = useNow(live);
	const [open, setOpen] = useState(false);
	if (session === undefined) return null;
	const view = viewOf(session, now);
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
				<HarnessAskCard key={ask.id} session={session} ask={ask} />
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
