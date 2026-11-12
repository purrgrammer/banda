/**
 * A routine's runs as its detail's lines, pure, for the tests: when each was, and what came of it in words,
 * and whether it opens its line in the chat.
 */
import type { RoutineRunView } from "../../../src/server/api.ts";
import { nearTime } from "../app/titles.ts";
import { failureWords } from "./chat.ts";

/** One run as its line shows it. */
export type RunRowView = {
	/** Its key, stable across pages: when it ran. */
	readonly key: number;
	/** When, in words: "Today 08:00". */
	readonly when: string;
	/** What came of it, in words: "Said: 2 PRs need you", "Said nothing", "Failed: …", "Running now". */
	readonly words: string;
	/** How it reads: quiet (said nothing, skipped, stopped), said, trouble (failed), or live (waiting, running). */
	readonly tone: "quiet" | "said" | "trouble" | "live";
	/** Open its line in the chat; absent when the chat draws none. */
	readonly onOpen?: (() => void) | undefined;
};

/** When a run was, in words: "Today 08:00", "Wed 08:00", "3 Nov 08:00". */
export function runTime(at: number, now: number): string {
	const midnight = (when: number) => new Date(when).setHours(0, 0, 0, 0);
	const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);
	if (days >= 2 && days < 7) {
		const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return `${new Date(at).toLocaleDateString([], { weekday: "short" })} ${time}`;
	}
	return nearTime(at, now);
}

/** What came of a run, in words, and how its line reads. `agent` is the agent's name. */
export function runWords(run: RoutineRunView, agent: string): Pick<RunRowView, "words" | "tone"> {
	switch (run.state) {
		case "waiting":
			return { words: "Waiting its turn in the chat", tone: "live" };
		case "running":
			return { words: "Running now", tone: "live" };
		case "said":
			return { words: `Said: ${run.said ?? ""}`, tone: "said" };
		case "quiet":
			return { words: "Said nothing", tone: "quiet" };
		case "failed":
			// in the feed's words, without the daemon's reason code ("model_error: "): a provider's raw error reads as
			// what it means
			return {
				words:
					run.why === undefined
						? "Failed"
						: `Failed: ${failureWords(run.why.replace(/^[a-z]+(?:_[a-z]+)+: /, "")).replace(/\.$/, "")}`,
				tone: "trouble",
			};
		case "stopped":
			return { words: "Stopped before it finished", tone: "quiet" };
		case "skipped":
			return {
				words:
					run.skipped === "limit"
						? "Paused itself: it ran the most times a day it may"
						: run.skipped === "inactive"
							? `Skipped: ${agent} wasn't active`
							: "Skipped: its last run was still going",
				tone: "quiet",
			};
	}
}

/**
 * A routine's runs as its detail's lines, newest first, read at `now`: each opens its line in chat `chat` (the agent's,
 * shown beside the panel) through `onOpen`, when the chat draws one there; a quiet run, a skipped one, and one in
 * another chat open nothing.
 */
export function runRows(
	runs: readonly RoutineRunView[],
	now: number,
	agent: string,
	chat: number | undefined,
	onOpen: (run: RoutineRunView, entry: number) => void,
): RunRowView[] {
	return runs.map((run) => {
		const line = run.line !== undefined && run.line.chat === chat ? run.line : undefined;
		return {
			key: run.at,
			when: run.owner === true ? `${runTime(run.at, now)} · you ran it` : runTime(run.at, now),
			...runWords(run, agent),
			...(line === undefined ? {} : { onOpen: () => onOpen(run, line.entry) }),
		};
	});
}
