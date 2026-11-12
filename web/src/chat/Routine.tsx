/**
 * A routine an agent proposes, in the chat where it asked: the same card as any approval (who asks, what, its facts,
 * one verb and a quiet no), since a routine runs on its own once allowed. A change shows what it becomes; a removal
 * asks to stop it. When it runs and what it asks are the agent's words for the owner: they may edit them before
 * setting it up, and what runs is their version.
 */
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { parseSchedule, whenWords } from "../../../src/core/schedule.ts";
import { Facts } from "./Approval.tsx";
import { Tile } from "./Cards.tsx";
import { EditableText } from "./EditableText.tsx";

/** The owner's edit of a proposed routine, made before allowing it: one schedule line, what it does each run. */
export type RoutineEdit = { readonly when?: string; readonly ask?: string };

export type RoutineProposalView = {
	readonly agent: string;
	/** Its name, as words. */
	readonly title: string;
	readonly kind: "new" | "changed" | "removed";
	/** When it runs, in words, and its next runs. */
	readonly when: string;
	readonly next: readonly string[];
	/** What it asks the agent to do, each run. */
	readonly ask: string;
	/** When it runs as one line (`cron 0 8 * * 1-5`), and the zone its wall times are on: what an edit starts from. */
	readonly schedule?: string | undefined;
	readonly zone?: string | undefined;
};

const SCHEDULE_HINT = "every 4h, at 2026-11-02 09:00, or cron 0 8 * * 1-5";

export function RoutineProposal({
	routine,
	onAllow,
	onDecline,
	settled,
}: {
	routine: RoutineProposalView;
	/** Answered: the result in words ("Set up · 9:12") in place of the buttons. */
	settled?: string | undefined;
	/** Allow it, with the owner's edit when they made one. */
	onAllow?: (edit?: RoutineEdit) => void;
	onDecline?: () => void;
}) {
	const { kind } = routine;
	const what = kind === "new" ? "set up a routine" : kind === "changed" ? "change a routine" : "stop a routine";
	const [when, setWhen] = useState(routine.schedule ?? "");
	const [ask, setAsk] = useState(routine.ask);
	const editable = settled === undefined && onAllow !== undefined && kind !== "removed";
	const parsed = when === routine.schedule ? undefined : parseSchedule(when, routine.zone);
	const whenEdited = routine.schedule !== undefined && when !== routine.schedule;
	const badWhen = whenEdited && parsed === undefined ? `Not a schedule: ${SCHEDULE_HINT}.` : undefined;
	const badAsk = ask !== routine.ask && ask.trim() === "" ? "Say what it does each run." : undefined;
	const edit: RoutineEdit = {
		...(whenEdited ? { when } : {}),
		...(ask === routine.ask ? {} : { ask }),
	};
	return (
		<Tile className="flex flex-col gap-3 p-4">
			<span className="flex flex-col gap-0.5">
				<span className="text-meta text-ink-2">
					{routine.agent} asks to {what}
				</span>
				<span className="text-body font-semibold text-ink">{routine.title}</span>
			</span>
			{kind === "removed" ? null : editable && routine.schedule !== undefined ? (
				<>
					<EditableText
						label="When"
						line
						value={when}
						original={routine.schedule}
						reads={parsed === undefined ? routine.when : whenWords(parsed)}
						hint={SCHEDULE_HINT}
						invalid={badWhen}
						onChange={setWhen}
					>
						{whenEdited || routine.next.length === 0 ? null : (
							<p className="text-meta text-ink-2">Next {routine.next.join(", ")}</p>
						)}
					</EditableText>
					<EditableText label="Each run" value={ask} original={routine.ask} invalid={badAsk} onChange={setAsk} />
				</>
			) : (
				<Facts
					rows={[
						["When", routine.when],
						...(routine.next.length === 0 ? [] : ([["Next", routine.next.join(", ")]] as const)),
						["Each run", routine.ask],
					]}
				/>
			)}
			<p className="text-meta text-ink-2">
				{kind === "removed"
					? "It stops waking; what it said stays in the chat."
					: `It wakes ${routine.agent} on its own; what it finds lands here, and it stays quiet when nothing does.`}
			</p>
			{settled !== undefined ? (
				<span className="flex min-h-9 items-center gap-1.5 text-ui text-ink-2">
					<CheckIcon className="size-4 text-alive" />
					{settled}
				</span>
			) : (
				<span className="flex items-center gap-2">
					<Button
						disabled={badWhen !== undefined || badAsk !== undefined}
						onClick={() => onAllow?.(Object.keys(edit).length === 0 ? undefined : edit)}
					>
						{kind === "removed" ? "Stop it" : kind === "changed" ? "Change it" : "Set it up"}
					</Button>
					<Button variant="ghost" onClick={onDecline}>
						{kind === "removed" ? "Keep it" : "Don't"}
					</Button>
				</span>
			)}
		</Tile>
	);
}
