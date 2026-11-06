/** What the band and the header say of harness sessions, derived only from the daemon's stored sessions. */

import type { HarnessSessionView } from "../../../src/server/api.ts";

/** A chat's sessions running now (an agent's chat, or a group's members' chats), and whether one waits on the owner. */
export function harnessActivity(sessions: readonly HarnessSessionView[], chats: readonly number[]) {
	const active = sessions.filter(
		(session) =>
			chats.includes(session.chat) &&
			session.ended === undefined &&
			["starting", "working", "waiting"].includes(session.state),
	);
	return { sessions: active, waiting: active.some((session) => (session.asks?.length ?? 0) > 0) };
}

/**
 * Every session running anywhere, for the header's harness button: those waiting on the owner first, then this chat's
 * (`here`), then the newest. `waiting` lights its dot.
 */
export function runningSessions(sessions: readonly HarnessSessionView[], here: readonly number[]) {
	const live = sessions.filter(
		(session) => session.ended === undefined && ["starting", "working", "waiting"].includes(session.state),
	);
	const asks = (session: HarnessSessionView) => Number((session.asks?.length ?? 0) > 0);
	const mine = (session: HarnessSessionView) => Number(here.includes(session.chat));
	live.sort((a, b) => asks(b) - asks(a) || mine(b) - mine(a) || b.at - a.at);
	return { sessions: live, waiting: live.some((session) => asks(session) === 1) };
}

/** When a session last reached the owner: its newest open ask, else nothing (its own steps never reorder the band). */
export function askedAt(sessions: readonly HarnessSessionView[]): number | undefined {
	const times = sessions.flatMap((session) => (session.asks ?? []).map((ask) => ask.at));
	return times.length === 0 ? undefined : Math.max(...times);
}
