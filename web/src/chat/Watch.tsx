/**
 * A watch an agent proposes, in the chat where it asked: the same card as any approval (who asks, what, its facts,
 * one verb and a quiet no), since a watch looks on its own once allowed. A change shows what it becomes; a removal
 * asks to stop following.
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Facts } from "./Approval.tsx";
import { Tile } from "./Cards.tsx";

export type WatchProposalView = {
	readonly agent: string;
	/** What it follows, as the daemon names it, else the link. */
	readonly title: string;
	/** The object drawn inline (its mark, state and linked title), in place of the title's words. */
	readonly object?: ReactNode;
	readonly kind: "new" | "changed" | "removed";
	/** What ends it, in words: "merged", "merged or closed". */
	readonly until: string;
	/** The account it looks with, when the service has one. */
	readonly account?: string;
	/** What matters, and what to do about it. */
	readonly ask: string;
};

export function WatchProposal({
	watch,
	onAllow,
	onDecline,
}: {
	watch: WatchProposalView;
	onAllow?: () => void;
	onDecline?: () => void;
}) {
	const { kind } = watch;
	const what = kind === "new" ? "follow" : kind === "changed" ? "change how it follows" : "stop following";
	return (
		<Tile className="flex flex-col gap-3 p-4">
			<span className="flex flex-col gap-0.5">
				<span className="text-meta text-ink-2">
					{watch.agent} asks to {what}
				</span>
				<span className="text-body font-semibold text-ink [overflow-wrap:anywhere]">{watch.object ?? watch.title}</span>
			</span>
			{kind === "removed" ? null : (
				<Facts
					rows={[
						["Until", watch.until],
						...(watch.account === undefined ? [] : ([["As", watch.account]] as const)),
						["What matters", watch.ask],
					]}
				/>
			)}
			<p className="text-meta text-ink-2">
				{kind === "removed"
					? "It stops looking; what it saw stays in the chat."
					: `banda reads it on its own and wakes ${watch.agent} with what changed; ${watch.agent} stays quiet when nothing matters.`}
			</p>
			<span className="flex items-center gap-2">
				<Button onClick={onAllow}>
					{kind === "removed" ? "Stop it" : kind === "changed" ? "Change it" : "Follow it"}
				</Button>
				<Button variant="ghost" onClick={onDecline}>
					{kind === "removed" ? "Keep it" : "Don't"}
				</Button>
			</span>
		</Tile>
	);
}
