/**
 * A routine's history (`GET /api/routines/:name/runs`): the runs its durable record keeps, newest first, a page at a
 * time, each with how it stands now (its Turn read when it has not ended) and what it left in its chat, read there as
 * the feed reads it, so a run that spoke says its first line and opens its line, and a quiet one opens nothing.
 */
import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId, Harness, TaskId } from "@earendil-works/pi-durable";
import { Accepted } from "../core/agents.ts";
import { ROUTINE_NAME, type RoutineRunRecord, Routines, RUNS_KEPT, routinePath } from "../core/routines.ts";
import { context } from "../core/store.ts";
import { isOwnerMessage, messageArgs } from "../core/toolsets.ts";
import type { Item, RoutineRunsPage, RoutineRunView } from "./api.ts";
import { BadRequest } from "./http.ts";
import { itemOf } from "./transcript.ts";

/** How many runs a page of a routine's history holds: ten in view, and "Show earlier" for the next ten. */
export const RUNS_PAGE = 10;
/** How far a run's history reads into its chat past its wake, at most, looking for what it said. */
const RUN_SCAN = 400;

/** A said line as the history shows it: its first line, short. */
const firstLine = (text: string) => {
	const line = text.trim().split("\n")[0]?.trim() ?? "";
	return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

/**
 * What a run left in its chat, from the items after its wake up to the next run (the owner's words, another wake, a
 * watch's): the first thing it said to the owner (a speaking call that went through, read as the feed reads it), and
 * whether the chat draws its line at all: it said something, or it failed or stopped there.
 */
export function runSaid(items: readonly Item[], name: string): { said?: string; shown: boolean } {
	const delivered = new Set(items.flatMap((item) => (item.role === "tool" && !item.error ? [item.call] : [])));
	let said: string | undefined;
	for (const item of items) {
		if (item.role !== "assistant" || said !== undefined) continue;
		for (const call of item.calls ?? []) {
			if (!isOwnerMessage(call.name) || !delivered.has(call.id)) continue;
			const args = messageArgs(call.name, call.args);
			const text = typeof args.text === "string" && args.text.trim() !== "" ? firstLine(args.text) : undefined;
			const reaction = typeof args.reaction === "string" ? args.reaction : undefined;
			said = text ?? reaction ?? "a message";
			break;
		}
	}
	const trouble = items.some(
		(item) =>
			(item.role === "assistant" && item.error !== undefined) ||
			(item.role === "notice" && item.routine?.routine === name),
	);
	return { ...(said === undefined ? {} : { said }), shown: said !== undefined || trouble };
}

/** The items of chat `chat` from entry `entry`'s next up to the next run there, at most `RUN_SCAN` entries. */
async function runItems(harness: Harness, chat: number, entry: number, ctx: Context): Promise<Item[]> {
	const conversation = await harness.conversation(chat as ConversationId, ctx);
	if (conversation === undefined) return [];
	const page = await conversation.entries(
		{ order: "ascending", minEntryId: (entry + 1) as EntryId },
		RUN_SCAN,
		undefined,
		ctx,
	);
	const found: Item[] = [];
	for (const record of page.items) {
		const item = itemOf(record);
		if (item === undefined) continue;
		if (item.role === "user" || item.role === "wake" || (item.role === "watch" && item.tell === undefined)) break;
		found.push(item);
	}
	return found;
}

/** One run of a routine as its history says it, its Turn and chat read now. */
async function runView(harness: Harness, name: string, run: RoutineRunRecord, ctx: Context): Promise<RoutineRunView> {
	const base = { at: run.at, ...(run.owner === true ? { owner: true as const } : {}) };
	if (run.skipped !== undefined) return { ...base, state: "skipped", skipped: run.skipped };
	if (run.ended === undefined) {
		const turn = run.turn === undefined ? undefined : await harness.getTask(run.turn as TaskId, ctx);
		// a run whose Turn is gone, or ended with no word of how (stopped before it began), is said as stopped
		if (turn === undefined || turn.state.status === "terminal") return { ...base, state: "stopped" };
		// it waits on its admission: queued behind the chat's other inputs
		return { ...base, state: turn.state.status === "waiting" ? "waiting" : "running" };
	}
	// a run apart from its chat is read in its own conversation, and its line is the one it drew in the chat
	const where = run.run ?? run.chat;
	const left =
		where === undefined || run.entry === undefined
			? { shown: false }
			: runSaid(await runItems(harness, where, run.entry, ctx), name);
	const drawn = run.run === undefined ? run.entry : run.line;
	const line =
		left.shown && run.chat !== undefined && drawn !== undefined ? { line: { chat: run.chat, entry: drawn } } : {};
	if (run.result === "failed")
		return { ...base, state: "failed", ...(run.why === undefined ? {} : { why: run.why }), ...line };
	if (run.result === "stopped") return { ...base, state: "stopped", ...line };
	return left.said === undefined ? { ...base, state: "quiet" } : { ...base, state: "said", said: left.said, ...line };
}

/**
 * Routine `name`'s history, newest first, a page at a time: the runs before `before` (when it ran), from its durable
 * record. Undefined when there is no such routine.
 */
export async function routineRuns(
	harness: Harness,
	name: string,
	before: number | undefined,
	ctx: Context = context,
): Promise<RoutineRunsPage | undefined> {
	const records = (await harness.snapshot(Routines, ctx))?.routines ?? {};
	const accepted = (await harness.snapshot(Accepted, ctx))?.files ?? {};
	if (!ROUTINE_NAME.test(name)) throw new BadRequest(`"${name}" is not a routine's name`);
	const record = records[name];
	if (record === undefined && accepted[routinePath(name)] === undefined) return undefined;
	const older = (record?.runs ?? []).filter((run) => before === undefined || run.at < before).reverse();
	const page = older.slice(0, RUNS_PAGE);
	const runs = await Promise.all(page.map((run) => runView(harness, name, run, ctx)));
	const oldest = page.at(-1);
	return {
		runs,
		...(older.length > RUNS_PAGE && oldest !== undefined ? { earlier: oldest.at } : {}),
		// the record keeps the newest runs only: older ones are in the chat alone
		...((record?.runs?.length ?? 0) >= RUNS_KEPT ? { full: true as const } : {}),
	};
}
