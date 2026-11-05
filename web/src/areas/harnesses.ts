/**
 * Harnesses in the app (DESIGN.md "Connections"): Claude Code on the owner's computer, as the daemon last pushed it,
 * and the owner's calls: connect a folder, steer a session, answer its ask, stop it.
 */
import { api, type HarnessesView, type HarnessSessionView } from "../lib/api.ts";
import type { ShellHandlers } from "../lib/shell.ts";

declare module "../lib/shell.ts" {
	interface Shell {
		/** What banda can hand coding work to, where each is connected, and every session; undefined until said. */
		readonly harnesses?: HarnessesView;
	}
}

export const shell: ShellHandlers = {
	harnesses: (event) => ({ harnesses: event.harnesses }),
};

/** Connect `harness` in `folder`, on for `agent` when named. */
export const connectHarness = (harness: string, folder: string, agent?: string) =>
	api<HarnessesView>(`/harnesses/${harness}/connect`, {
		method: "POST",
		body: JSON.stringify({ folder, ...(agent === undefined ? {} : { agent }) }),
	});

/** Turn `harness` on or off for `agent`. */
export const switchHarness = (harness: string, agent: string, on: boolean) =>
	api<HarnessesView>(`/harnesses/${harness}/switch`, { method: "POST", body: JSON.stringify({ agent, on }) });

/** Forget `harness`'s folder; what runs there stops. */
export const disconnectHarness = (harness: string) =>
	api<HarnessesView>(`/harnesses/${harness}/disconnect`, { method: "POST", body: "{}" });

const act = (task: number, action: string, body: object) =>
	api<HarnessesView>(`/harnesses/sessions/${task}/${action}`, { method: "POST", body: JSON.stringify(body) });

/** The owner's note, taken after the current step. */
export const steerHarness = (task: number, text: string) => act(task, "steer", { text });
/** Stop the session. */
export const stopHarness = (task: number) => act(task, "stop", {});
/** Allow or refuse the harness's open ask. */
export const answerHarness = (task: number, ask: string, allow: boolean) => act(task, "answer", { ask, allow });

/** A chat's sessions, oldest first: the order its calls were made in. */
export const sessionsOf = (sessions: readonly HarnessSessionView[] | undefined, chat: number) =>
	(sessions ?? []).filter((session) => session.chat === chat).sort((a, b) => a.at - b.at);
