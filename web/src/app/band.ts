/**
 * The band as the sidebar lists it (DESIGN.md "The app"): one row per agent and one per group, newest first. An
 * agent's row is its one chat's; an agent that has said nothing yet still has its row. Pure, for the tests.
 */

import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import type { ChatRow, GroupRow, HarnessSessionView } from "../../../src/server/api.ts";
import type { FaceState, RowView, Who } from "../chat/types.ts";
import { agentMainOf } from "../lib/chats.ts";
import type { ChatAgent } from "../lib/navigation.ts";
import { firstWords } from "./first-words.ts";
import { harnessActivity } from "./harness-activity.ts";

/** The time at a row's right: the hour today, the weekday this week, else the day and month. */
export function rowTime(at: number | undefined, now: number): string {
	if (at === undefined) return "";
	const when = new Date(at);
	const day = 24 * 60 * 60 * 1000;
	if (new Date(now).toDateString() === when.toDateString())
		return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (new Date(now - day).toDateString() === when.toDateString()) return "Yesterday";
	if (now - at < 6 * day) return when.toLocaleDateString([], { weekday: "short" });
	return when.toLocaleDateString([], { day: "numeric", month: "short" });
}

const stateOf = (row: ChatRow | undefined): FaceState | undefined =>
	row === undefined ? undefined : row.state === "running" ? "working" : row.state === "waiting" ? "waiting" : "idle";

/** An agent's face and name, as the band shows it; a member no longer in the band keeps its id as its name. */
export const whoOf = (agents: readonly ChatAgent[], id: string): Who & { readonly id: string } => {
	const agent = agents.find((each) => each.id === id);
	return { id, face: agent?.face ?? defaultAvatarFace(), name: agent?.name ?? id };
};

export type BandRow = RowView & {
	readonly at: number;
	readonly to: { name: "agent"; id: string } | { name: "group"; room: number };
};

/** A change an agent made that waits for the owner, as its row says it: its own file, or a routine it wrote. */
export type Waiting = { readonly agent: string; readonly words: string };

export function bandRows(
	agents: readonly ChatAgent[],
	rows: readonly ChatRow[],
	groups: readonly GroupRow[],
	paused: boolean,
	now: number,
	waiting: readonly Waiting[] = [],
	/** Archived agents: no row of their own, but a group they were in still shows their faces. */
	archived: readonly ChatAgent[] = [],
	sessions: readonly HarnessSessionView[] = [],
): BandRow[] {
	const known = [...agents, ...archived];
	const agentRows = agents.map((agent): BandRow => {
		const main = agentMainOf(rows, agent.id);
		const delegated = harnessActivity(sessions, main === undefined ? [] : [main.chat]);
		// ordered and timed by the newest thing that reached the owner, never by a run's own steps; one that has said
		// nothing yet by when the owner made it (or last changed it), so a new agent comes first
		const at = main?.said ?? agent.since ?? 0;
		return {
			id: `a:${agent.id}`,
			to: { name: "agent", id: agent.id },
			name: agent.name,
			faces: [{ id: agent.id, face: agent.face, name: agent.name }],
			// before anything was said, its first words, as its chat shows them
			excerpt: main?.excerpt ?? firstWords(agent.name, agent.id === "sancho" ? undefined : (agent.tools ?? [])),
			...(main?.by === "owner" ? { by: "You" } : {}),
			time: rowTime(main?.said, now),
			at,
			unread: main?.unread ?? 0,
			...(main?.ask !== undefined
				? { ask: main.ask }
				: (() => {
						if (delegated.waiting)
							return {
								ask: `${delegated.sessions.length} coding session${delegated.sessions.length === 1 ? "" : "s"}`,
							};
						const change = waiting.find((each) => each.agent === agent.id);
						return change === undefined ? {} : { ask: change.words };
					})()),
			state:
				delegated.waiting || stateOf(main) === "waiting"
					? "waiting"
					: stateOf(main) === "working"
						? "working"
						: delegated.sessions.length > 0
							? "working"
							: stateOf(main),
			paused,
		};
	});
	const groupRows = groups.map((group): BandRow => {
		const at = group.last?.at ?? group.at;
		const delegated = harnessActivity(sessions, Object.values(group.executions ?? {}));
		const last = group.last;
		const by = last === undefined ? undefined : "owner" in last.author ? "You" : whoOf(known, last.author.agent).name;
		return {
			id: `g:${group.room}`,
			to: { name: "group", room: group.room },
			name: group.name,
			faces: group.members.map((member) => ({
				...whoOf(known, member),
				paused: paused || archived.some((agent) => agent.id === member),
				...(group.working.includes(member) ? { state: "working" as const } : {}),
			})),
			excerpt:
				last === undefined
					? "Say hello to everyone"
					: last.text.trim() === "" && last.reaction !== undefined
						? `Reacted ${last.reaction.emoji}`
						: last.text.replace(/\s+/g, " ").slice(0, 160),
			...(by === undefined ? {} : { by }),
			time: rowTime(at, now),
			at,
			unread: group.unread,
			...(group.asking.length === 0
				? delegated.waiting
					? { ask: `${delegated.sessions.length} coding session${delegated.sessions.length === 1 ? "" : "s"}` }
					: {}
				: { ask: `${group.asking.length === 1 ? "a member asks" : `${group.asking.length} asks`}` }),
		};
	});
	return [...agentRows, ...groupRows].sort((a, b) => b.at - a.at);
}

/** The tab's title: asks first, then unread, then the app's name. */
export function titleOf(rows: readonly BandRow[]): string {
	const asks = rows.filter((row) => row.ask !== undefined).length;
	const unread = rows.reduce((total, row) => total + (row.unread ?? 0), 0);
	const counts = [asks === 0 ? undefined : `${asks} waiting`, unread === 0 ? undefined : `${unread} unread`].filter(
		Boolean,
	);
	return counts.length === 0 ? "banda" : `(${counts.join(", ")}) banda`;
}
