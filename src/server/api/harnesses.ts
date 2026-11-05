/**
 * The API's shapes for harnesses (DESIGN.md "Connections"): what banda can hand coding work to, the folder each is
 * connected in and for whom, and every session, live. Re-exported by `../api.ts`.
 */
import type { HarnessAsk, HarnessState, HarnessStep } from "../../core/harness.ts";

export type { HarnessAsk, HarnessState, HarnessStep } from "../../core/harness.ts";

export type HarnessSessionView = {
	readonly task: number;
	readonly chat: number;
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
	/** What banda can run, by name: "claude-code" is "Claude Code". */
	readonly harnesses: readonly { readonly name: string; readonly service: string }[];
	/** The folder each is connected in, and the agents it is on for. */
	readonly accounts: { readonly [harness: string]: { readonly folder: string; readonly agents: readonly string[] } };
	/** Every session kept, newest first. */
	readonly sessions: readonly HarnessSessionView[];
};

export type HarnessesShellEvent = { readonly type: "harnesses"; readonly harnesses: HarnessesView };
