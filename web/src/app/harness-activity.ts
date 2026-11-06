/** Header and attention state derived only from the daemon's stored harness sessions. */

import type { HarnessSessionView } from "../../../src/server/api.ts";
import type { FaceState } from "../chat/types.ts";

export function harnessActivity(sessions: readonly HarnessSessionView[], chats: readonly number[]) {
	const active = sessions.filter(
		(session) =>
			chats.includes(session.chat) &&
			session.ended === undefined &&
			["starting", "working", "waiting"].includes(session.state),
	);
	const waiting = active.some((session) => (session.asks?.length ?? 0) > 0);
	active.sort((a, b) => Number((b.asks?.length ?? 0) > 0) - Number((a.asks?.length ?? 0) > 0) || b.at - a.at);
	const first = active[0];
	let label: string | undefined;
	if (first !== undefined) {
		if (waiting)
			label =
				active.length > 1 ? `Waiting on you · ${active.length} coding sessions` : `Waiting on you · ${first.service}`;
		else if (active.length > 1) label = `${active.length} coding sessions running`;
		else {
			const step = first.steps.filter((step) => step.kind !== "steered" || step.taken).at(-1);
			const action =
				step?.kind === "read"
					? "reading a file"
					: step?.kind === "edit"
						? "changing a file"
						: step?.kind === "run" && step.running !== false
							? "running a command"
							: "working";
			label = `${first.service} is ${action}…`;
		}
	}
	return { sessions: active, waiting, label };
}

export function chatActivity(own: FaceState, doing: string | undefined, delegated: ReturnType<typeof harnessActivity>) {
	const primary = own === "idle" && delegated.sessions.length > 0;
	return {
		state: primary ? (delegated.waiting ? ("waiting" as const) : ("working" as const)) : own,
		doing: primary ? delegated.label : own === "working" ? doing : undefined,
		delegatedPrimary: primary,
		attention: own === "waiting" || delegated.waiting,
		secondary: !primary && delegated.sessions.length > 0,
	};
}
