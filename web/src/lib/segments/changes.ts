/**
 * Changes to "before" files in the chat's feed: a `write`, `edit` or `bash` call the daemon marked as touching a file
 * that takes effect only once the owner accepts it (its note `awaits-acceptance`, naming the file as the daemon resolved
 * it; a command is told of each file it changed) is one line per file where the chat last changed that file: an agent, a routine. How it stands
 * is read from what the daemon reports for that file now: waiting ("Allow this change?", its card inline), allowed, not
 * allowed, or removed since. Never the call's arguments; a write to any other file draws nothing.
 */
import type { AgentView, Item, RoutineView } from "../../../../src/server/api.ts";
import type { Segment } from "../chat.ts";
import type { FeedState } from "../feed.ts";
import type { Segmenter } from "./types.ts";

export type ChangeFolder = "agents" | "routines";

/** What the line's file is, as the daemon reports it now; one field, by folder. */
export type ChangeSubject = {
	readonly agent?: AgentView | undefined;
	readonly routine?: RoutineView | undefined;
};

export type ChangeSegment = {
	readonly kind: "change";
	readonly key: string;
	readonly state: FeedState;
	readonly folder: ChangeFolder;
	/** The file's name, without its folder or `.md`. */
	readonly name: string;
	readonly subject?: ChangeSubject;
	readonly at?: number;
};

declare module "./types.ts" {
	interface AreaSegments {
		change: ChangeSegment;
	}
	interface ViewContext {
		/** The agents, each with the change its file in the box holds, as the daemon last said. */
		readonly agents?: readonly AgentView[];
		/** The "before" files the owner took out of effect after accepting them, by path: when. */
		readonly removed?: { readonly [path: string]: number };
	}
}

const FOLDERS: readonly ChangeFolder[] = ["agents", "routines"];
const NOTED = /^(agents|routines)\/([a-z0-9][a-z0-9-]*)\.md takes effect only once/;

/** The path of a line's file in the workspace. */
const pathOf = (folder: ChangeFolder, name: string) => `${folder}/${name}.md`;

/**
 * The "before" files a call's result says it changed, from the daemon's own notes. A write or edit that failed wrote
 * nothing; a command that failed may still have changed files, and the daemon told of each it found changed.
 */
export function changedFiles(result: Extract<Item, { role: "tool" }> | undefined) {
	if (result === undefined || (result.error && result.name !== "bash")) return [];
	return (result.notes ?? []).flatMap((note) => {
		if (note.code !== "awaits-acceptance") return [];

		const found = NOTED.exec(note.text);
		return found !== null && FOLDERS.includes(found[1] as ChangeFolder)
			? [{ folder: found[1] as ChangeFolder, name: found[2] as string }]
			: [];
	});
}

type Known = {
	readonly change?: unknown;
	readonly accepted?: unknown;
};

/** The file's subject in what the daemon reports, by folder; undefined while that part is not known yet. */
function subjectOf(segment: ChangeSegment, context: Parameters<NonNullable<Segmenter["after"]>>[1]["context"]) {
	const { folder, name } = segment;
	if (folder === "agents")
		return context.agents === undefined ? undefined : { agent: context.agents.find((each) => each.name === name) };
	return context.routines === undefined ? undefined : { routine: context.routines.find((each) => each.name === name) };
}

/** How the file stands: waiting for the owner, in effect, never in effect, or taken out of effect after the call. */
export function changeState(
	subject: ChangeSubject,
	path: string,
	removed: { readonly [path: string]: number } | undefined,
	since = 0,
): FeedState {
	const known: Known | undefined = subject.agent ?? subject.routine;
	if (known?.change !== undefined) return "pending";
	if (known?.accepted !== undefined) return "done";
	const gone = removed?.[path];
	return gone !== undefined && gone >= since ? "removed" : "declined";
}

/** What the file is, in a few words: "the agent Mara", "the routine Morning briefing". */
export function changeNoun(segment: Pick<ChangeSegment, "folder" | "name" | "subject">): string {
	const { subject, name } = segment;
	switch (segment.folder) {
		case "agents": {
			const change = subject?.agent?.change;
			const shown =
				subject?.agent?.accepted?.agent?.name ??
				(change !== undefined && "agent" in change ? change.agent?.name : undefined);
			return `the agent ${shown ?? name}`;
		}

		case "routines": {
			const change = subject?.routine?.change;
			const shown =
				subject?.routine?.accepted?.routine?.description ??
				(change !== undefined && "routine" in change ? change.routine?.description : undefined);
			return `the routine ${shown ?? name}`;
		}
	}
}

/** The line's words, by state. */
export function changeWords(segment: Pick<ChangeSegment, "state" | "folder" | "name" | "subject">): string {
	const noun = changeNoun(segment);
	switch (segment.state) {
		case "pending":
			return `Allow this change? ${noun[0]?.toUpperCase()}${noun.slice(1)}`;
		case "done":
			return `Allowed: ${noun}`;
		case "removed":
			return `Removed since: ${noun}`;
		case "declined":
			return `Not allowed: ${noun}`;
		case "stopped":
			return `Didn't finish changing ${noun}`;
		default:
			return `Changing ${noun}…`;
	}
}

const TOOLS = new Set(["write", "edit", "bash"]);

export const changes: Segmenter = {
	call: (call, key, at) => {
		if (!TOOLS.has(call.name)) return undefined;
		const files = changedFiles(at.result);
		if (files.length === 0) return undefined;
		const lines = files.map(
			(file, i): ChangeSegment => ({
				kind: "change",
				key: i === 0 ? key : `${key}:file:${i}`,
				state: "working",
				...file,
				...(at.result?.at === undefined ? {} : { at: at.result.at }),
			}),
		);
		return [...lines, ...at.asks()];
	},
	after: (segments, input) => {
		const { context } = input;
		// one line per file: where the chat last changed it
		const last = new Map<string, number>();
		segments.forEach((segment, i) => {
			if (segment.kind === "change") last.set(`${segment.folder}/${segment.name}`, i);
		});
		return segments.flatMap((segment, i): Segment[] => {
			if (segment.kind !== "change") return [segment];

			const path = `${segment.folder}/${segment.name}`;
			if (last.get(path) !== i) return [];
			const subject = subjectOf(segment, context);
			if (subject === undefined) return [segment];
			const state = changeState(subject, pathOf(segment.folder, segment.name), context.removed, segment.at);
			return [{ ...segment, subject, state }];
		});
	},
	shown: (segment) => (segment.kind === "change" ? [changeWords(segment)] : undefined),
};
