/**
 * A watch in the chat (DESIGN.md "Watches"). The card an agent's proposal waits as: the same card as any approval
 * (who asks, what, its facts, one verb and a quiet no), since a watch looks on its own once allowed; a change shows
 * what it becomes, a removal asks to stop following. And the line each change the kind's rules say matters draws:
 * who saw what, on which object, as every feed item reads.
 */
import { EyeOffIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Facts } from "./Approval.tsx";
import { Tile } from "./Cards.tsx";
import { Line } from "./Line.tsx";

/** An object named in a quiet line, standing out: primary text; its title is the link the object draws itself. */
/** The object a line names, with what sits right after it, never broken apart: the link truncates instead. */
export function Named({ children }: { children: ReactNode }) {
	return <span className="whitespace-nowrap font-medium text-ink">{children}</span>;
}

/**
 * A watch's line in the chat: the object, then what changed on it, narrated with no icon, as the chat's own voice. The
 * object is drawn as the owner's references are (`object`: the service's mark, its state, its linked title; the app
 * reads it from the daemon, the specimen gives it), in primary text, its name until then; the words that follow are
 * the changes in the kind's words, with what came together since when, what came from a pause, what ended it, and
 * whether some changes may be missing (`text`, as `watchWords` says it, which begins with the object's name). A change
 * that only tells draws the same line and runs nothing. The last line, the one that ended the watch, carries the
 * closed eye: the eyes mark following and its end, nothing else.
 */
export function WatchLine({
	name,
	text,
	object,
	ended = false,
	time,
	onClick,
}: {
	/** The object's name, as the daemon names it. */
	name: string;
	/** The line's words: the name, then the changes. */
	text: string;
	object?: ReactNode;
	ended?: boolean;
	time?: string | undefined;
	/** Opens the watch in the agent's panel. */
	onClick?: (() => void) | undefined;
}) {
	const rest = (text.startsWith(name) ? text.slice(name.length) : ` · ${text}`).replace(/^ · /, ": ");
	// the colon stays with the object, so a line that wraps after the link never begins with it
	const colon = rest.startsWith(":") ? ":" : "";
	return (
		<Line icon={ended ? EyeOffIcon : undefined} time={time} onClick={onClick}>
			<Named>
				{object ?? <span data-object-inline="">{name}</span>}
				{colon}
			</Named>
			{rest.slice(colon.length)}
		</Line>
	);
}

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
	/** The most times it may wake in a day, when the file gives one. */
	readonly wakesADay?: number;
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
						...(watch.wakesADay === undefined ? [] : ([["Wakes", `at most ${watch.wakesADay} a day`]] as const)),
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
				<Button variant={kind === "removed" ? "destructive" : "default"} onClick={onAllow}>
					{kind === "removed" ? "Stop it" : kind === "changed" ? "Change it" : "Follow it"}
				</Button>
				<Button variant="ghost" onClick={onDecline}>
					{kind === "removed" ? "Keep it" : "Don't"}
				</Button>
			</span>
		</Tile>
	);
}
