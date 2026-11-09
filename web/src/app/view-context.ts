/** What a chat's segments are made from besides its items (`../lib/segments/types.ts`): the shell's state, for this chat. */
import { useMemo } from "react";
import type { ViewContext } from "../lib/segments/types.ts";
import { browserOf, useShell } from "../lib/shell.ts";

/** A chat's view context; the same object while nothing it reads changed. */
export function useViewContext(chat: number): ViewContext {
	const shell = useShell();
	const { capabilities, agents, control, artifacts: library, memory, watches } = shell;
	const routines = control?.routines;
	const removed = control?.removed;
	// this chat's own tab, while it runs
	const view = browserOf(shell, chat);
	const browser = view?.running === true && view.chat === chat ? view : undefined;
	return useMemo(
		(): ViewContext => ({
			agents,
			...(routines === undefined ? {} : { routines }),
			...(watches === undefined ? {} : { watches }),
			...(library === undefined ? {} : { artifacts: { chat, library } }),
			...(browser === undefined ? {} : { browser }),
			...(memory === undefined ? {} : { memory }),
			...(removed === undefined ? {} : { removed }),
			...(capabilities === undefined ? {} : { capabilities }),
		}),
		[chat, agents, routines, watches, library, browser, memory, removed, capabilities],
	);
}
