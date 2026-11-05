/**
 * A harness session in a chat, live from the shell: the card after the approval that started it, Claude Code's own ask
 * when it waits on the owner, and every step in a sheet. The owner's notes, answers and Stop go to the daemon.
 */
import { useEffect, useState } from "react";
import { Terminal } from "@/components/ai-elements/terminal";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { answerHarness, steerHarness, stopHarness } from "../areas/harnesses.ts";
import { ApprovalCard } from "../chat/Approval.tsx";
import { type HarnessSessionView as CardView, HarnessCard, HarnessTranscript } from "../chat/Harness.tsx";
import type { HarnessSessionView } from "../lib/api.ts";
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
	folder: session.folder,
	state:
		session.state === "starting"
			? "working"
			: session.state === "failed"
				? "failed"
				: session.state === "waiting" && session.asking === undefined
					? "working"
					: session.state,
	steps: session.steps,
	elapsed: clock((session.ended ?? now) - session.at),
	...(session.outcome === undefined ? {} : { outcome: session.outcome }),
});

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
	const asking = session.asking;
	return (
		<>
			<HarnessCard
				session={view}
				onStop={() => void attempt("stop it", () => stopHarness(session.task))}
				onOpen={() => setOpen(true)}
				onSteer={steer}
			/>
			{asking === undefined ? null : (
				<ApprovalCard
					agent={session.service}
					what={`Run a command in ${session.folder}`}
					verb="Run"
					declineLabel="Don't run"
					as={`${session.agent}'s task`}
					object={<Terminal command={asking.command} output="" />}
					onApprove={() => attempt("allow it", () => answerHarness(session.task, asking.id, true))}
					onDecline={() => attempt("refuse it", () => answerHarness(session.task, asking.id, false))}
				/>
			)}
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
