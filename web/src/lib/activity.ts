/** Activity is a view of recorded model boundaries, not a second log or a retrospective summary. */
import type { Item, ToolCall } from "./api.ts";
import { startsRun as starts } from "./feed.ts";

export type ActivityWork = { id: number; items: Item[]; title: string; active?: boolean };
export type ActivityAnchor = number;

export function activityWork(items: readonly Item[], activeInput?: number): ActivityWork[] {
	const works: ActivityWork[] = [];
	const calls = new Map<string, ActivityWork>();
	let current: ActivityWork | undefined;
	let continuing = false;
	let pending: Item[] = [];
	let loads: Item[] = [];
	const make = (first: Item) => {
		const work: ActivityWork = { id: first.id, items: [], title: "Activity" };
		works.push(work);
		return work;
	};
	const add = (work: ActivityWork, item: Item) => {
		work.items.push(item);
		if (starts(item) && work.title === "Activity") work.title = item.text;
	};
	for (const item of items) {
		// The daemon admitted this complete tool round before the owner's input; it belongs to that input's work,
		// not to whichever run happened to precede it in the transcript.
		if (item.role === "tool" && item.receipt?.kind === "skill" && item.receipt.by === "owner") {
			loads.push(item);
			continue;
		}
		if (starts(item)) {
			const ready = loads.filter(
				(load) =>
					load.role === "tool" &&
					load.receipt?.kind === "skill" &&
					(load.receipt.invocation === undefined ||
						(item.role === "user" &&
							item.origin?.gateway === load.receipt.invocation.gateway &&
							item.message === load.receipt.invocation.message)),
			);
			pending.push(...ready, item);
			loads = loads.filter((load) => !ready.includes(load));
			continue;
		}
		if (item.role === "assistant") {
			// A tool round is not a completed run. Inputs placed before its next model request steer that work.
			if (pending.length && (!continuing || pending.some((input) => input.id === activeInput))) current = undefined;
			current ??= make(pending[0] ?? item);
			for (const input of pending) add(current, input);
			pending = [];
			add(current, item);
			continuing = item.stop === "toolUse" && (item.calls?.length ?? 0) > 0;
			for (const call of item.calls ?? []) calls.set(call.id, current);
		} else if (item.role === "tool") {
			// A result after a steered input still belongs to the call that issued it.
			const work = calls.get(item.call) ?? current;
			if (work) add(work, item);
			if (work === current && item.notes?.some((note) => note.code === "aborted")) continuing = false;
		} else if (pending.length && (!current || !continuing)) pending.push(item);
		else if (current) add(current, item);
	}
	const first = pending[0];
	if (first) {
		const active =
			activeInput === undefined
				? undefined
				: (works.find((work) => work.items.some((item) => item.id === activeInput)) ??
					((items[0]?.id ?? 0) > activeInput ? works.at(-1) : undefined));
		const startsRun = pending.some((input) => input.id === activeInput);
		const work = active ?? (continuing && !startsRun ? current : undefined) ?? make(first);
		for (const input of pending) add(work, input);
	}
	for (const work of works) work.items.sort((a, b) => a.id - b.id);
	if (activeInput !== undefined) {
		const active =
			works.find((work) => work.items.some((item) => item.id === activeInput)) ??
			((items[0]?.id ?? 0) > activeInput ? works.at(-1) : undefined);
		if (active) active.active = true;
	}
	return works;
}

export function findActivity(
	works: readonly ActivityWork[],
	anchor: ActivityAnchor | undefined,
): ActivityWork | undefined {
	if (anchor === undefined) return works.at(-1);
	return works.find((work) => work.items.some((item) => item.id === anchor));
}

export function activityEnd(work: ActivityWork): "Finished" | "Stopped" | "Failed" | "Cut off" | "No recorded answer" {
	const last = [...work.items].reverse().find((item) => item.role === "assistant");
	if (!last) return "No recorded answer";
	if (
		last.stop === "aborted" ||
		(last.stop === "toolUse" &&
			work.items.some((item) => item.role === "tool" && item.notes?.some((note) => note.code === "aborted")))
	)
		return "Stopped";
	if (last.stop === "error" || last.error) return "Failed";
	if (last.stop === "length") return "Cut off";
	return "Finished";
}

type ActivityCall = { entry: number; call: ToolCall; at?: number; result?: Extract<Item, { role: "tool" }> };

/** Providers can reuse ids in later requests. Results follow their issuing round, not a chat-wide id map. */
export function activityCalls(work: ActivityWork): ActivityCall[] {
	const calls: ActivityCall[] = [];
	const pending = new Map<string, ActivityCall[]>();
	for (const item of work.items) {
		if (item.role === "assistant")
			for (const call of item.calls ?? []) {
				const occurrence: ActivityCall = { entry: item.id, call, ...(item.at === undefined ? {} : { at: item.at }) };
				calls.push(occurrence);
				const queue = pending.get(call.id) ?? [];
				queue.push(occurrence);
				pending.set(call.id, queue);
			}
		else if (item.role === "tool") {
			const occurrence = pending.get(item.call)?.shift();
			if (occurrence) occurrence.result = item;
		}
	}
	return calls;
}
