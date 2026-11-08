/**
 * The chat's feed (docs/experience.md): one calm, centered line for each consequential change the companion makes
 * besides its messages (a fact remembered, an agent, a routine, a change to a "before" file, a hand-off, a
 * document in the Library, an approval). Each area's segmenter (`segments/<area>.ts`) makes its own lines; this file
 * holds what they share. A line's state is how its subject stands now, read from what the store and the workspace hold
 * (memory, the agents, the routines, the connections, the chats, the Library), never from the model's
 * arguments or words: a change that failed, was declined or never committed never reads as done. Pure, like `chat.ts`.
 */
import type { Item, ToolCall } from "../../../src/server/api.ts";
import type { Segment } from "./chat.ts";

/**
 * How a line's change stands:
 * - `working`: its call has not answered yet;
 * - `stopped`: its call never answered, and its run is over (stopped, or lost in a crash it did not resume from);
 * - `refused`: the daemon refused it: nothing was written;
 * - `pending`: written, and waiting for the owner, who answers on the line;
 * - `done`: in effect;
 * - `declined`: the owner said no, or it never took effect;
 * - `removed`: it was in effect, and is no more (forgotten, removed, ended).
 */
export type FeedState = "working" | "stopped" | "refused" | "pending" | "done" | "declined" | "removed";

type ToolResult = Extract<Item, { role: "tool" }>;

/** A call's state before its subject is looked up: working until it answers, refused when the daemon said no. */
export const callState = (result: ToolResult | undefined): "working" | "refused" | undefined =>
	result === undefined ? "working" : result.error ? "refused" : undefined;

/**
 * A line still working once its run is over never will: its call was stopped or lost. Its run is over when the chat
 * no longer runs, or when the owner spoke since (the run that answers them is another). `key` is the line's,
 * `<item>:<call>`, as the chat keys a call's segments.
 */
export function settled(
	key: string,
	state: FeedState,
	{ items, live }: { readonly items: readonly Item[]; readonly live: { readonly busy: boolean } },
): FeedState {
	if (state !== "working") return state;
	if (!live.busy) return "stopped";
	const at = Number(key.split(":")[0]);
	return items.some((item) => item.role === "user" && item.id > at) ? "stopped" : state;
}

/**
 * An approval (a send, a step, anything the daemon holds for the owner) as a feed line: waiting for them while it is
 * open, with its card inline; then how its wait ended, as the store recorded it, with the card behind a disclosure.
 */
export function approvalLine(segment: {
	readonly label: string;
	readonly open?: unknown;
	readonly ended?: { readonly outcome: string; readonly answer?: unknown; readonly said: string };
}): { state: FeedState; text: string } {
	const { label, ended } = segment;
	if (ended === undefined)
		return segment.open === undefined
			? { state: "working", text: `Asking you: ${label}` }
			: { state: "pending", text: `Needs you: ${label}` };
	const yes = ended.outcome === "answered" && ended.answer === "approve";
	return { state: yes ? "done" : "declined", text: `${ended.said} · ${label}` };
}

/** The longest reason a refused line gives. */
const MAX_WHY = 160;

/**
 * Why the daemon refused a call, in plain words, from the refusal its result holds: its own words, without the "Not
 * written:" it opens with, the code marks and the closing stop. A call turned away before it ran (its arguments did
 * not fit the tool) says only that, never the arguments the harness quotes back.
 */
export function refusalWhy(result: Pick<ToolResult, "text"> | undefined): string {
	const text = result?.text ?? "";
	if (text.startsWith("Validation failed for tool")) return "it was not asked in a form that works";
	const line = (text.split("\n").find((each) => each.trim() !== "") ?? "")
		.trim()
		.replace(/^(?:Not (?:proposed|written|sent|kept|done)|Refused)\s*[:.]\s*/i, "")
		.replace(/`/g, "")
		.replace(/\.$/, "");
	if (line === "") return "it was refused";
	// "There is no…" reads on after a colon in lower case; a name ("Only the lead…" aside) keeps its capital
	const plain = /^[A-Z][a-z]+\s+[a-z]/.test(line) ? `${line[0]?.toLowerCase()}${line.slice(1)}` : line;
	return plain.length > MAX_WHY ? `${plain.slice(0, MAX_WHY - 1).trimEnd()}…` : plain;
}

/** Whether `item` starts a run: the owner's message, a routine's wake, or a watch's (not what it only tells). */
export const startsRun = (item: Item): item is Extract<Item, { role: "user" | "wake" | "watch" }> =>
	item.role === "user" || item.role === "wake" || (item.role === "watch" && item.tell === undefined);

/** The id of the item that started the run item `id` is in: the owner's message, or a wake; 0 before any. */
export function runOf(items: readonly Item[], id: number): number {
	let run = 0;
	for (const item of items) {
		if (item.id > id) break;
		if (startsRun(item)) run = item.id;
	}
	return run;
}

/**
 * The lines of refused calls a later call did instead: a refused call of a tool, followed in the same run by a call of
 * the same tool the daemon took (its result no refusal, or an ask it opened) and that drew a line of its own, from the
 * record it committed; for the same `name` when both give one. The line of what was done stays, and so does a refusal
 * nothing followed. `refused` says which lines are refusals.
 */
export function withoutRetried(
	segments: readonly Segment[],
	items: readonly Item[],
	refused: (segment: Segment) => boolean,
): Segment[] {
	const calls = new Map<string, { readonly item: number; readonly call: ToolCall }>();
	const results = new Map<string, ToolResult>();
	for (const item of items) {
		if (item.role === "assistant") for (const call of item.calls ?? []) calls.set(call.id, { item: item.id, call });
		if (item.role === "tool") results.set(item.call, item);
	}
	const callOf = (key: string) => {
		const [item, id] = key.split(":");
		const found = id === undefined ? undefined : calls.get(id);
		return found !== undefined && String(found.item) === item ? found : undefined;
	};
	const named = (call: ToolCall) =>
		typeof call.args.name === "string" ? call.args.name.trim().toLowerCase().replace(/\s+/g, "-") : undefined;
	const taken = segments.flatMap((segment) => {
		const found = refused(segment) ? undefined : callOf(segment.key);
		if (found === undefined) return [];
		const result = results.get(found.call.id);
		const took = result === undefined ? segment.kind === "approval" || segment.kind === "question" : !result.error;
		return took ? [found] : [];
	});
	return segments.filter((segment) => {
		if (!refused(segment)) return true;
		const mine = callOf(segment.key);
		if (mine === undefined) return true;
		const run = runOf(items, mine.item);
		const name = named(mine.call);
		return !taken.some(
			(other) =>
				other.item > mine.item &&
				other.call.name === mine.call.name &&
				runOf(items, other.item) === run &&
				(name === undefined || named(other.call) === undefined || named(other.call) === name),
		);
	});
}

/** When a line's change happened, as the feed shows it: the time of day. */
export const feedTime = (at: number) =>
	new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
