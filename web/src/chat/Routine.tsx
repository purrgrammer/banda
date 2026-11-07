/**
 * A routine an agent proposes, in the chat where it asked: the same card as any approval (who asks, what, its facts,
 * one verb and a quiet no), since a routine runs on its own once allowed. A change shows what it becomes; a removal
 * asks to stop it.
 */
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Facts } from "./Approval.tsx";
import { Tile } from "./Cards.tsx";

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
};

export function RoutineProposal({
	routine,
	onAllow,
	onDecline,
	settled,
}: {
	routine: RoutineProposalView;
	/** Answered: the result in words ("Set up · 9:12") in place of the buttons. */
	settled?: string | undefined;
	onAllow?: () => void;
	onDecline?: () => void;
}) {
	const { kind } = routine;
	const what = kind === "new" ? "set up a routine" : kind === "changed" ? "change a routine" : "stop a routine";
	return (
		<Tile className="flex flex-col gap-3 p-4">
			<span className="flex flex-col gap-0.5">
				<span className="text-meta text-ink-2">
					{routine.agent} asks to {what}
				</span>
				<span className="text-body font-semibold text-ink">{routine.title}</span>
			</span>
			{kind === "removed" ? null : (
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
				<span className="flex items-center gap-1.5 text-ui text-ink-2">
					<CheckIcon className="size-4 text-ink" />
					{settled}
				</span>
			) : (
				<span className="flex items-center gap-2">
					<Button onClick={onAllow}>
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
