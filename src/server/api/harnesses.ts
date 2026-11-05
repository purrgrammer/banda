/**
 * The API's shapes for harnesses (DESIGN.md "Connections"): what banda can hand coding work to, the folder each is
 * connected in and for whom, and every session, live. Re-exported by `../api.ts`.
 */
import type { HarnessAsk, HarnessState, HarnessStep } from "../../core/harness.ts";

export type { HarnessAsk, HarnessState, HarnessStep } from "../../core/harness.ts";

export type HarnessSessionView = {
	readonly task: number;
	readonly chat: number;
	/** The tool call that asked for it. */
	readonly call?: string;
	readonly agent: string;
	readonly harness: string;
	readonly service: string;
	readonly folder: string;
	readonly state: HarnessState;
	readonly at: number;
	readonly ended?: number;
	readonly outcome?: string;
	readonly steps: readonly HarnessStep[];
	readonly dropped: number;
	readonly asking?: HarnessAsk;
};

export type HarnessesView = {
	/** What banda can run on this computer, by name: "claude-code" is "Claude Code"; what it is and what it asks. */
	readonly harnesses: readonly {
		readonly name: string;
		readonly service: string;
		readonly about?: string;
		readonly asks?: string;
		/** The owner added it with a command line: they may remove it. */
		readonly custom?: true;
	}[];
	/** What banda can run but this computer has not installed, and how to install it. */
	readonly missing: readonly {
		readonly name: string;
		readonly service: string;
		readonly about?: string;
		readonly install?: string;
	}[];
	/** The folder each is connected in, and the agents it is on for. */
	readonly accounts: { readonly [harness: string]: { readonly folder: string; readonly agents: readonly string[] } };
	/** The code folder to suggest when connecting: the first of ~/code, ~/Developer, ~/src, ~/projects there is, else ~. */
	readonly suggested: string;
	/** Every session kept, newest first. */
	readonly sessions: readonly HarnessSessionView[];
};

export type HarnessesShellEvent = { readonly type: "harnesses"; readonly harnesses: HarnessesView };
