/** Header and attention state derived only from the daemon's stored harness sessions. */

import type { HarnessSessionView } from "../../../src/server/api.ts";
import type { FaceState } from "../chat/types.ts";
import { projectOf } from "../lib/project.ts";

/** An ask's kind in a few words, for a folded line or a notification: never the command or the path. */
export const askSummary = (kind: string): string =>
	kind === "execute"
		? "run a command"
		: kind === "edit" || kind === "delete" || kind === "move"
			? "change a file"
			: kind === "fetch"
				? "open a web page"
				: "do something";

/**
 * An ask's buttons, by its kind: the verb of what would happen, and a refusal naming what will not. The harness's
 * own option names ("Allow", "Reject") never label the buttons: the owner reads the same words whatever the harness.
 */
export const askWords = (kind: string): { what: string; verb: string; no: string } => {
	const summary = askSummary(kind);
	const what = summary.charAt(0).toUpperCase() + summary.slice(1);
	return kind === "execute"
		? { what, verb: "Run", no: "Don't run" }
		: kind === "edit" || kind === "delete" || kind === "move"
			? { what, verb: "Allow", no: "Don't change" }
			: kind === "fetch"
				? { what, verb: "Allow", no: "Don't open" }
				: { what, verb: "Allow", no: "Don't allow" };
};

/**
 * The device notification's body for harness asks: the harness, what kind of thing it asks, and the project by name;
 * never the command or the path, which would sit in a banner on a lock screen.
 */
export function askNotice(sessions: readonly HarnessSessionView[]): string | undefined {
	const waiting = sessions.filter((session) => (session.asks?.length ?? 0) > 0);
	const first = waiting[0];
	if (first === undefined) return undefined;
	if (waiting.length > 1) return `${first.service} and ${waiting.length - 1} more are waiting on you`;
	return `${first.service} asks to ${askSummary(first.asks?.[0]?.kind ?? "other")} in ${projectOf(first.folder)}`;
}

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
