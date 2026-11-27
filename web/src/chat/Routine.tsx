/**
 * A routine an agent proposes, in the chat where it asked: the same card as any approval (who asks, what, its facts,
 * one verb and a quiet no), since a routine runs on its own once allowed. Who asks and whom it runs as are each said:
 * a routine runs as the agent whose folder holds it (or, shared, the one it belongs to), whoever wrote it, and another
 * routine of its name that wakes the same agent is said too, since both run. A change shows what it becomes; a removal
 * asks to stop it. When it runs and what it asks are the agent's words for the owner: they may edit them before
 * setting it up, and what runs is their version.
 */
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { parseSchedule, whenWords } from "../../../src/core/schedule.ts";
import { failureWords } from "../lib/attempt.ts";
import { Facts } from "./Approval.tsx";
import { Tile } from "./Cards.tsx";
import { EditableText } from "./EditableText.tsx";

/** The owner's edit of a proposed routine, made before allowing it: one schedule line, what it does each run. */
export type RoutineEdit = { readonly when?: string; readonly ask?: string };

export type RoutineProposalView = {
	/** The agent that asks: the one whose chat this is. */
	readonly agent: string;
	/** The agent it runs as, with that agent's instructions and access, waking its chat; `agent` when the same. */
	readonly runsAs?: string | undefined;
	/** In the shared `routines/` rather than its agent's own folder. */
	readonly shared?: boolean | undefined;
	/** Another routine of its name wakes the same agent: a shared one beside its own, or its own beside a shared one. */
	readonly twin?: "own" | "shared" | undefined;
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

/** What a schedule line takes, its one-time example tomorrow: an example the daemon would refuse as passed helps no one. */
function scheduleHint(now = new Date()): string {
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	const day = [tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate()]
		.map((part) => String(part).padStart(2, "0"))
		.join("-");
	return `every 4h, at ${day} 09:00, or cron 0 8 * * 1-5`;
}

type Props = {
	routine: RoutineProposalView;
	/** Answered: the result in words ("Set up · 9:12") in place of the buttons. */
	settled?: string | undefined;
	/** Allow it, with the owner's edit when they made one; a promise that rejects is the daemon's refusal, said on the card. */
	onAllow?: (edit?: RoutineEdit) => unknown;
	onDecline?: () => unknown;
	/** Why the last answer did not happen, in words, when known from outside (the specimen's). */
	problem?: string | undefined;
};

/** What an answer that did not happen says on the card: what did not happen, and the daemon's words for why. */
export const problemWords = (what: string, error: unknown): string => `Couldn't ${what}. ${failureWords(error)}`;

/**
 * The owner's edit is of the words they were shown: when the agent writes the routine again while the card is open, the
 * card starts afresh from the new words, never carrying an edit of the old ones onto a version they did not edit.
 */
export function RoutineProposal(props: Props) {
	return <Proposed key={`${props.routine.schedule ?? ""}\n${props.routine.ask}`} {...props} />;
}

function Proposed({ routine, onAllow, onDecline, settled, problem }: Props) {
	const { kind } = routine;
	const runsAs = routine.runsAs ?? routine.agent;
	const elsewhere = runsAs !== routine.agent;
	const what =
		(kind === "new" ? "set up a routine" : kind === "changed" ? "change a routine" : "stop a routine") +
		(elsewhere ? ` for ${runsAs}` : "");
	const scope = routine.shared === true ? `Shared routine · runs as ${runsAs}` : `${runsAs}'s own routine`;
	const [when, setWhen] = useState(routine.schedule ?? "");
	const [ask, setAsk] = useState(routine.ask);
	// an answer under way, and why the last one did not happen: the card stays as it was, its buttons with it, so the
	// owner reads what the daemon said and answers again, or looks again
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState<string | undefined>(undefined);
	const answer = (did: string, run: (() => unknown) | undefined) => {
		setFailed(undefined);
		const result = run?.();
		if (!(result instanceof Promise)) return;
		setBusy(true);
		result.then(
			() => setBusy(false),
			(error: unknown) => {
				setBusy(false);
				setFailed(problemWords(did, error));
			},
		);
	};
	const shown = problem ?? failed;
	const editable = settled === undefined && onAllow !== undefined && kind !== "removed";
	const parsed = when === routine.schedule ? undefined : parseSchedule(when, routine.zone);
	const whenEdited = routine.schedule !== undefined && when !== routine.schedule;
	const hint = scheduleHint();
	const badWhen = whenEdited && parsed === undefined ? `Not a schedule: ${hint}.` : undefined;
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
				<span className="text-meta text-ink-2" data-routine-scope>
					{scope}
				</span>
			</span>
			{routine.twin === undefined || kind === "removed" ? null : (
				<p className="text-meta text-ink" role="note" data-routine-twin>
					{routine.twin === "shared"
						? `A shared routine of this name also runs as ${runsAs}: both will run.`
						: `${runsAs}'s own routine of this name also runs: both will run.`}
				</p>
			)}
			{kind === "removed" ? null : editable && routine.schedule !== undefined ? (
				<>
					<EditableText
						label="When"
						line
						value={when}
						original={routine.schedule}
						reads={parsed === undefined ? routine.when : whenWords(parsed)}
						hint={hint}
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
					: elsewhere
						? `It wakes ${runsAs} on its own, with ${runsAs}'s instructions and access; what it finds lands in ${runsAs}'s chat, not here.`
						: `It wakes ${runsAs} on its own; what it finds lands here, and it stays quiet when nothing does.`}
			</p>
			{shown === undefined || settled !== undefined ? null : (
				<p role="alert" className="text-meta text-danger" data-routine-problem>
					{shown}
				</p>
			)}
			{settled !== undefined ? (
				<span className="flex min-h-9 items-center gap-1.5 text-ui text-ink-2">
					<CheckIcon className="size-4 text-alive" />
					{settled}
				</span>
			) : (
				<span className="flex items-center gap-2">
					<Button
						variant={kind === "removed" ? "destructive" : "default"}
						disabled={busy || badWhen !== undefined || badAsk !== undefined}
						onClick={() =>
							answer(kind === "removed" ? "stop it" : kind === "changed" ? "change it" : "set it up", () =>
								onAllow?.(Object.keys(edit).length === 0 ? undefined : edit),
							)
						}
					>
						{kind === "removed" ? "Stop it" : kind === "changed" ? "Change it" : "Set it up"}
					</Button>
					<Button
						variant="ghost"
						disabled={busy}
						onClick={() => answer(kind === "removed" ? "keep it" : "decline it", onDecline)}
					>
						{kind === "removed" ? "Keep it" : "Don't"}
					</Button>
				</span>
			)}
		</Tile>
	);
}
